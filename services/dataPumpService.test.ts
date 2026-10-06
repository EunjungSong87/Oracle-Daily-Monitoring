import { describe, expect, it } from 'vitest';
import {
  buildParfile,
  buildPlan,
  DataPumpValidationError,
  expectedFileCount,
  isDestructive,
  parseSize,
  parseTableList,
  planExportGroups,
  suggestFilesize,
} from './dataPumpService';
import type { DataPumpRequest, ExportSplitOptions } from './dataPumpService';

const NOW = new Date(2026, 9, 2, 14, 5, 9);
const TARGET = { dbname: 'PRODDB', user: 'SYSTEM', host: '10.0.0.5', port: '1521', sid: 'ORCL' };

function exportRequest(overrides: Partial<DataPumpRequest> = {}): DataPumpRequest {
  return {
    operation: 'EXPORT',
    mode: 'SCHEMA',
    schemas: ['hr', 'scott'],
    directory: 'data_pump_dir',
    dumpfile: 'exp_%U.dmp',
    logfile: 'exp.log',
    parallel: 4,
    filesize: '2g',
    excludeStatistics: true,
    flashbackConsistent: true,
    ...overrides,
  };
}

function importRequest(overrides: Partial<DataPumpRequest> = {}): DataPumpRequest {
  return {
    operation: 'IMPORT',
    mode: 'SCHEMA',
    schemas: ['HR'],
    directory: 'DATA_PUMP_DIR',
    dumpfile: 'exp_%U.dmp',
    logfile: 'imp.log',
    remapSchemas: [{ from: 'hr', to: 'hr_test' }],
    ...overrides,
  };
}

const expectInvalid = (request: DataPumpRequest, pattern: RegExp) => {
  expect(() => buildPlan(request, NOW)).toThrow(DataPumpValidationError);
  expect(() => buildPlan(request, NOW)).toThrow(pattern);
};

describe('buildPlan — export', () => {
  it('스키마 export를 실행 계획으로 바꾼다 (이름은 대문자로, 필터는 IN 목록으로)', () => {
    const plan = buildPlan(exportRequest(), NOW);
    expect(plan).toMatchObject({
      operation: 'EXPORT',
      jobMode: 'SCHEMA',
      jobName: 'DBC_EXP_20261002140509',
      directory: 'DATA_PUMP_DIR',
      schemaExpr: "IN ('HR','SCOTT')",
      nameExpr: null,
      parallel: 4,
      filesize: '2G',
      excludeStatistics: true,
      flashbackConsistent: true,
      tableExistsAction: null,
    });
  });

  it('테이블 export는 소유자 하나 + 테이블 목록', () => {
    const plan = buildPlan(exportRequest({ mode: 'TABLE', tableOwner: 'hr', tables: ['emp', 'dept'] }), NOW);
    expect(plan.schemaExpr).toBe("IN ('HR')");
    expect(plan.nameExpr).toBe("IN ('EMP','DEPT')");
  });

  it('PARALLEL>1 또는 FILESIZE를 쓰면 덤프 파일명에 %U가 있어야 한다', () => {
    expectInvalid(exportRequest({ dumpfile: 'exp.dmp' }), /%U/);
    expectInvalid(exportRequest({ dumpfile: 'exp.dmp', parallel: 1 }), /%U/); // filesize만 있어도
    expect(buildPlan(exportRequest({ dumpfile: 'exp.dmp', parallel: 1, filesize: null }), NOW).dumpfile).toBe('exp.dmp');
  });

  it('전체(FULL) export는 막는다', () => {
    expectInvalid(exportRequest({ mode: 'FULL' }), /FULL/);
  });
});

