import { describe, expect, it } from 'vitest';
import {
  assertImportExecution,
  assertImportParfilesCover,
  assessExport,
  baselineOf,
  buildImportJobs,
  bundleImportStatus,
  checkDumpFiles,
  evaluatePrecheck,
  filterImpact,
  normalizeMapping,
  omittedItems,
  parseMappingCsv,
  placementsFor,
  remapCollisions,
  requiredBytes,
  tablespacesOf,
  unmapped,
  verifyMigrationImport,
  type ExportDumpSet,
  type RemapMapping,
  type SegmentPlacement,
} from './dataPumpMigration';
import { buildParfile, buildPlan, executionPlans } from './dataPumpService';
import { truncateTargetsByRange } from './partitionRanges';
import type { LogItem } from './dataPumpLogVerify';
import { DataPumpValidationError } from './dataPumpErrors';

const exp = (owner: string, table: string, rows: number, partition: string | null = null): LogItem => ({ action: 'exported', owner, table, partition, subpartition: null, rows });

function set(over: Partial<ExportDumpSet> & Pick<ExportDumpSet, 'historyId' | 'jobName'>): ExportDumpSet {
  return {
    bundleJobNo: null,
    mode: 'TABLE',
    schemas: [],
    tables: [],
    directory: 'DATA_PUMP_DIR',
    dumpfile: `${over.jobName.toLowerCase()}_%U.dmp`,
    logfile: `${over.jobName.toLowerCase()}.log`,
    status: 'COMPLETED',
    expected: null,
    logItems: [],
    dumpFiles: [{ name: `${over.jobName.toLowerCase()}_01.dmp`, bytes: 1000 }],
    rowFilter: 'NONE',
    errorSummary: null,
    ...over,
  };
}

const keepAll = (owners: string[], tablespaces: string[] = []): RemapMapping => ({
  schemas: owners.map((from) => ({ from, to: '', keep: true })),
  tablespaces: tablespaces.map((from) => ({ from, to: '', keep: true })),
});

const target = { dbname: 'TGT', user: 'SYSTEM', host: 'h', port: '1521', sid: 'S' };
const options = { directory: 'DP_DIR', parallel: 1, content: 'ALL' as const, excludeStatistics: true, tableExistsAction: 'SKIP' as const, stamp: '20261022120000' };

function parfilesOf(jobs: ReturnType<typeof buildImportJobs>) {
  return jobs.map((job) => {
    const plan = buildPlan(job.request);
    return { jobName: plan.jobName, parfile: buildParfile(plan, job.request, target).parfile, sourceKeys: job.sourceKeys, plan, job };
  });
}

function caught(fn: () => void): DataPumpValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DataPumpValidationError) return error;
    throw error;
  }
  throw new Error('예외가 나지 않음');
}

