import { describe, expect, it } from 'vitest';
import { checkSqlCondition, compileFilters, tableSizeFactor } from './dataPumpFilters';
import type { FilterContext, FilterEnv, ObjectFilterRule, PathInfo } from './dataPumpFilters';
import { DataPumpValidationError } from './dataPumpErrors';
import { buildParfile, buildPlan, planExportGroups } from './dataPumpService';
import type { DataPumpRequest, ExportSplitOptions } from './dataPumpService';
import { describeTarget } from './dataPumpHistoryService';

const NOW = new Date(2026, 9, 8, 10, 0, 0);
const TARGET = { dbname: 'PRODDB', user: 'SYSTEM', host: '10.0.0.5', port: '1521', sid: 'ORCL' };
const G = 1024 ** 3;

const path = (name: string, named = true): PathInfo => ({ path: name, named, comments: '' });
const SCHEMA_PATHS = ['TABLE', 'TABLE_DATA', 'INDEX', 'CONSTRAINT', 'GRANT', 'STATISTICS', 'TRIGGER', 'VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'SEQUENCE', 'USER', 'TABLE/INDEX'];
const TABLE_PATHS = ['TABLE', 'TABLE_DATA', 'INDEX', 'CONSTRAINT', 'GRANT', 'STATISTICS', 'TRIGGER', 'COMMENT'];
const env = (versionNumber: number, allowSql = true): FilterEnv => ({
  versionNumber,
  allowSql,
  paths: {
    SCHEMA: [...SCHEMA_PATHS.map((name) => path(name)), path('COMMENT', false), path('DEFAULT_ROLE', false)],
    TABLE: [...TABLE_PATHS.map((name) => path(name, name !== 'COMMENT'))],
    DATABASE: [...SCHEMA_PATHS.map((name) => path(name)), path('TABLESPACE')],
  },
});

const ctx = (overrides: Partial<FilterContext> = {}): FilterContext => ({
  operation: 'EXPORT',
  jobMode: 'SCHEMA',
  networkLink: null,
  content: 'ALL',
  tableExistsAction: null,
  excludeStatistics: false,
  multiSchemaTables: false,
  hasTables: false,
  tableOwners: [],
  ...overrides,
});

const rule = (kind: 'INCLUDE' | 'EXCLUDE', p: string, op: ObjectFilterRule['op'] = 'ALL', values: string[] = [], subquery: string | null = null): ObjectFilterRule => ({
  kind,
  path: p,
  op,
  values,
  subquery,
});

const compile = (rules: ObjectFilterRule[], context: Partial<FilterContext> = {}, version = 19) => compileFilters({ rules }, {}, ctx(context), env(version));
const invalid = (fn: () => unknown, pattern: RegExp) => {
  expect(fn).toThrow(DataPumpValidationError);
  expect(fn).toThrow(pattern);
};

describe('오브젝트 필터 — 유형 전체 / 이름 조건', () => {
  it('EXCLUDE 유형 전체는 EXCLUDE_PATH, 통계 제외와 하나로 합친다', () => {
    const result = compile([rule('EXCLUDE', 'INDEX'), rule('EXCLUDE', 'STATISTICS')], { excludeStatistics: true });
    expect(result.excludePaths).toEqual(['INDEX', 'STATISTICS']);
    expect(result.parfileLines).toEqual(['EXCLUDE=INDEX', 'EXCLUDE=STATISTICS']);
  });

  it('경로 유형(TABLE/INDEX)도 전체 경로 목록에 있으면 허용', () => {
    expect(compile([rule('EXCLUDE', 'TABLE/INDEX')]).excludePaths).toEqual(['TABLE/INDEX']);
  });

  it('= != IN NOT IN LIKE NOT LIKE → INCLUDE는 그대로, EXCLUDE는 반대 조건(이중 부정 정리)', () => {
    const cases: [ObjectFilterRule['op'], string[], string, string][] = [
      ['=', ['A'], "IN ('A')", "!= 'A'"], // INCLUDE =/IN은 OR 병합용으로 IN으로 통일
      ['!=', ['A'], "!= 'A'", "= 'A'"],
      ['IN', ['A', 'B'], "IN ('A','B')", "NOT IN ('A','B')"],
      ['NOT IN', ['A'], "NOT IN ('A')", "IN ('A')"],
      ['LIKE', ['PKG_%'], "LIKE 'PKG_%'", "NOT LIKE 'PKG_%'"],
      ['NOT LIKE', ['TMP%'], "NOT LIKE 'TMP%'", "LIKE 'TMP%'"],
    ];
    for (const [op, values, include, exclude] of cases) {
      expect(compile([rule('INCLUDE', 'TABLE', op, values)]).nameFilters).toEqual([{ path: 'TABLE', expr: include }]);
      expect(compile([rule('EXCLUDE', 'TABLE', op, values)]).nameFilters).toEqual([{ path: 'TABLE', expr: exclude }]);
    }
  });

  it('같은 유형의 INCLUDE =/IN은 하나의 IN으로(OR), LIKE와는 못 합친다', () => {
    const merged = compile([rule('INCLUDE', 'TABLE', 'IN', ['A', 'B']), rule('INCLUDE', 'TABLE', '=', ['C'])]);
    expect(merged.includePaths).toEqual(['TABLE']);
    expect(merged.nameFilters).toEqual([{ path: 'TABLE', expr: "IN ('A','B','C')" }]);
    expect(merged.parfileLines).toEqual([`INCLUDE=TABLE:"IN ('A','B','C')"`]);
    invalid(() => compile([rule('INCLUDE', 'TABLE', 'IN', ['A']), rule('INCLUDE', 'TABLE', 'LIKE', ['B%'])]), /=\/IN끼리만/);
  });

  it('EXCLUDE 이름 조건 여러 개는 각각 NAME_EXPR (AND = 어느 하나라도 맞으면 제외), parfile은 IN끼리 한 줄', () => {
    const result = compile([rule('EXCLUDE', 'TABLE', 'IN', ['TMP_A']), rule('EXCLUDE', 'TABLE', 'IN', ['TMP_B']), rule('EXCLUDE', 'TABLE', 'LIKE', ['BAK%'])]);
    expect(result.nameFilters).toEqual([
      { path: 'TABLE', expr: "NOT IN ('TMP_A')" },
      { path: 'TABLE', expr: "NOT IN ('TMP_B')" },
      { path: 'TABLE', expr: "NOT LIKE 'BAK%'" },
    ]);
    expect(result.parfileLines).toEqual([`EXCLUDE=TABLE:"IN ('TMP_A','TMP_B')"`, `EXCLUDE=TABLE:"LIKE 'BAK%'"`]);
  });

  it('패턴에 따옴표, 모드에 없는 유형, 이름 조건 불가 유형, 같은 유형 INCLUDE+EXCLUDE는 거부', () => {
    invalid(() => compile([rule('INCLUDE', 'TABLE', 'LIKE', ["A' OR '1"])]), /LIKE 패턴/);
    invalid(() => compile([rule('EXCLUDE', 'TABLESPACE')]), /쓸 수 있는 오브젝트 유형이 아닙니다/);
    invalid(() => compile([rule('EXCLUDE', 'DEFAULT_ROLE', '=', ['X'])]), /이름으로 거를 수 없는/);
    invalid(() => compile([rule('INCLUDE', 'TABLE'), rule('EXCLUDE', 'TABLE', 'IN', ['A'])], {}, 21), /INCLUDE와 EXCLUDE 규칙을 같이/);
  });
});

describe('INCLUDE + EXCLUDE 버전 분기', () => {
  const rules = [rule('INCLUDE', 'TABLE'), rule('EXCLUDE', 'INDEX')];
  it('19c는 거부, 21c는 허용', () => {
    invalid(() => compile(rules, {}, 19), /21c부터/);
    expect(compile(rules, {}, 21)).toMatchObject({ includePaths: ['TABLE'], excludePaths: ['INDEX'] });
  });

  it('19c에서 INCLUDE만 쓰면 통계 제외는 빠진다 (포함 목록이 정함), 21c는 같이', () => {
    expect(compile([rule('INCLUDE', 'TABLE')], { excludeStatistics: true }, 19).excludePaths).toEqual([]);
    expect(compile([rule('INCLUDE', 'TABLE')], { excludeStatistics: true }, 21).excludePaths).toEqual(['STATISTICS']);
  });

  it('여러 스키마 테이블 작업: INCLUDE 거부, "테이블만"은 테이블이 아닌 최상위 유형 EXCLUDE (19c에서도 INCLUDE 없이)', () => {
    invalid(() => compile([rule('INCLUDE', 'TABLE')], { jobMode: 'TABLE', multiSchemaTables: true }), /여러 스키마/);
    const result = compile([], { jobMode: 'TABLE', multiSchemaTables: true, excludeStatistics: true });
    expect(result.includePaths).toEqual([]);
    expect(result.excludePaths).toEqual(expect.arrayContaining(['STATISTICS', 'VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'SEQUENCE', 'USER']));
    expect(result.excludePaths).not.toEqual(expect.arrayContaining(['INDEX']));
    expect(result.parfileLines).toEqual(['EXCLUDE=STATISTICS']); // parfile은 TABLES= 한 줄이라 내부 제외는 안 씀
  });
});

describe('TABLE 모드 / 분할 작업과의 병합', () => {
  const tableRequest = (overrides: Partial<DataPumpRequest> = {}): DataPumpRequest => ({
    operation: 'EXPORT',
    mode: 'TABLE',
    tableOwner: 'HR',
    tables: ['EMP', 'DEPT'],
    directory: 'DATA_PUMP_DIR',
    dumpfile: 'x.dmp',
    logfile: 'x.log',
    ...overrides,
  });

  it('테이블 목록(nameExpr)과 TABLE 이름 조건은 둘 다 걸려 AND로 합쳐진다', () => {
    const plan = buildPlan(tableRequest({ objectFilter: { rules: [rule('EXCLUDE', 'TABLE', 'LIKE', ['TMP%'])] } }), NOW, env(19));
    expect(plan.nameExpr).toBe("IN ('EMP','DEPT')");
    expect(plan.filters.nameFilters).toEqual([{ path: 'TABLE', expr: "NOT LIKE 'TMP%'" }]);
  });

  it('분할로 떼어 낸 테이블(excludeTables)과 EXCLUDE TABLE 이름 조건도 각각 걸린다', () => {
    const plan = buildPlan(
      { operation: 'EXPORT', mode: 'SCHEMA', schemas: ['HR'], excludeTables: ['BIG1'], directory: 'D', dumpfile: 'x.dmp', logfile: 'x.log', objectFilter: { rules: [rule('EXCLUDE', 'TABLE', 'IN', ['TMP_A'])] } },
      NOW,
      env(19)
    );
    expect(plan.excludeTableExpr).toBe("NOT IN ('BIG1')");
    expect(plan.filters.nameFilters).toEqual([{ path: 'TABLE', expr: "NOT IN ('TMP_A')" }]);
  });
});

describe('QUERY', () => {
  const data = (queries: unknown[]) => ({ queries }) as never;
  it('테이블별 / 모든 테이블, 중복은 오류', () => {
    const result = compileFilters(null, data([{ owner: 'sales', table: 'orders', where: "WHERE order_dt >= DATE '2026-01-01'" }, { where: 'WHERE 1=1' }]), ctx(), env(19));
    expect(result.queries).toEqual([
      { owner: 'SALES', table: 'ORDERS', where: "WHERE order_dt >= DATE '2026-01-01'" },
      { owner: null, table: null, where: 'WHERE 1=1' },
    ]);
    expect(result.parfileLines).toEqual([`QUERY=SALES.ORDERS:"WHERE order_dt >= DATE '2026-01-01'"`, 'QUERY="WHERE 1=1"']);
    invalid(() => compileFilters(null, data([{ where: 'WHERE 1=1' }, { where: 'WHERE 2=2' }]), ctx(), env(19)), /하나만/);
    invalid(() => compileFilters(null, data([{ owner: 'A', table: 'B', where: 'WHERE 1=1' }, { owner: 'A', table: 'B', where: 'WHERE 2=2' }]), ctx(), env(19)), /이미 있습니다/);
    invalid(() => compileFilters(null, data([{ table: 'B', where: 'WHERE 1=1' }]), ctx(), env(19)), /소유자와 테이블을 같이/);
  });

  it('METADATA_ONLY 오류, DBA 미만 거부', () => {
    invalid(() => compileFilters(null, data([{ where: 'WHERE 1=1' }]), ctx({ content: 'METADATA_ONLY' }), env(19)), /METADATA_ONLY/);
    invalid(() => compileFilters(null, data([{ where: 'WHERE 1=1' }]), ctx(), env(19, false)), /DBA 이상/);
  });

  it('파티션 필터와 같이 쓸 수 있다', () => {
    const plan = buildPlan(
      {
        operation: 'EXPORT',
        mode: 'TABLE',
        tableOwner: 'SALES',
        tables: ['ORDERS'],
        partitions: ['P202601'],
        directory: 'D',
        dumpfile: 'x.dmp',
        logfile: 'x.log',
        dataFilter: { queries: [{ owner: 'SALES', table: 'ORDERS', where: "WHERE status = 'DONE'" }] },
      },
      NOW,
      env(19)
    );
    expect(plan.partitionFilters).toEqual([{ owner: 'SALES', table: 'ORDERS', partitions: ['P202601'] }]);
    expect(plan.filters.queries).toHaveLength(1);
  });
});

describe('SAMPLE', () => {
  it('범위 검증, Import·DB 링크 Export 거부, METADATA_ONLY 거부', () => {
    const sample = (percent: number) => ({ samples: [{ percent }] });
    expect(compileFilters(null, sample(10), ctx(), env(19)).parfileLines).toEqual(['SAMPLE=10']);
    expect(compileFilters(null, { samples: [{ owner: 'HR', table: 'EMP', percent: 0.5 }] }, ctx(), env(19)).parfileLines).toEqual(['SAMPLE=HR.EMP:0.5']);
    invalid(() => compileFilters(null, sample(100), ctx(), env(19)), /100 미만/);
    invalid(() => compileFilters(null, sample(0), ctx(), env(19)), /0.000001 이상/);
    invalid(() => compileFilters(null, sample(10), ctx({ operation: 'IMPORT' }), env(19)), /Export에서만/);
    invalid(() => compileFilters(null, sample(10), ctx({ networkLink: 'SRC' }), env(19)), /NETWORK_LINK/);
    invalid(() => compileFilters(null, sample(10), ctx({ content: 'METADATA_ONLY' }), env(19)), /METADATA_ONLY/);
  });

  it('분할 계획 크기에 비율 반영', () => {
    expect(tableSizeFactor(null, { samples: [{ percent: 10 }] }, 'HR', 'EMP')).toEqual({ factor: 0.1, approx: false });
    expect(tableSizeFactor(null, { samples: [{ owner: 'HR', table: 'EMP', percent: 50 }, { percent: 10 }] }, 'HR', 'EMP').factor).toBe(0.5);
  });
});

describe('DATA_OPTIONS', () => {
  const options = (names: string[]) => ({ dataOptions: names });
  it('operation/버전별 허용·거부', () => {
    expect(compileFilters(null, options(['SKIP_CONSTRAINT_ERRORS', 'DISABLE_APPEND_HINT']), ctx({ operation: 'IMPORT' }), env(19))).toMatchObject({
      dataOptions: ['SKIP_CONSTRAINT_ERRORS', 'DISABLE_APPEND_HINT'],
      dataOptionConstants: ['KU$_DATAOPT_SKIP_CONST_ERR', 'KU$_DATAOPT_DISABL_APPEND_HINT'],
      parfileLines: ['DATA_OPTIONS=SKIP_CONSTRAINT_ERRORS,DISABLE_APPEND_HINT'],
    });
    invalid(() => compileFilters(null, options(['SKIP_CONSTRAINT_ERRORS']), ctx(), env(19)), /EXPORT에서 쓸 수 없습니다/);
    invalid(() => compileFilters(null, options(['XML_CLOBS']), ctx(), env(19)), /올바르지 않습니다/);
    invalid(() => compileFilters(null, options(['CONTINUE_LOAD_ON_FORMAT_ERROR']), ctx({ operation: 'IMPORT' }), env(18)), /19 이상/);
    invalid(() => compileFilters(null, options(['ENABLE_NETWORK_COMPRESSION']), ctx({ operation: 'IMPORT' }), env(19)), /DB 링크 Import에서만/);
    expect(compileFilters(null, options(['ENABLE_NETWORK_COMPRESSION']), ctx({ operation: 'IMPORT', networkLink: 'SRC' }), env(19)).dataOptions).toEqual(['ENABLE_NETWORK_COMPRESSION']);
  });

  it('TRUST_EXISTING_TABLE_PARTITIONS는 TABLE_EXISTS_ACTION이 APPEND/TRUNCATE일 때만', () => {
    invalid(() => compileFilters(null, options(['TRUST_EXISTING_TABLE_PARTITIONS']), ctx({ operation: 'IMPORT', tableExistsAction: 'SKIP' }), env(19)), /APPEND\/TRUNCATE/);
    expect(compileFilters(null, options(['TRUST_EXISTING_TABLE_PARTITIONS']), ctx({ operation: 'IMPORT', tableExistsAction: 'APPEND' }), env(19)).dataOptions).toHaveLength(1);
  });
});

describe('VIEWS_AS_TABLES', () => {
  const views = (items: unknown[]) => ({ viewsAsTables: items }) as never;
  it('형식: OWNER.VIEW[:TEMPLATE], 뷰만 있으면 실제 테이블은 빼기', () => {
    const result = compileFilters(null, views([{ owner: 'hr', view: 'emp_v' }, { owner: 'hr', view: 'dept_v', template: 'dept_t' }]), ctx({ jobMode: 'TABLE' }), env(19));
    expect(result.viewsAsTables).toEqual(['HR.EMP_V', 'HR.DEPT_V:DEPT_T']);
    expect(result.excludeTablesOnly).toBe(true);
    expect(result.parfileLines).toEqual(['VIEWS_AS_TABLES=HR.EMP_V,HR.DEPT_V:DEPT_T']);
    invalid(() => compileFilters(null, views([{ owner: 'HR', view: "V'X" }]), ctx({ jobMode: 'TABLE' }), env(19)), /이름이 올바르지/);
  });

  it('SCHEMA/FULL 모드, 덤프 Import, 다른 스키마 테이블과 같이는 거부', () => {
    invalid(() => compileFilters(null, views([{ owner: 'HR', view: 'V' }]), ctx({ jobMode: 'SCHEMA' }), env(19)), /테이블 모드/);
    invalid(() => compileFilters(null, views([{ owner: 'HR', view: 'V' }]), ctx({ jobMode: 'TABLE', operation: 'IMPORT' }), env(19)), /DB 링크 Import/);
    invalid(() => compileFilters(null, views([{ owner: 'HR', view: 'V' }]), ctx({ jobMode: 'TABLE', hasTables: true, tableOwners: ['SALES'] }), env(19)), /같은 스키마/);
  });
});

describe('SQL 조건 공통 검증', () => {
  it('허용', () => {
    expect(checkSqlCondition("WHERE dt >= DATE '2026-01-01'", 'WHERE', 'Q')).toBe("WHERE dt >= DATE '2026-01-01'");
    expect(checkSqlCondition('ORDER BY id', 'WHERE', 'Q')).toBe('ORDER BY id');
    expect(checkSqlCondition('SELECT table_name FROM my_list', 'SUBQUERY', 'S')).toBe('SELECT table_name FROM my_list');
    // 단어 경계: UPDATED_AT 같은 컬럼 이름은 괜찮다
    expect(checkSqlCondition('WHERE updated_at > SYSDATE - 1', 'WHERE', 'Q')).toContain('updated_at');
  });

  it('금지: 세미콜론, 주석, 큰따옴표, DML/DDL/PLSQL 키워드, 시작어, 길이', () => {
    invalid(() => checkSqlCondition('WHERE 1=1; DROP TABLE x', 'WHERE', 'Q'), /세미콜론/);
    invalid(() => checkSqlCondition('WHERE 1=1 -- x', 'WHERE', 'Q'), /주석/);
    invalid(() => checkSqlCondition('WHERE 1=1 /* x */', 'WHERE', 'Q'), /주석/);
    invalid(() => checkSqlCondition('WHERE "Name" = 1', 'WHERE', 'Q'), /큰따옴표/);
    for (const word of ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXECUTE', 'BEGIN', 'DECLARE']) {
      invalid(() => checkSqlCondition(`WHERE x IN (SELECT 1 FROM t) OR ${word.toLowerCase()} x`, 'WHERE', 'Q'), new RegExp(word));
    }
    invalid(() => checkSqlCondition('id = 1', 'WHERE', 'Q'), /WHERE 또는 ORDER BY/);
    invalid(() => checkSqlCondition('WHERE 1=1', 'SUBQUERY', 'S'), /SELECT로 시작/);
    invalid(() => checkSqlCondition(`WHERE ${'x'.repeat(4000)}`, 'WHERE', 'Q'), /4000자/);
  });
});

describe('parfile 전체 / 작업 이력 요약', () => {
  it('INCLUDE/EXCLUDE, QUERY, SAMPLE, DATA_OPTIONS가 parfile과 이력 요약에 들어간다', () => {
    const request: DataPumpRequest = {
      operation: 'EXPORT',
      mode: 'SCHEMA',
      schemas: ['HR'],
      directory: 'DATA_PUMP_DIR',
      dumpfile: 'exp.dmp',
      logfile: 'exp.log',
      excludeStatistics: true,
      objectFilter: { rules: [rule('EXCLUDE', 'INDEX'), rule('EXCLUDE', 'TABLE', 'NOT IN', ['A', 'B'])] },
      dataFilter: {
        queries: [{ owner: 'HR', table: 'EMP', where: 'WHERE dept_id = 10' }, { owner: 'HR', table: 'DEPT', where: 'WHERE 1=1' }],
        samples: [{ percent: 10 }],
        dataOptions: ['GROUP_PARTITION_TABLE_DATA'],
      },
    };
    const plan = buildPlan(request, NOW, env(19));
    expect(buildParfile(plan, request, TARGET).parfile).toBe(
      [
        'DIRECTORY=DATA_PUMP_DIR',
        'DUMPFILE=exp.dmp',
        'LOGFILE=exp.log',
        'SCHEMAS=HR',
        'EXCLUDE=INDEX',
        `EXCLUDE=TABLE:"NOT IN ('A','B')"`,
        'EXCLUDE=STATISTICS',
        'QUERY=HR.EMP:"WHERE dept_id = 10"',
        'QUERY=HR.DEPT:"WHERE 1=1"',
        'SAMPLE=10',
        'DATA_OPTIONS=GROUP_PARTITION_TABLE_DATA',
        'JOB_NAME=DBC_EXP_20261008100000',
        '',
      ].join('\n')
    );
    expect(describeTarget(plan)).toBe(
      'SCHEMAS=HR / EXCLUDE INDEX, TABLE NOT IN(2개), STATISTICS / QUERY 2개 / SAMPLE 10% / DATA_OPTIONS=GROUP_PARTITION_TABLE_DATA'
    );
    expect(plan.filters.audit).toEqual([
      'QUERY HR.EMP WHERE dept_id = 10',
      'QUERY HR.DEPT WHERE 1=1',
      'SAMPLE (모든 테이블) 10%',
      'DATA_OPTIONS=GROUP_PARTITION_TABLE_DATA',
    ]);
  });

  it('VIEWS_AS_TABLES 요약', () => {
    const plan = buildPlan(
      {
        operation: 'EXPORT',
        mode: 'TABLE',
        tableOwner: null,
        tables: [],
        directory: 'D',
        dumpfile: 'v.dmp',
        logfile: 'v.log',
        dataFilter: { viewsAsTables: [{ owner: 'HR', view: 'A' }, { owner: 'HR', view: 'B' }, { owner: 'HR', view: 'C' }] },
      },
      NOW,
      env(19)
    );
    expect(plan.schemaExpr).toBeNull();
    expect(describeTarget(plan)).toContain('VIEWS_AS_TABLES 3개');
  });
});

describe('분할 계획 크기 반영', () => {
  const split = (overrides: Partial<ExportSplitOptions>): ExportSplitOptions => ({
    directory: 'DATA_PUMP_DIR',
    filePrefix: 'exp',
    chunkSize: '1T',
    parallel: 1,
    filesizeMode: 'NONE',
    ...overrides,
  });
  const sizes = [
    { owner: 'HR', name: 'EMP', bytes: 100 * G },
    { owner: 'HR', name: 'TMP_A', bytes: 50 * G },
  ];

  it('EXCLUDE TABLE은 제외, INCLUDE에 TABLE이 없으면 데이터 0, SAMPLE은 비율', () => {
    const total = (options: Partial<ExportSplitOptions>) => planExportGroups({ kind: 'SCHEMAS', schemas: ['HR'] }, sizes, split(options), NOW, env(21)).totalBytes / G;
    expect(total({})).toBe(150);
    expect(total({ objectFilter: { rules: [rule('EXCLUDE', 'TABLE', 'LIKE', ['TMP%'])] } })).toBe(100);
    expect(total({ objectFilter: { rules: [rule('INCLUDE', 'TABLE', 'IN', ['EMP'])] } })).toBe(100);
    expect(total({ objectFilter: { rules: [rule('INCLUDE', 'PROCEDURE')] } })).toBe(0);
    expect(total({ dataFilter: { samples: [{ percent: 10 }] } })).toBe(15);
  });

  it('서브쿼리/QUERY면 "어림", 뷰는 크기 0인 별도 작업', () => {
    const result = planExportGroups(
      { kind: 'SCHEMAS', schemas: ['HR'] },
      sizes,
      split({ dataFilter: { queries: [{ where: 'WHERE 1=1' }], viewsAsTables: [{ owner: 'HR', view: 'EMP_V' }] } }),
      NOW,
      env(19)
    );
    expect(result.sizeApprox).toBe(true);
    expect(result.groups.map((group) => [group.mode, group.views])).toEqual([
      ['SCHEMA', []],
      ['TABLE', ['HR.EMP_V']],
    ]);
    expect(result.groups[1].bytes).toBe(0);
    expect(result.groups[0].request.dataFilter?.viewsAsTables).toEqual([]);
  });
});
