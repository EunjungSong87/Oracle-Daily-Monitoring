import { describe, expect, it } from 'vitest';
import { DataPumpValidationError } from './dataPumpErrors';
import { tableFilterStatus } from './dataPumpFilters';
import { assertAcknowledged, checkPlanFiles, checkPlanStart, registerPlan } from './dataPumpPlanRegistry';
import { assertImportCovers, buildParfile, buildPlan, planExportGroups } from './dataPumpService';
import type { DataPumpRequest, ExportSplitOptions } from './dataPumpService';

const NOW = new Date(2026, 9, 22, 11, 0, 0);
const TARGET = { dbname: 'PRODDB', user: 'SYSTEM', host: 'h', port: '1521', sid: 'ORCL' };
const G = 1024 ** 3;
const options = (overrides: Partial<ExportSplitOptions> = {}): ExportSplitOptions => ({
  directory: 'DATA_PUMP_DIR',
  filePrefix: 'exp_x',
  chunkSize: '1T',
  parallel: 1,
  filesizeMode: 'NONE',
  ...overrides,
});

describe('4. 사용자 필터가 목록 항목을 빼는 경우', () => {
  it('EXCLUDE TABLE 이름 조건으로 빠지는 테이블을 계획 결과에 목록으로 낸다', () => {
    const plan = planExportGroups(
      { kind: 'SCHEMAS', schemas: ['HR'] },
      [
        { owner: 'HR', name: 'EMP', bytes: G },
        { owner: 'HR', name: 'LOG_2024', bytes: G },
        { owner: 'HR', name: 'LOG_2025', bytes: G },
      ],
      options({ objectFilter: { rules: [{ kind: 'EXCLUDE', path: 'TABLE', op: 'LIKE', values: ['LOG%'] }] } }),
      NOW
    );
    expect(plan.filteredOut).toEqual(['HR.LOG_2024', 'HR.LOG_2025']);
    expect(plan.filterUnknown).toBeNull();
  });

  it('INCLUDE에 TABLE이 없으면 모든 테이블이 빠진다', () => {
    expect(tableFilterStatus({ rules: [{ kind: 'INCLUDE', path: 'INDEX', op: 'ALL' }] }, 'HR', 'EMP')).toBe('EXCLUDED');
  });

  it('서브쿼리 조건은 미리 알 수 없다고 경고한다', () => {
    const plan = planExportGroups(
      { kind: 'TABLES', tables: [{ owner: 'HR', name: 'EMP' }] },
      [{ owner: 'HR', name: 'EMP', bytes: G }],
      options({ objectFilter: { rules: [{ kind: 'EXCLUDE', path: 'TABLE', op: 'SUBQUERY', subquery: 'SELECT table_name FROM x' }] } }),
      NOW
    );
    expect(plan.filteredOut).toEqual([]);
    expect(plan.filterUnknown).toMatch(/미리 확인할 수 없/);
  });
});

describe('1. DB에 없는 항목 / 필터 제외 — 확인 없이 진행 불가 (서버)', () => {
  it('빠진 항목이 있으면 같은 목록을 확인해야만 통과', () => {
    const entry = { missing: ['HR.NOPE', 'HR.GONE'], filteredOut: [] as string[] };
    expect(() => assertAcknowledged(entry, undefined)).toThrow(/확인/);
    expect(() => assertAcknowledged(entry, { missing: ['HR.NOPE'], filteredOut: [] })).toThrow(DataPumpValidationError);
    expect(() => assertAcknowledged(entry, { missing: ['HR.NOPE', 'HR.GONE', 'HR.X'], filteredOut: [] })).toThrow(DataPumpValidationError);
    expect(() => assertAcknowledged(entry, { missing: ['HR.GONE', 'HR.NOPE'], filteredOut: [] })).not.toThrow();
  });

  it('필터로 빠지는 테이블도 같은 방식', () => {
    const entry = { missing: [] as string[], filteredOut: ['HR.LOG'] };
    expect(() => assertAcknowledged(entry, { missing: [], filteredOut: [] })).toThrow(/필터/);
    expect(() => assertAcknowledged(entry, { missing: [], filteredOut: ['HR.LOG'] })).not.toThrow();
  });

  it('빠진 게 없으면 확인 없이도 통과', () => {
    expect(() => assertAcknowledged({ missing: [], filteredOut: [] }, undefined)).not.toThrow();
  });

  const request: DataPumpRequest = {
    operation: 'EXPORT',
    mode: 'TABLE',
    tableOwner: 'HR',
    tables: ['EMP'],
    directory: 'DATA_PUMP_DIR',
    dumpfile: 'x_%U.dmp',
    logfile: 'x.log',
    jobName: 'DBC_EXP_20261022110000_01',
  };

  it('start: 계획 없이 / 다른 DB / 바뀐 요청 / 확인 누락이면 거부', () => {
    const planId = registerPlan({
      dbmsid: '1',
      missing: ['HR.NOPE'],
      filteredOut: [],
      jobs: [{ request, expected: ['HR.EMP'] }],
      summaryFile: { name: 'exp_x_plan_summary.txt', text: 'x' },
    });
    const ack = { missing: ['HR.NOPE'], filteredOut: [] };
    expect(() => checkPlanStart(undefined, '1', request, ack)).toThrow(/계획/);
    expect(() => checkPlanStart(planId, '2', request, ack)).toThrow(DataPumpValidationError);
    expect(() => checkPlanStart(planId, '1', { ...request, tables: ['EMP', 'DEPT'] }, ack)).toThrow(/계획과 다릅니다/);
    expect(() => checkPlanStart(planId, '1', request, undefined)).toThrow(/확인/);
    // 화면이 실행 때 정하는 FLASHBACK_SCN만은 달라도 된다
    expect(checkPlanStart(planId, '1', { ...request, flashbackScn: '123' }, ack).expected).toEqual(['HR.EMP']);
  });

  it('saveFiles: 계획의 parfile이면 확인이 있어야 저장', () => {
    const planId = registerPlan({ dbmsid: '1', missing: ['HR.NOPE'], filteredOut: [], jobs: [{ request, expected: ['HR.EMP'] }], summaryFile: null });
    const files = [{ name: 'dbc_exp_20261022110000_01.par', content: 'TABLES=HR.EMP\nJOB_NAME=DBC_EXP_20261022110000_01\n' }];
    expect(() => checkPlanFiles(undefined, '1', files, undefined)).toThrow(/계획/);
    expect(() => checkPlanFiles(planId, '1', files, undefined)).toThrow(/확인/);
    expect(() => checkPlanFiles(planId, '1', [{ name: 'other.par', content: 'JOB_NAME=DBC_EXP_99999999999999_01\n' }], { missing: ['HR.NOPE'], filteredOut: [] })).toThrow(
      /계획에 없는/
    );
    expect(() => checkPlanFiles(planId, '1', files, { missing: ['HR.NOPE'], filteredOut: [] })).not.toThrow();
    // Import parfile/매니페스트는 계획 없이 저장 가능
    expect(() => checkPlanFiles(undefined, '1', [{ name: 'imp.par', content: 'JOB_NAME=DBC_IMP_1\n' }], undefined)).not.toThrow();
  });
});