describe('buildPlan — 입력 검증 (PL/SQL 필터식에 끼어들 수 없게)', () => {
  it('따옴표나 공백이 든 이름은 거부한다', () => {
    expectInvalid(exportRequest({ schemas: ["HR') OR 1=1 --"] }), /스키마/);
    expectInvalid(exportRequest({ schemas: ['MY SCHEMA'] }), /스키마/);
    expectInvalid(exportRequest({ directory: "DIR'X" }), /DIRECTORY/);
  });

  it('경로가 들어간 파일 이름은 거부한다 (DIRECTORY 밖으로 못 나가게)', () => {
    expectInvalid(exportRequest({ dumpfile: '../etc/x_%U.dmp' }), /덤프 파일/);
    expectInvalid(exportRequest({ logfile: 'C:\\temp\\x.log' }), /로그 파일/);
  });

  it('PARALLEL 범위와 FILESIZE 형식을 확인한다', () => {
    expectInvalid(exportRequest({ parallel: 0 }), /PARALLEL/);
    expectInvalid(exportRequest({ parallel: 33 }), /PARALLEL/);
    expectInvalid(exportRequest({ filesize: '2 GB' }), /FILESIZE/);
  });

  it('스키마를 하나도 안 고르면 거부한다', () => {
    expectInvalid(exportRequest({ schemas: [] }), /스키마/);
  });
});

describe('buildPlan — import', () => {
  it('기본 TABLE_EXISTS_ACTION은 SKIP이고, REMAP을 대문자로 정리한다', () => {
    const plan = buildPlan(importRequest(), NOW);
    expect(plan).toMatchObject({
      operation: 'IMPORT',
      jobName: 'DBC_IMP_20261002140509',
      tableExistsAction: 'SKIP',
      remapSchemas: [{ from: 'HR', to: 'HR_TEST' }],
      reuseDumpfiles: false,
      flashbackConsistent: false,
    });
    expect(isDestructive(plan)).toBe(false);
  });

  it('APPEND/TRUNCATE/REPLACE는 "기존 데이터를 바꾸는 작업"으로 분류한다', () => {
    for (const action of ['APPEND', 'TRUNCATE', 'REPLACE'] as const) {
      expect(isDestructive(buildPlan(importRequest({ tableExistsAction: action }), NOW))).toBe(true);
    }
  });

  it('FULL import는 필터 없이 덤프 전체', () => {
    const plan = buildPlan(importRequest({ mode: 'FULL', schemas: undefined }), NOW);
    expect(plan.schemaExpr).toBeNull();
    expect(plan.nameExpr).toBeNull();
  });

  it('같은 원본을 두 번 REMAP하면 거부한다', () => {
    expectInvalid(importRequest({ remapSchemas: [{ from: 'HR', to: 'A' }, { from: 'hr', to: 'B' }] }), /REMAP_SCHEMA/);
  });

  it('FILESIZE는 import에서 받지 않는다', () => {
    expectInvalid(importRequest({ filesize: '2G' }), /FILESIZE/);
  });
});

describe('buildParfile', () => {
  it('export parfile과 명령어를 만든다 (비밀번호 없이)', () => {
    const request = exportRequest();
    const { parfile, command, parfileName } = buildParfile(buildPlan(request, NOW), request, TARGET);
    expect(parfile).toBe(
      [
        'DIRECTORY=DATA_PUMP_DIR',
        'DUMPFILE=exp_%U.dmp',
        'LOGFILE=exp.log',
        'SCHEMAS=HR,SCOTT',
        'EXCLUDE=STATISTICS',
        'PARALLEL=4',
        'FILESIZE=2G',
        'FLASHBACK_TIME=SYSTIMESTAMP',
        'JOB_NAME=DBC_EXP_20261002140509',
        '',
      ].join('\n')
    );
    expect(parfileName).toBe('dbc_exp_20261002140509.par');
    expect(command).toBe('expdp SYSTEM@10.0.0.5:1521/ORCL parfile=dbc_exp_20261002140509.par');
  });

  it('import parfile에 REMAP과 TABLE_EXISTS_ACTION, 테이블 목록을 넣는다', () => {
    const request = importRequest({
      mode: 'TABLE',
      tableOwner: 'hr',
      tables: ['emp'],
      tableExistsAction: 'TRUNCATE',
      remapTablespaces: [{ from: 'users', to: 'hr_data' }],
    });
    const { parfile, command } = buildParfile(buildPlan(request, NOW), request, TARGET);
    expect(parfile).toContain('TABLES=HR.EMP\n');
    expect(parfile).toContain('REMAP_SCHEMA=HR:HR_TEST\n');
    expect(parfile).toContain('REMAP_TABLESPACE=USERS:HR_DATA\n');
    expect(parfile).toContain('TABLE_EXISTS_ACTION=TRUNCATE\n');
    expect(command.startsWith('impdp ')).toBe(true);
  });
});