describe('빠질 뻔한 경우 — Export 단계', () => {
  it('Export 로그에 일부 테이블이 없으면 "Export 단계에서 빠짐"으로 막는다', () => {
    const a = assessExport(null, [
      set({ historyId: 1, jobName: 'J1', tables: [{ owner: 'HR', table: 'EMP' }, { owner: 'HR', table: 'DEPT' }], expected: ['HR.EMP', 'HR.DEPT'], logItems: [exp('HR', 'EMP', 10)] }),
    ]);
    expect(a.blocked).toBe(true);
    expect(a.exportGaps).toEqual(['HR.DEPT (J1): 계획에 있는데 Export 로그에 없음']);
  });

  it('진행 중이거나 로그를 못 읽은 Export는 막는다', () => {
    expect(assessExport(null, [set({ historyId: 1, jobName: 'J1', status: 'RUNNING' })]).sets[0].blockers[0]).toMatch(/진행 중/);
    expect(assessExport(null, [set({ historyId: 1, jobName: 'J1', logItems: null })]).blocked).toBe(true);
  });

  it('분할 묶음 중 한 작업이 실행 기록이 없으면 빠지는 목록에 나온다', () => {
    const planned = [
      { no: 1, jobName: 'DBC_EXP_X_01', expected: ['HR.EMP'] },
      { no: 2, jobName: 'DBC_EXP_X_02', expected: ['HR.BIG'] },
    ];
    const a = assessExport(planned, [set({ historyId: 1, jobName: 'DBC_EXP_X_01', bundleJobNo: 1, tables: [{ owner: 'HR', table: 'EMP' }], expected: ['HR.EMP'], logItems: [exp('HR', 'EMP', 3)] })]);
    expect(a.notRun.map((job) => job.no)).toEqual([2]);
    expect(omittedItems(a, [1])).toEqual(['HR.BIG (DBC_EXP_X_02 — Export 실행 기록 없음)']);
  });

  it('같은 테이블이 두 덤프에 있으면(중복) 막는다', () => {
    const a = assessExport(null, [
      set({ historyId: 1, jobName: 'J1', logItems: [exp('HR', 'EMP', 1)] }),
      set({ historyId: 2, jobName: 'J2', logItems: [exp('HR', 'EMP', 1, 'P1')], expected: ['HR.EMP:P1'] }),
    ]);
    expect(a.duplicates).toEqual(['HR.EMP: J1, J2']);
    expect(a.blocked).toBe(true);
  });

  it('파티션 일부: 계획한 파티션 단위로 기준을 잡고, 빠진 파티션은 막는다', () => {
    const s = set({ historyId: 1, jobName: 'J1', expected: ['HR.SALES:P1', 'HR.SALES:P2'], logItems: [exp('HR', 'SALES', 5, 'P1')] });
    expect([...baselineOf(s)]).toEqual([['HR.SALES:P1', 5]]);
    expect(assessExport(null, [s]).exportGaps).toEqual(['HR.SALES:P2 (J1): 계획에 있는데 Export 로그에 없음']);
  });
});

