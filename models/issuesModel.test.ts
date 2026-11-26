import { describe, expect, it } from 'vitest';
import { autoResolveTargets, collectFailureGroups } from './issuesModel';

// 자동 해제는 "이번 실행에서 실제로 성공적으로 돈 태스크"의 티켓만 대상으로 한다.
// 이전에는 DB의 열린 티켓 전부가 대상이라, 용량 예측(예약 점검에만 붙는 태스크) 티켓이 수동 점검 때 풀리고,
// 실패한 태스크(쿼리 오류·타임아웃)의 티켓도 "더 이상 감지되지 않음"으로 풀렸다.
describe('autoResolveTargets', () => {
  const existing = new Map([
    ['1:USED', { id: 11, status: 'OPEN' }],
    ['2:STATUS', { id: 12, status: 'ACKNOWLEDGED' }],
    ['-100:TS:USERS', { id: 13, status: 'OPEN' }],
    ['3:X', { id: 14, status: 'RESOLVED' }],
  ]);

  it('성공한 태스크의 사라진 위반만 해제', () => {
    const results = [
      { task_id: 1, success: true, rows: [] },
      { task_id: 2, success: false, rows: [] },
    ];
    expect(autoResolveTargets(existing, new Set(), results)).toEqual([11]);
  });

  it('여전히 감지되는 것은 해제하지 않음', () => {
    expect(autoResolveTargets(existing, new Set(['1:USED']), [{ task_id: 1, success: true }])).toEqual([]);
  });

  it('용량 예측 태스크가 있는 실행에서만 그 티켓을 해제', () => {
    expect(autoResolveTargets(existing, new Set(), [{ task_id: -100, success: true }])).toEqual([13]);
  });
});

// 스크립트 실행 자체가 실패한 것도 티켓으로 남겨, 이슈 카드에서 "어떤 스크립트가 왜 실패했는지" 보이게 한다.
describe('collectFailureGroups', () => {
  it('SQL 오류·시간 초과는 태스크마다 실행 실패 티켓 한 장 (에러 코드가 대표 값)', () => {
    const groups = collectFailureGroups([
      { task_id: 1, task_name: 'OK', success: true, rows: [] },
      { task_id: 2, task_name: '테이블스페이스', success: false, error: 'ORA-00942: table or view does not exist\nHelp: ...', failureKind: 'ERROR' },
      { task_id: 3, task_name: 'RMAN', success: false, error: '실행 시간 초과 (61초)', failureKind: 'TIMEOUT' },
    ]);
    expect([...groups.keys()]).toEqual(['2:__EXEC_ERROR__', '3:__EXEC_ERROR__']);
    const ora = groups.get('2:__EXEC_ERROR__')!;
    expect(ora).toMatchObject({ taskId: 2, taskName: '테이블스페이스', level: 'ERROR', value: 'ORA-00942', message: 'SQL 실행 오류: ORA-00942: table or view does not exist' });
    expect(ora.rows[0].ERROR).toContain('Help: ...');
    expect(groups.get('3:__EXEC_ERROR__')).toMatchObject({ value: '실행 시간 초과', message: '실행 시간 초과: 실행 시간 초과 (61초)' });
  });

  it('접속 실패로 못 돈 태스크들은 DB당 접속 실패 티켓 한 장(CRITICAL)으로 모은다', () => {
    const groups = collectFailureGroups([
      { task_id: 4, task_name: 'A', success: false, error: '대상 DB 접속 실패: ORA-12541: TNS:no listener', failureKind: 'CONNECT' },
      { task_id: 5, task_name: 'B', success: false, error: '대상 DB 접속 실패: ORA-12541: TNS:no listener', failureKind: 'CONNECT' },
    ]);
    expect([...groups.keys()]).toEqual(['0:__CONNECT__']);
    expect(groups.get('0:__CONNECT__')).toMatchObject({ taskId: 0, level: 'CRITICAL', value: 'ORA-12541', message: '대상 DB 접속 실패: ORA-12541: TNS:no listener' });
    expect(groups.get('0:__CONNECT__')!.rows.map((row) => row.TASK_NAME)).toEqual(['A', 'B']);
  });

  it('긴 에러 메시지는 VARCHAR2(255 BYTE)에 맞게 바이트 기준으로 자른다', () => {
    const groups = collectFailureGroups([{ task_id: 6, task_name: 'X', success: false, error: '가'.repeat(200), failureKind: 'ERROR' }]);
    expect(new TextEncoder().encode(groups.get('6:__EXEC_ERROR__')!.message).length).toBeLessThanOrEqual(250);
  });
});

describe('autoResolveTargets — 실패 티켓', () => {
  const existing = new Map([
    ['2:__EXEC_ERROR__', { id: 21, status: 'OPEN' }],
    ['0:__CONNECT__', { id: 22, status: 'OPEN' }],
  ]);

  it('스크립트가 다시 성공하고 접속도 되면 둘 다 해제', () => {
    expect(autoResolveTargets(existing, new Set(), [{ task_id: 2, success: true }])).toEqual([21, 22]);
  });

  it('접속 실패만 있는 실행에서는 아무것도 해제하지 않음', () => {
    expect(autoResolveTargets(existing, new Set(['0:__CONNECT__']), [{ task_id: 0, success: false, failureKind: 'CONNECT' }])).toEqual([]);
  });

  it('스크립트가 계속 실패하면(다른 원인) 실행 실패 티켓은 유지, 접속 실패 티켓은 해제', () => {
    expect(autoResolveTargets(existing, new Set(['2:__EXEC_ERROR__']), [{ task_id: 2, success: false, failureKind: 'ERROR' }])).toEqual([22]);
  });
});