describe('NETWORK_LINK', () => {
  it('링크 import는 덤프 파일 없이 링크 이름만 (일관성은 원본 SCN)', () => {
    const request = importRequest({ networkLink: 'src_db.example.com', dumpfile: 'ignored.dmp', flashbackConsistent: true });
    const plan = buildPlan(request, NOW);
    expect(plan).toMatchObject({ networkLink: 'SRC_DB.EXAMPLE.COM', dumpfile: null, flashbackConsistent: true });
    const { parfile } = buildParfile(plan, request, TARGET);
    expect(parfile).not.toContain('DUMPFILE=');
    expect(parfile).toContain('NETWORK_LINK=SRC_DB.EXAMPLE.COM\n');
    expect(parfile).toContain('FLASHBACK_TIME=SYSTIMESTAMP\n');
  });

  it('덤프 import는 일관성 옵션을 무시한다', () => {
    expect(buildPlan(importRequest({ flashbackConsistent: true }), NOW).flashbackConsistent).toBe(false);
  });

  it('링크 import로 원본 DB 전체(FULL)는 막는다', () => {
    expectInvalid(importRequest({ networkLink: 'SRC', mode: 'FULL' }), /스키마나 테이블/);
  });

  it('링크 export는 덤프 파일을 그대로 쓰고 NETWORK_LINK를 붙인다', () => {
    const request = exportRequest({ networkLink: 'SRC' });
    const plan = buildPlan(request, NOW);
    expect(plan).toMatchObject({ networkLink: 'SRC', dumpfile: 'exp_%U.dmp' });
    expect(buildParfile(plan, request, TARGET).parfile).toContain('DUMPFILE=exp_%U.dmp\nLOGFILE=exp.log\nNETWORK_LINK=SRC\n');
  });

  it('링크 이름에 SQL에 끼어들 문자가 있으면 거부한다', () => {
    expectInvalid(importRequest({ networkLink: "SRC' OR 1=1" }), /DB 링크 이름/);
    expectInvalid(importRequest({ networkLink: 'SRC;DROP' }), /DB 링크 이름/);
  });
});


// ── 크기 기준 자동 분할 ──

const G = 1024 ** 3;
const T = 1024 ** 4;
const table = (owner: string, name: string, bytes: number) => ({ owner, name, bytes });
const splitOptions = (overrides: Partial<ExportSplitOptions> = {}): ExportSplitOptions => ({
  directory: 'DATA_PUMP_DIR',
  filePrefix: 'exp_20261002',
  chunkSize: '1T',
  parallel: 4,
  filesizeMode: 'AUTO',
  excludeStatistics: true,
  flashbackConsistent: true,
  ...overrides,
});

describe('parseSize / suggestFilesize', () => {
  it('단위를 바이트로 바꾼다', () => {
    expect(parseSize('1T', 'x')).toBe(T);
    expect(parseSize('500g', 'x')).toBe(500 * G);
    expect(parseSize('1.5G', 'x')).toBe(1.5 * G);
    expect(() => parseSize('1 TB', 'x')).toThrow(DataPumpValidationError);
    expect(() => parseSize('0', 'x')).toThrow(DataPumpValidationError);
  });

  it('그룹 크기 ÷ PARALLEL (+5%)로 파일 하나 크기를 정하고, 1G 이상은 G 단위로 올림', () => {
    expect(suggestFilesize(T, 4)).toBe('269G'); // 256G * 1.05 = 268.8G → 269G
    expect(suggestFilesize(800 * 1024 ** 2, 4)).toBe('300M'); // 210M → 300M
    expect(suggestFilesize(10 * 1024 ** 2, 8)).toBe('100M'); // 최소 100M
    expect(suggestFilesize(0, 4)).toBeNull();
  });

  it('예상 파일 수는 PARALLEL 이상', () => {
    expect(expectedFileCount(T, 4, '269G')).toBe(4);
    expect(expectedFileCount(T, 2, '100G')).toBe(11);
    expect(expectedFileCount(T, 4, null)).toBe(4);
  });
});