describe('빠질 뻔한 경우 — Import 생성', () => {
  const schemaSet = set({
    historyId: 1,
    jobName: 'DBC_EXP_X_01',
    mode: 'SCHEMA',
    schemas: ['HR'],
    expected: ['HR.EMP', 'HR.DEPT'],
    logItems: [exp('HR', 'EMP', 10), exp('HR', 'DEPT', 4)],
  });
  const bigSet = set({ historyId: 2, jobName: 'DBC_EXP_X_02', tables: [{ owner: 'HR', table: 'BIG' }], expected: ['HR.BIG'], logItems: [exp('HR', 'BIG', 1000)] });

  it('스키마 작업 + 떼어 낸 큰 테이블 작업을 합쳐서 parfile 대조가 통과한다', () => {
    const a = assessExport(null, [schemaSet, bigSet]);
    const jobs = buildImportJobs(a.sets, keepAll(['HR']), new Map(), options);
    const built = parfilesOf(jobs);
    expect(built[0].parfile).toContain('SCHEMAS=HR');
    expect(built[0].parfile).toContain('DUMPFILE=dbc_exp_x_01_%U.dmp');
    expect(built[0].parfile).toContain('LOGFILE=imp_dbc_exp_x_01.log');
    expect(built[1].parfile).toContain('TABLES=HR.BIG');
    expect(() => assertImportParfilesCover(built, jobs.flatMap((job) => job.targetKeys))).not.toThrow();
  });

  it('떼어 낸 큰 테이블 작업을 빼먹으면 parfile 대조에서 빠짐으로 거부한다 (전체 목록 포함)', () => {
    const a = assessExport(null, [schemaSet, bigSet]);
    const jobs = buildImportJobs([a.sets[0]], keepAll(['HR']), new Map(), options);
    const error = caught(() => assertImportParfilesCover(parfilesOf(jobs), ['HR.EMP', 'HR.DEPT', 'HR.BIG']));
    expect(error.items).toEqual(['HR.BIG: Import parfile에서 빠짐']);
    expect(omittedItems(a, [1])).toEqual(['HR.BIG (DBC_EXP_X_02)']);
  });

  it('같은 덤프 세트로 두 번 만들면 중복으로 거부한다', () => {
    const a = assessExport(null, [bigSet]);
    const jobs = buildImportJobs([a.sets[0], a.sets[0]], keepAll(['HR']), new Map(), options);
    const error = caught(() => assertImportParfilesCover(parfilesOf(jobs), ['HR.BIG']));
    expect(error.items[0]).toMatch(/HR.BIG: Import parfile에 두 번 들어감/);
  });

  it('REMAP은 parfile 원문에서 다시 읽어 대상 이름으로 대조한다', () => {
    const a = assessExport(null, [bigSet]);
    const mapping: RemapMapping = { schemas: [{ from: 'HR', to: 'HR2', keep: false }], tablespaces: [] };
    const jobs = buildImportJobs(a.sets, mapping, new Map(), options);
    expect(jobs[0].targetKeys).toEqual(['HR2.BIG']);
    expect(parfilesOf(jobs)[0].parfile).toContain('REMAP_SCHEMA=HR:HR2');
    expect(() => assertImportParfilesCover(parfilesOf(jobs), ['HR2.BIG'])).not.toThrow();
    // 기준이 다른 이름이면(매핑과 parfile이 어긋남) 거부
    expect(caught(() => assertImportParfilesCover(parfilesOf(jobs), ['HR.BIG'])).items).toEqual(['HR.BIG: Import parfile에서 빠짐', 'HR2.BIG: 기준 목록 밖 (REMAP이 매핑과 다르거나 대상 밖 항목)']);
  });

  it('Import에 EXCLUDE를 추가하면 빠지는 테이블을 계산해 확인을 받는다', () => {
    const impact = filterImpact(['HR.EMP', 'HR.DEPT', 'HR.SALES:P1'], { rules: [{ kind: 'EXCLUDE', path: 'TABLE', op: 'IN', values: ['DEPT', 'SALES'] }] }, null);
    expect(impact.excluded).toEqual(['HR.DEPT', 'HR.SALES']);
    const sub = filterImpact(['HR.EMP'], { rules: [{ kind: 'EXCLUDE', path: 'TABLE', op: 'SUBQUERY', subquery: 'SELECT 1 FROM dual' }] }, { queries: [{ where: 'WHERE 1=0' }] });
    expect(sub.unknown).toEqual(['HR.EMP']);
    expect(sub.rowFilters).toHaveLength(1);
  });

  it('실행 필터가 parfile(생성 때 기준)과 다르면 실행을 거부한다', () => {
    const a = assessExport(null, [set({ historyId: 3, jobName: 'J3', tables: [{ owner: 'HR', table: 'EMP' }, { owner: 'HR', table: 'DEPT' }], logItems: [exp('HR', 'EMP', 1), exp('HR', 'DEPT', 1)] })]);
    const [job] = buildImportJobs(a.sets, keepAll(['HR']), new Map(), options);
    const plan = buildPlan(job.request);
    const expected = { mode: 'TABLE' as const, schemas: [], tables: job.expectedTables, remap: job.remap };
    expect(() => assertImportExecution(plan, executionPlans(plan), expected)).not.toThrow();
    // 요청이 바뀌어 테이블 하나가 빠진 실행 필터
    const tampered = buildPlan({ ...job.request, qualifiedTables: [{ owner: 'HR', table: 'EMP' }] });
    expect(caught(() => assertImportExecution(tampered, executionPlans(tampered), expected)).items).toEqual(['실행 SCHEMA_EXPR × NAME_EXPR: HR.DEPT 빠짐']);
    // REMAP이 기준과 다름
    const remapped = buildPlan({ ...job.request, remapSchemas: [{ from: 'HR', to: 'X' }] });
    expect(caught(() => assertImportExecution(remapped, executionPlans(remapped), expected)).items).toEqual(['REMAP_SCHEMA: HR:X 대상 밖']);
  });

  it('여러 스키마 테이블 덤프의 Import는 스키마별로 나눠도 같은 DUMPFILE을 읽는다', () => {
    const a = assessExport(null, [set({ historyId: 4, jobName: 'J4', dumpfile: 'ext.dmp', tables: [{ owner: 'A', table: 'T' }, { owner: 'B', table: 'U' }], logItems: [exp('A', 'T', 1), exp('B', 'U', 1)] })]);
    const [job] = buildImportJobs(a.sets, keepAll(['A', 'B']), new Map(), options);
    const plan = buildPlan(job.request);
    const runs = executionPlans(plan);
    expect(runs.map((run) => run.dumpfile)).toEqual(['ext.dmp', 'ext.dmp']);
    expect(() => assertImportExecution(plan, runs, { mode: 'TABLE', schemas: [], tables: job.expectedTables, remap: [] })).not.toThrow();
  });

  it('같은 테이블의 파티션이 덤프 여러 개에 나뉘면: SKIP이면 두 번째부터 통째로 건너뛰므로 APPEND로 바꾸고 순서를 건다', () => {
    const p1 = set({ historyId: 6, jobName: 'P1', tables: [{ owner: 'HR', table: 'SALES' }], expected: ['HR.SALES:P1'], logItems: [exp('HR', 'SALES', 5, 'P1')] });
    const p2 = set({ historyId: 7, jobName: 'P2', tables: [{ owner: 'HR', table: 'SALES' }], expected: ['HR.SALES:P2'], logItems: [exp('HR', 'SALES', 6, 'P2')] });
    const other = set({ historyId: 8, jobName: 'O', tables: [{ owner: 'HR', table: 'EMP' }], logItems: [exp('HR', 'EMP', 1)] });
    const a = assessExport(null, [p1, p2, other]);
    const jobs = buildImportJobs(a.sets, keepAll(['HR']), new Map(), options);
    expect(jobs.map((job) => job.request.tableExistsAction)).toEqual(['SKIP', 'APPEND', 'APPEND']); // O, P1, P2 순
    expect(jobs.map((job) => job.waitFor)).toEqual([[], [], [jobs[1].request.jobName]]);
    expect(caught(() => buildImportJobs(a.sets, keepAll(['HR']), new Map(), { ...options, tableExistsAction: 'REPLACE' })).items).toEqual([
      'HR.SALES: 덤프 2개(P1, P2)에 나뉘어 있어 TABLE_EXISTS_ACTION=REPLACE면 먼저 넣은 파티션이 지워집니다 — SKIP/APPEND(또는 파티션 비우고 넣기)로 만드세요',
    ]);
  });

  it('매핑 누락: 빈 행이 있으면 생성 불가', () => {
    const mapping = normalizeMapping({ schemas: [{ from: 'HR', to: '', keep: false }], tablespaces: [{ from: 'USERS', to: 'DATA01', keep: false }] });
    expect(unmapped(['HR'], ['USERS', 'LOB_TS'], mapping)).toEqual([
      'REMAP_SCHEMA HR: 매핑 없음 ("그대로 사용" 또는 대상 스키마를 고르세요)',
      'REMAP_TABLESPACE LOB_TS: 매핑 없음 ("그대로 사용" 또는 대상 테이블스페이스를 고르세요)',
    ]);
  });

  it('LOB만 다른 테이블스페이스: 매핑표에 LOB 테이블스페이스도 나오고 parfile에도 들어간다', () => {
    const rows: SegmentPlacement[] = [
      { kind: 'TABLE', owner: 'HR', tableOwner: 'HR', table: 'DOC', name: 'DOC', partition: null, subpartition: null, tablespace: 'USERS' },
      { kind: 'LOB', owner: 'HR', tableOwner: 'HR', table: 'DOC', name: 'SYS_LOB01', partition: null, subpartition: null, tablespace: 'LOB_TS' },
      { kind: 'INDEX', owner: 'HR', tableOwner: 'HR', table: 'DOC', name: 'DOC_PK', partition: null, subpartition: null, tablespace: 'USERS' },
      { kind: 'TABLE', owner: 'HR', tableOwner: 'HR', table: 'OTHER', name: 'OTHER', partition: null, subpartition: null, tablespace: 'OTHER_TS' },
    ];
    const used = tablespacesOf(placementsFor(['HR.DOC'], rows));
    expect(used).toEqual(['LOB_TS', 'USERS']);
    const a = assessExport(null, [set({ historyId: 5, jobName: 'J5', tables: [{ owner: 'HR', table: 'DOC' }], logItems: [exp('HR', 'DOC', 2)] })]);
    const mapping: RemapMapping = { schemas: [{ from: 'HR', to: '', keep: true }], tablespaces: [{ from: 'USERS', to: 'DATA01', keep: false }, { from: 'LOB_TS', to: 'LOB01', keep: false }] };
    const [job] = buildImportJobs(a.sets, mapping, new Map([[5, used]]), options);
    const parfile = parfilesOf([job])[0].parfile;
    expect(parfile).toContain('REMAP_TABLESPACE=LOB_TS:LOB01');
    expect(parfile).toContain('REMAP_TABLESPACE=USERS:DATA01');
  });

  it('REMAP 후 이름 충돌을 찾는다', () => {
    const mapping: RemapMapping = { schemas: [{ from: 'A', to: 'X', keep: false }, { from: 'B', to: 'X', keep: false }], tablespaces: [] };
    expect(remapCollisions(['A.T', 'B.T', 'A.U'], mapping)).toEqual(['A.T, B.T → X.T']);
  });

  it('덤프 파일 하나가 없거나 크기가 다르면 실행 불가', () => {
    const result = checkDumpFiles(
      [{ jobName: 'J1', files: [{ name: 'a_01.dmp', bytes: 100 }, { name: 'a_02.dmp', bytes: 100 }, { name: 'a_03.dmp', bytes: 50 }] }],
      { 'a_01.dmp': 100, 'a_03.dmp': 49 }
    );
    expect(result.rows.map((row) => row.status)).toEqual(['OK', 'MISSING', 'SIZE_DIFF']);
    expect(result.blocked).toBe(true);
  });

  it('파티션 이름이 DB마다 달라도 범위로 짝을 짓는다', () => {
    const source = [{ name: 'SYS_P101', known: true, low: '2026-01-01 00:00:00', high: '2026-02-01 00:00:00' }];
    const tgt = [
      { name: 'SYS_P9', known: true, low: null, high: '2026-01-01 00:00:00' },
      { name: 'SYS_P77', known: true, low: '2026-01-01 00:00:00', high: '2026-02-01 00:00:00' },
    ];
    expect([...truncateTargetsByRange(source, tgt).map]).toEqual([['SYS_P101', 'SYS_P77']]);
    // 대상 파티션이 더 넓으면(다른 기간까지) 거부
    expect(truncateTargetsByRange(source, [{ name: 'P_ALL', known: true, low: null, high: null }]).problems).toEqual(['SYS_P101 → 대상 P_ALL']);
  });

  it('CSV 붙여넣기: 비었거나 =이면 그대로 사용', () => {
    expect(parseMappingCsv('FROM,TO\nUSERS,DATA01\nLOB_TS,=\n"MyTs",')).toEqual([
      { from: 'USERS', to: 'DATA01', keep: false },
      { from: 'LOB_TS', to: '', keep: true },
      { from: 'MyTs', to: '', keep: true },
    ]);
  });
});