describe('6. Import 커버리지 — 고른 대상이 parfile에 빠짐없이 정확히 한 번 (REMAP 반영)', () => {
  const base: DataPumpRequest = {
    operation: 'IMPORT',
    mode: 'SCHEMA',
    schemas: ['HR', 'SH'],
    directory: 'DATA_PUMP_DIR',
    dumpfile: 'x.dmp',
    logfile: 'imp.log',
  };
  const check = (request: DataPumpRequest, parfile?: string) => {
    const plan = buildPlan(request, NOW);
    return assertImportCovers(plan, request, parfile ?? buildParfile(plan, request, TARGET).parfile);
  };

  it('정상 parfile은 통과', () => {
    expect(check({ ...base, remapSchemas: [{ from: 'HR', to: 'HR2' }] })).toEqual([]);
  });

  it('parfile에서 스키마가 빠지거나 두 번이면 거부', () => {
    expect(() => check(base, 'DIRECTORY=DATA_PUMP_DIR\nSCHEMAS=HR\nJOB_NAME=X\n')).toThrow(/빠짐/);
    expect(() => check(base, 'DIRECTORY=DATA_PUMP_DIR\nSCHEMAS=HR,SH,HR\nJOB_NAME=X\n')).toThrow(/두 번/);
  });

  it('REMAP_SCHEMA 원본이 고른 스키마에 없으면 거부 (덤프에 없는 원본은 ORA-39146을 내고도 "successfully completed")', () => {
    expect(() => check({ ...base, remapSchemas: [{ from: 'SCOTT', to: 'X' }] })).toThrow(/REMAP_SCHEMA 원본 SCOTT/);
    expect(() => check({ ...base, mode: 'TABLE', schemas: undefined, tableOwner: 'HR', tables: ['EMP'], remapSchemas: [{ from: 'SH', to: 'X' }] })).toThrow(
      /REMAP_SCHEMA 원본 SH/
    );
  });

  it('FULL import의 REMAP 원본은 미리 확인할 수 없다고 알린다', () => {
    expect(check({ ...base, mode: 'FULL', schemas: undefined, remapSchemas: [{ from: 'HR', to: 'X' }] })[0]).toMatch(/덤프에 HR/);
  });

  it('TABLE 모드 테이블이 parfile에서 빠지면 거부', () => {
    const request = { ...base, mode: 'TABLE' as const, schemas: undefined, tableOwner: 'HR', tables: ['EMP', 'DEPT'] };
    expect(() => check(request, 'DIRECTORY=DATA_PUMP_DIR\nTABLES=HR.EMP\nJOB_NAME=X\n')).toThrow(/빠짐/);
  });
});

describe('6. 파티션 Import 커버리지', () => {
  it('고른 파티션이 작업들에 정확히 한 번씩 들어가지 않으면 거부', async () => {
    const { assertPartitionImportCovers } = await import('./dataPumpPartitionService');
    const job = (no: number, names: string[]) => ({ no, partitions: names.map((name) => ({ name })) });
    expect(() => assertPartitionImportCovers(['P1', 'P2'], [job(1, ['P1']), job(2, ['P2', 'P3'])])).not.toThrow();
    expect(() => assertPartitionImportCovers(['P1', 'P2'], [job(1, ['P1'])])).toThrow(/빠짐/);
    expect(() => assertPartitionImportCovers(['P1'], [job(1, ['P1']), job(2, ['P1'])])).toThrow(/두 번/);
  });
});