describe('planExportGroups — 스키마 선택', () => {
  it('분할 크기 이하면 스키마 작업 하나', () => {
    const sizes = [table('HR', 'EMP', 300 * G), table('HR', 'DEPT', 200 * G)];
    const { groups } = planExportGroups({ kind: 'SCHEMAS', schemas: ['hr'] }, sizes, splitOptions(), NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ no: 1, owners: ['HR'], mode: 'SCHEMA', bytes: 500 * G, excludedTables: [] });
    expect(groups[0].request).toMatchObject({ mode: 'SCHEMA', schemas: ['HR'], dumpfile: 'exp_20261002_01_%U.dmp', jobName: 'DBC_EXP_20261002140509_01' });
  });

  it('넘으면 큰 테이블부터 떼어 내 1T 이하 TABLE 작업들로 묶고, 나머지+기타 오브젝트는 그것들을 EXCLUDE한 스키마 작업', () => {
    const sizes = [
      table('BIG', 'A', 700 * G),
      table('BIG', 'B', 600 * G),
      table('BIG', 'C', 300 * G),
      table('BIG', 'D', 250 * G),
      table('BIG', 'SMALL1', 1 * G),
      table('BIG', 'SMALL2', 1 * G),
    ];
    const { groups, totalBytes } = planExportGroups({ kind: 'SCHEMAS', schemas: ['BIG'] }, sizes, splitOptions(), NOW);
    // 전체 1852G → 큰 것부터 A(700), B(600)를 떼어 내면 남은 552G가 1T 이하라 거기서 멈춤.
    // A+B는 1300G라 한 작업에 못 넣으므로 각각 따로.
    expect(groups.map((g) => [g.mode, g.tables.map((t) => t.name).join(','), Math.round(g.bytes / G)])).toEqual([
      ['SCHEMA', 'C,D,SMALL1,SMALL2', 552],
      ['TABLE', 'A', 700],
      ['TABLE', 'B', 600],
    ]);
    expect(groups[0].excludedTables.sort()).toEqual(['A', 'B']);
    expect(groups[0].request.excludeTables?.sort()).toEqual(['A', 'B']);
    expect(groups.every((g) => g.bytes <= T)).toBe(true);
    expect(totalBytes).toBe(sizes.reduce((sum, t) => sum + t.bytes, 0));
  });

  it('테이블 하나가 분할 크기보다 크면 혼자 한 작업이 되고 oversize로 표시', () => {
    const { groups } = planExportGroups({ kind: 'SCHEMAS', schemas: ['X'] }, [table('X', 'HUGE', 3 * T), table('X', 'T1', G)], splitOptions(), NOW);
    expect(groups.map((g) => [g.mode, g.oversize])).toEqual([
      ['SCHEMA', false],
      ['TABLE', true],
    ]);
  });

  it('NONE이면 나누지 않는다', () => {
    const sizes = [table('X', 'A', 3 * T), table('X', 'B', 2 * T)];
    const { groups, chunkBytes } = planExportGroups({ kind: 'SCHEMAS', schemas: ['X'] }, sizes, splitOptions({ chunkSize: 'NONE' }), NOW);
    expect(chunkBytes).toBeNull();
    expect(groups).toHaveLength(1);
  });

  it('여러 스키마의 합이 분할 크기 이하면 한 작업(SCHEMAS=A,B)으로 묶는다', () => {
    const sizes = [table('A', 'T1', 10 * G), table('B', 'T1', 20 * G), table('C', 'T9', 5 * G)];
    const { groups } = planExportGroups({ kind: 'SCHEMAS', schemas: ['A', 'B', 'C'] }, sizes, splitOptions(), NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ owners: ['A', 'B', 'C'], mode: 'SCHEMA', bytes: 35 * G, excludedTables: [] });
    expect(groups[0].request).toMatchObject({ mode: 'SCHEMA', schemas: ['A', 'B', 'C'], excludeTables: [] });
  });

  it('스키마들을 크기로 묶어 분할 크기 이하 작업 여러 개로 만든다 (스키마는 쪼개지 않음)', () => {
    const sizes = [table('A', 'T', 600 * G), table('B', 'T', 300 * G), table('C', 'T', 500 * G)];
    const { groups } = planExportGroups({ kind: 'SCHEMAS', schemas: ['A', 'B', 'C'] }, sizes, splitOptions(), NOW);
    // 큰 것부터: A(600) → 새 작업, C(500)는 A와 합치면 1100G라 새 작업, B(300)는 A 작업에 들어감(900G)
    expect(groups.map((g) => [g.owners.join(','), Math.round(g.bytes / G)])).toEqual([
      ['A,B', 900],
      ['C', 500],
    ]);
  });

  it('혼자 분할 크기를 넘는 스키마만 테이블 단위로 나누고, 그 나머지 작업은 다른 스키마와 섞지 않는다', () => {
    const sizes = [table('BIG', 'X', 900 * G), table('BIG', 'Y', 300 * G), table('S1', 'T', 10 * G), table('S2', 'T', 20 * G)];
    const { groups } = planExportGroups({ kind: 'SCHEMAS', schemas: ['BIG', 'S1', 'S2'] }, sizes, splitOptions(), NOW);
    expect(groups.map((g) => [g.mode, g.owners.join(','), g.tables.map((t) => t.name).join(','), g.excludedTables.join(',')])).toEqual([
      ['SCHEMA', 'S1,S2', 'T,T', ''], // 작은 스키마 둘은 한 작업
      ['SCHEMA', 'BIG', 'Y', 'X'], // BIG의 나머지 (X 제외) — 단독
      ['TABLE', 'BIG', 'X', ''],
    ]);
    expect(groups.map((g) => g.request.logfile)).toEqual(['exp_20261002_01.log', 'exp_20261002_02.log', 'exp_20261002_03.log']);
  });
});