describe('빠질 뻔한 경우 — 실행 후', () => {
  const log = (lines: string[]) => lines.join('\n');

  it('Import 로그 행 수 불일치', () => {
    const result = verifyMigrationImport({ 'HR.EMP': 10, 'HR.DEPT': 4 }, [{ from: 'HR', to: 'HR2' }], log([
      '. . imported "HR2"."EMP"                                  5.1 KB      10 rows',
      '. . imported "HR2"."DEPT"                                 5.1 KB       3 rows',
    ]));
    expect(result).toMatchObject({ status: 'MISMATCH', missing: [], rowDiffs: ['HR2.DEPT: export 4행 / import 3행'] });
  });

  it('ORA- 에러 섞인 로그: 빠진 테이블과 에러 테이블을 따로 보여 준다', () => {
    const result = verifyMigrationImport({ 'HR.EMP': 10, 'HR.SALES:P1': 7 }, [], log([
      '. . imported "HR"."EMP"                                   5.1 KB      10 rows',
      'ORA-31693: Table data object "HR"."SALES":"P1" failed to load/unload and is being skipped due to error:',
      'ORA-01950: no privileges on tablespace \'DATA01\'',
    ]));
    expect(result).toMatchObject({ status: 'MISMATCH', missing: ['HR.SALES:P1'], errorTables: ['HR.SALES:P1'] });
  });

  it('모두 맞으면 MATCH, 파티션은 파티션 단위로 비교', () => {
    const result = verifyMigrationImport({ 'HR.SALES:P1': 7 }, [], log(['. . imported "HR"."SALES":"P1"                       5.1 KB       7 rows']));
    expect(result.status).toBe('MATCH');
  });

  it('묶음 상태: 실행 안 한 작업이 있으면 미완료, 하나라도 불일치면 불일치', () => {
    expect(bundleImportStatus([{ status: 'COMPLETED', verifyStatus: 'MATCH' }, { status: null, verifyStatus: null }], 0).status).toBe('미완료');
    expect(bundleImportStatus([{ status: 'COMPLETED', verifyStatus: 'MISMATCH' }], 0).status).toBe('불일치');
    expect(bundleImportStatus([{ status: 'COMPLETED', verifyStatus: 'MATCH' }], 2).status).toBe('미완료');
    expect(bundleImportStatus([{ status: 'COMPLETED', verifyStatus: 'MATCH' }], 0).status).toBe('완료');
  });
});

