import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseMasterRows, runnerOf } from './dataPumpMaster';
import type { MasterRow } from './dataPumpMaster';

// 도커 23ai에서 expdp를 직접 돌리는 중에 앱 model(getMasterRows/getJobSessions)로 읽은 실제 결과
const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', 'datapump', `${name}.json`), 'utf-8'));

describe('parseMasterRows', () => {
  it('스키마 모드: 로그 위치, 덤프 파일, 대상, 시작 시각', () => {
    const info = parseMasterRows(fixture('master_schema').rows as MasterRow[]);
    expect(info).toMatchObject({
      operation: 'EXPORT',
      jobMode: 'SCHEMA',
      userName: 'SYSTEM',
      startedAt: '2026-10-22 02:42:48',
      logDirectory: 'DATA_PUMP_DIR',
      logFile: 'ext_schema.log',
      dumpDirectory: 'DATA_PUMP_DIR',
      dumpFiles: ['ext_schema_01.dmp'],
      target: '[외부 실행] SCHEMAS=QUP,QTEST',
      expected: null,
    });
    expect(info.clientCommand).toContain('parfile=ext_schema.par');
  });

  it('NOLOGFILE: 로그 없음, TABLES= 목록은 CUSTOM_FILTER에서 (대조 대상으로)', () => {
    const info = parseMasterRows(fixture('master_nolog').rows as MasterRow[]);
    expect(info.logFile).toBeNull();
    expect(info.jobMode).toBe('TABLE');
    expect(info.expected).toEqual(['QUP.BIG', 'QUP.Mixed']);
    expect(info.target).toBe('[외부 실행] 테이블 2개: QUP.BIG, QUP.Mixed');
  });
});

describe('runnerOf', () => {
  it('expdp 클라이언트 세션(DBMS_DATAPUMP)을 실행자로', () => {
    expect(runnerOf(fixture('master_schema').sessions)).toEqual({ username: 'SYSTEM', osuser: 'oracle', machine: '8c7d47ec79be', program: 'ude@8c7d47ec79be (TNS V1-V3)' });
  });

  it('클라이언트가 떨어져 나간 작업은 마스터 세션', () => {
    const sessions = fixture('master_schema').sessions.filter((s: { sessionType: string }) => s.sessionType !== 'DBMS_DATAPUMP');
    expect(runnerOf(sessions)?.program).toContain('(DM00)');
    expect(runnerOf([])).toBeNull();
  });
});

describe('parseMasterRows — impdp (마스터에 덤프를 만든 export의 메타 행도 같이 들어 있음)', () => {
  it('작업 행(-1)이 이 작업이 아니면 import: 로그는 import 것, 대상은 덤프, REMAP_SCHEMA', () => {
    const info = parseMasterRows(fixture('master_import').rows as MasterRow[], 'E2E_IMP4');
    expect(info.operation).toBe('IMPORT');
    expect(info.logFile).toBe('e2e_imp4.log'); // export의 e2e_exp.log가 아니라
    expect(info.dumpFiles).toEqual(['e2e_exp_01.dmp']);
    expect(info.remap).toEqual([{ from: 'QUP', to: 'QUP3' }]);
    expect(info.target).toContain('e2e_exp_01.dmp');
    expect(info.target).toContain('REMAP_SCHEMA QUP→QUP3');
  });

  it('export는 jobName을 줘도 그대로', () => {
    expect(parseMasterRows(fixture('master_schema').rows as MasterRow[], 'EXT_SCHEMA').operation).toBe('EXPORT');
  });
});