describe('planExportGroups — 테이블 목록', () => {
  it('목록을 DB 테이블과 맞추고, 없는 건 missing으로, 소유자별로 1T 이하 작업을 만든다', () => {
    const sizes = [table('HR', 'EMP', 600 * G), table('HR', 'DEPT', 500 * G), table('HR', 'LOC', 300 * G), table('SH', 'SALES', 100 * G)];
    const list = parseTableList('HR.EMP\nhr.dept\n"HR"."LOC"\nSH SALES\nHR.NOPE\n# 주석\n\nHR.EMP');
    const { groups, missing } = planExportGroups({ kind: 'TABLES', tables: list }, sizes, splitOptions(), NOW);
    expect(missing).toEqual(['HR.NOPE']);
    expect(groups.map((g) => [g.owners[0], g.mode, g.tables.map((t) => t.name).join(',')])).toEqual([
      ['HR', 'TABLE', 'EMP,LOC'],
      ['HR', 'TABLE', 'DEPT'],
      ['SH', 'TABLE', 'SALES'],
    ]);
  });

  it('형식이 틀린 줄은 거부', () => {
    expect(() => parseTableList('EMP')).toThrow(/소유자.테이블/);
    expect(() => parseTableList('  \n# x\n')).toThrow(/비어/);
  });
});