describe('Import 전 사전 점검', () => {
  it('없는 스키마/테이블스페이스와 QUOTA 없음은 차단, 공간 부족은 경고', () => {
    const rows: SegmentPlacement[] = [{ kind: 'TABLE', owner: 'HR', tableOwner: 'HR', table: 'EMP', name: 'EMP', partition: null, subpartition: null, tablespace: 'USERS' }];
    const mapping: RemapMapping = { schemas: [{ from: 'HR', to: 'HR2', keep: false }], tablespaces: [{ from: 'USERS', to: 'DATA01', keep: false }] };
    const need = requiredBytes([{ key: 'HR.EMP', bytes: 3 * 1024 ** 3 }], rows, mapping);
    expect(need.entries).toEqual([{ owner: 'HR2', tablespace: 'DATA01', bytes: 3 * 1024 ** 3 }]);
    const result = evaluatePrecheck({
      owners: ['HR2', 'NOPE'],
      existingUsers: ['HR2'],
      tablespaces: ['DATA01', 'MISSING_TS'],
      existingTablespaces: ['DATA01'],
      required: need.entries,
      sizeUnknown: [],
      freeBytes: { DATA01: 1024 ** 3 },
      quotas: [],
      unlimitedUsers: [],
    });
    expect(result.blocked).toBe(true);
    expect(result.rows.map((row) => `${row.check}:${row.target}:${row.status}`)).toEqual([
      '스키마:HR2:PASS',
      '스키마:NOPE:BLOCK',
      '테이블스페이스:DATA01:PASS',
      '테이블스페이스:MISSING_TS:BLOCK',
      '여유 공간:DATA01:WARN',
      'QUOTA:HR2 @ DATA01:BLOCK',
    ]);
    expect(result.rows.at(-1)?.sql).toBe('ALTER USER HR2 QUOTA UNLIMITED ON DATA01;');
  });
});
