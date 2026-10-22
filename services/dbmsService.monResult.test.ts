import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../models/dbmsModel', () => ({
  getDbmsInfo: vi.fn(),
  listTasks: vi.fn(),
  getActiveThresholds: vi.fn(),
  connectToTarget: vi.fn(),
  executeQuery: vi.fn(),
}));
vi.mock('../models/historyModel', () => ({ saveRunHistory: vi.fn().mockResolvedValue(1) }));
vi.mock('../models/issuesModel', () => ({ syncIssues: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import * as dbmsModel from '../models/dbmsModel';
import { getMonResult } from './dbmsService';

const DBCONFIG = ['scott', 'pw', '10.0.0.1', '1521', 'ORCL', '', 'TESTDB'];
const TASKS = { rows: [[1, 'A', 'select 1 from dual'], [2, 'SLOW', 'select slow from dual'], [3, 'C', 'select 3 from dual']] };

// Thick 모드에서 callTimeout에 걸리면 실제로 이 에러가 온다 (설정값의 약 2배 뒤)
const BROKEN = Object.assign(new Error('NJS-500: connection to the Oracle Database was broken'), { code: 'NJS-500' });

let clock = 0;

function fakeConnection() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

// "slow" 태스크는 elapsedMs만큼 시간을 보낸 뒤 error로 실패한다
function slowTaskFails(error: Error, elapsedMs: number) {
  vi.mocked(dbmsModel.executeQuery).mockImplementation(async (_conn, sql) => {
    if (sql.includes('slow')) {
      clock += elapsedMs;
      throw error;
    }
    return { columns: ['X'], rows: [{ X: 1 }] };
  });
}

describe('getMonResult — 쿼리 타임아웃/연결 끊김 처리', () => {
  beforeEach(() => {
    clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.mocked(dbmsModel.getDbmsInfo).mockResolvedValue(DBCONFIG);
    vi.mocked(dbmsModel.listTasks).mockResolvedValue(TASKS as any);
    vi.mocked(dbmsModel.getActiveThresholds).mockResolvedValue([]);
    vi.mocked(dbmsModel.executeQuery).mockReset();
    vi.mocked(dbmsModel.connectToTarget).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('callTimeout 이상 지나 끊기면 시간 초과로 표시하고, 재접속해서 나머지 태스크를 계속 돌린다', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    vi.mocked(dbmsModel.connectToTarget).mockResolvedValueOnce(first as any).mockResolvedValueOnce(second as any);
    slowTaskFails(BROKEN, 61_000);

    const results = await getMonResult({ dbmsid: 1 });

    expect(results.map((r) => [r.task_id, r.success])).toEqual([[1, true], [2, false], [3, true]]);
    expect(results[1].error).toBe('실행 시간 초과 (61초)');
    expect(first.close).toHaveBeenCalled();
    expect(dbmsModel.connectToTarget).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dbmsModel.executeQuery).mock.calls[2][0]).toBe(second);
    expect(second.close).toHaveBeenCalled();
  });

  it('callTimeout 전에 끊기면 연결 끊김으로 표시하고, 역시 재접속해서 계속한다', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    vi.mocked(dbmsModel.connectToTarget).mockResolvedValueOnce(first as any).mockResolvedValueOnce(second as any);
    slowTaskFails(BROKEN, 1_200);

    const results = await getMonResult({ dbmsid: 1 });

    expect(results.map((r) => [r.task_id, r.success])).toEqual([[1, true], [2, false], [3, true]]);
    expect(results[1].error).toBe('대상 DB 연결 끊김 (NJS-500: connection to the Oracle Database was broken)');
    expect(dbmsModel.connectToTarget).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dbmsModel.executeQuery).mock.calls[2][0]).toBe(second);
  });

  it('재접속까지 실패하면 남은 태스크는 접속 실패로 처리한다 (이전 커넥션 close 실패는 무시)', async () => {
    const first = fakeConnection();
    first.close.mockRejectedValue(Object.assign(new Error('NJS-003: invalid or closed connection'), { code: 'NJS-003' }));
    vi.mocked(dbmsModel.connectToTarget)
      .mockResolvedValueOnce(first as any)
      .mockRejectedValueOnce(new Error('ORA-12170: TNS:Connect timeout occurred'));
    slowTaskFails(BROKEN, 61_000);

    const results = await getMonResult({ dbmsid: 1 });

    expect(results.map((r) => [r.task_id, r.success])).toEqual([[1, true], [2, false], [3, false]]);
    expect(results[2].error).toBe('대상 DB 접속 실패: ORA-12170: TNS:Connect timeout occurred');
    expect(dbmsModel.executeQuery).toHaveBeenCalledTimes(2);
  });

  it('일반 SQL 에러는 재접속하지 않고 같은 커넥션으로 계속한다', async () => {
    const only = fakeConnection();
    vi.mocked(dbmsModel.connectToTarget).mockResolvedValueOnce(only as any);
    slowTaskFails(Object.assign(new Error('ORA-00942: table or view does not exist'), { code: 'ORA-00942' }), 61_000);

    const results = await getMonResult({ dbmsid: 1 });

    expect(results[1]).toMatchObject({ success: false, error: 'ORA-00942: table or view does not exist' });
    expect(results[2].success).toBe(true);
    expect(dbmsModel.connectToTarget).toHaveBeenCalledTimes(1);
    expect(only.close).toHaveBeenCalledTimes(1);
  });
});