describe('planExportGroups — 테이블 목록에 파티션', () => {
  const range = (name: string, position: number, bytes: number) => ({
    name,
    position,
    highValue: '',
    known: true,
    low: null,
    high: null,
    numRows: null,
    bytes,
  });
  const ORDERS = [range('P01', 1, 300 * G), range('P02', 2, 300 * G), range('P03', 3, 300 * G), range('P04', 4, 300 * G)];
  const LOGS = [range('P01', 1, 10 * G), range('P02', 2, 10 * G)];

  it('OWNER.TABLE:PARTITION 줄을 읽는다 (expdp TABLES 형식, 공백/쉼표도)', () => {
    expect(parseTableList('sales.orders:p01\nSALES ORDERS P02\nSALES,LOGS\n')).toEqual([
      { owner: 'SALES', name: 'ORDERS', partition: 'P01' },
      { owner: 'SALES', name: 'ORDERS', partition: 'P02' },
      { owner: 'SALES', name: 'LOGS' },
    ]);
    expect(() => parseTableList('A.B:C:D')).toThrow(/소유자.테이블:파티션/);
  });

  it('같은 테이블의 파티션은 한 작업(parfile)에 모으고, 분할 크기를 넘을 때만 기간 순서로 나눈다', () => {
    const list = parseTableList('SALES.ORDERS:P01\nSALES.ORDERS:P02\nSALES.ORDERS:P03\nSALES.ORDERS:P04\nSALES.LOGS:P02\nSALES.ORDERS:P99');
    const { groups, missing } = planExportGroups(
      { kind: 'TABLES', tables: list, partitionRanges: { 'SALES.ORDERS': ORDERS, 'SALES.LOGS': LOGS } },
      [],
      splitOptions(),
      NOW
    );
    expect(missing).toEqual(['SALES.ORDERS:P99']);
    expect(groups.map((g) => [g.tables[0].name, g.partitions.map((p) => p.name).join(','), g.bytes / G])).toEqual([
      ['ORDERS', 'P01,P02,P03', 900],
      ['ORDERS', 'P04', 300],
      ['LOGS', 'P02', 10],
    ]);
    // 테이블마다 따로 — 다른 테이블에 같은 파티션 이름이 있어도 덤프 이름이 겹치지 않게 테이블 이름을 넣음
    expect(groups[2].request.dumpfile).toBe('exp_20261002_LOGS_P02_%U.dmp');
    expect(buildParfile(buildPlan(groups[0].request, NOW), groups[0].request, TARGET).parfile).toContain(
      'TABLES=SALES.ORDERS:P01,SALES.ORDERS:P02,SALES.ORDERS:P03\n'
    );
  });

  it('같은 테이블이 통째로도 적혀 있으면 통째로, RANGE 파티션 정보가 없는 테이블의 파티션 줄은 missing', () => {
    const sizes = [table('SALES', 'ORDERS', 1200 * G)];
    const list = parseTableList('SALES.ORDERS\nSALES.ORDERS:P01\nSALES.HEAP:P01');
    const { groups, missing } = planExportGroups({ kind: 'TABLES', tables: list, partitionRanges: { 'SALES.ORDERS': ORDERS } }, sizes, splitOptions(), NOW);
    expect(groups.map((g) => [g.tables[0].name, g.partitions.length])).toEqual([['ORDERS', 0]]);
    expect(missing).toEqual(['SALES.HEAP:P01']);
  });
});

describe('buildPlan / buildParfile — 분할 작업용 옵션', () => {
  it('스키마 작업의 제외 테이블은 NOT IN 필터와 EXCLUDE=TABLE 줄이 된다', () => {
    const request = exportRequest({ schemas: ['BIG'], excludeTables: ['A', 'B'], flashbackScn: '123456789012' });
    const plan = buildPlan(request, NOW);
    expect(plan.excludeTableExpr).toBe("NOT IN ('A','B')");
    expect(plan.flashbackScn).toBe('123456789012');
    const { parfile } = buildParfile(plan, request, TARGET, '작업 1/3');
    expect(parfile.startsWith('# 작업 1/3\n')).toBe(true);
    expect(parfile).toContain(`EXCLUDE=TABLE:"IN ('A','B')"\n`);
    expect(parfile).toContain('FLASHBACK_SCN=123456789012\n');
    expect(parfile).not.toContain('FLASHBACK_TIME');
  });

  it('제외 테이블은 스키마 하나짜리 작업에서만', () => {
    expect(() => buildPlan(exportRequest({ excludeTables: ['A'] }), NOW)).toThrow(/하나만/);
  });

  it('SCN은 숫자만', () => {
    expect(() => buildPlan(exportRequest({ flashbackScn: '1; DROP' }), NOW)).toThrow(/FLASHBACK_SCN/);
  });
});
