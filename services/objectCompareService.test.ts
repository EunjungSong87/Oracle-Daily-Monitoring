import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareColumns, compareSchemaPairs, compareSnapshots, diffLines, formatDataType, ObjectCompareValidationError } from './objectCompareService';
import * as objectCompareModel from '../models/objectCompareModel';
import type { ColumnInfo, ConstraintInfo, IndexInfo, SchemaSnapshot, SequenceInfo, TableInfo, TablespaceInfo } from '../models/objectCompareModel';

// 여러 스키마 비교 테스트용: DB 조회(getSnapshots)만 가짜로 바꾼다 (나머지는 실제 모듈).
vi.mock('../models/objectCompareModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../models/objectCompareModel')>()),
  getSnapshots: vi.fn(),
}));

function column(overrides: Partial<ColumnInfo> & { name: string }): ColumnInfo {
  return {
    table: 'T',
    position: 1,
    dataType: 'VARCHAR2',
    dataLength: 20,
    charLength: 20,
    charUsed: 'B',
    precision: null,
    scale: null,
    nullable: 'Y',
    defaultValue: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    dbname: 'DB',
    tablespaces: [],
    tables: [],
    columns: [],
    indexes: [],
    constraints: [],
    sequences: [],
    synonyms: [],
    sourceHashes: [],
    textObjects: [],
    statuses: {},
    ...overrides,
  };
}

describe('formatDataType', () => {
  it('문자 타입은 시맨틱(BYTE/CHAR)에 맞는 길이를 쓴다', () => {
    expect(formatDataType(column({ name: 'A', dataLength: 20, charLength: 20, charUsed: 'B' }))).toBe('VARCHAR2(20 BYTE)');
    // CHAR 시맨틱은 캐릭터셋에 따라 DATA_LENGTH가 달라지므로(60 vs 80) CHAR_LENGTH로 비교해야 한다
    expect(formatDataType(column({ name: 'A', dataLength: 80, charLength: 20, charUsed: 'C' }))).toBe('VARCHAR2(20 CHAR)');
  });

  it('NUMBER는 정밀도/스케일 유무에 따라 표기한다', () => {
    const number = (precision: number | null, scale: number | null) =>
      formatDataType(column({ name: 'N', dataType: 'NUMBER', dataLength: 22, precision, scale }));
    expect(number(null, null)).toBe('NUMBER');
    expect(number(10, 0)).toBe('NUMBER(10)');
    expect(number(10, 2)).toBe('NUMBER(10,2)');
    expect(number(null, 0)).toBe('NUMBER(*,0)');
  });

  it('DATE/TIMESTAMP 등은 DATA_TYPE 그대로 쓴다', () => {
    expect(formatDataType(column({ name: 'D', dataType: 'DATE', dataLength: 7 }))).toBe('DATE');
    expect(formatDataType(column({ name: 'D', dataType: 'TIMESTAMP(6)', dataLength: 11 }))).toBe('TIMESTAMP(6)');
  });
});

describe('compareColumns', () => {
  it('정의가 같으면 차이가 없다 (기본값의 뒤 공백, DEFAULT NULL은 무시)', () => {
    const source = [column({ name: 'A', defaultValue: "'Y' " }), column({ name: 'B', defaultValue: 'NULL' })];
    const target = [column({ name: 'A', defaultValue: "'Y'" }), column({ name: 'B', defaultValue: null })];
    expect(compareColumns(source, target)).toEqual([]);
  });

  it('한쪽에만 있는 컬럼을 찾는다', () => {
    const diffs = compareColumns([column({ name: 'A' }), column({ name: 'ONLY_SRC' })], [column({ name: 'A' }), column({ name: 'ONLY_TGT' })]);
    expect(diffs).toEqual([
      { item: 'ONLY_SRC', attribute: '컬럼 없음 (대상)', source: 'VARCHAR2(20 BYTE)', target: null },
      { item: 'ONLY_TGT', attribute: '컬럼 없음 (기준)', source: null, target: 'VARCHAR2(20 BYTE)' },
    ]);
  });

  it('타입/길이, NULL 허용, 기본값 차이를 각각 보고한다', () => {
    const diffs = compareColumns(
      [column({ name: 'A', dataLength: 20, nullable: 'N', defaultValue: '0' })],
      [column({ name: 'A', dataLength: 50, nullable: 'Y', defaultValue: '1' })]
    );
    expect(diffs.map((diff) => diff.attribute)).toEqual(['데이터 타입/길이', 'NULL 허용', '기본값']);
    expect(diffs[0]).toMatchObject({ source: 'VARCHAR2(20 BYTE)', target: 'VARCHAR2(50 BYTE)' });
  });

  it('공통 컬럼의 순서가 다르면 알려주되, 컬럼 추가로 위치만 밀린 것은 순서 차이로 보지 않는다', () => {
    const swapped = compareColumns([column({ name: 'A' }), column({ name: 'B' })], [column({ name: 'B' }), column({ name: 'A' })]);
    expect(swapped).toEqual([{ item: '(테이블)', attribute: '컬럼 순서', source: 'A, B', target: 'B, A' }]);

    const inserted = compareColumns([column({ name: 'A' }), column({ name: 'B' })], [column({ name: 'A' }), column({ name: 'NEW' }), column({ name: 'B' })]);
    expect(inserted.map((diff) => diff.attribute)).toEqual(['컬럼 없음 (기준)']);
  });
});

describe('compareSnapshots', () => {
  it('오브젝트 유무를 ONLY_SOURCE / ONLY_TARGET / SAME으로 구분한다', () => {
    const table = (name: string) => ({ name, tablespace: 'USERS', partitioned: 'NO', temporary: 'N' });
    const items = compareSnapshots(
      snapshot({ tables: [table('BOTH'), table('SRC_ONLY')] }),
      snapshot({ tables: [table('BOTH'), table('TGT_ONLY')] }),
      ['TABLE']
    );
    expect(items.map((item) => [item.name, item.result])).toEqual([
      ['BOTH', 'SAME'],
      ['SRC_ONLY', 'ONLY_SOURCE'],
      ['TGT_ONLY', 'ONLY_TARGET'],
    ]);
  });

  it('선택한 타입만, 테이블스페이스가 맨 앞에 오도록 정렬한다', () => {
    const tablespace = {
      name: 'USERS', contents: 'PERMANENT', blockSize: 8192, bigfile: 'NO', extentManagement: 'LOCAL', allocationType: 'SYSTEM',
      segmentSpaceManagement: 'AUTO', logging: 'LOGGING', status: 'ONLINE', autoextensible: 'YES', fileCount: 1, sizeMb: 100, maxSizeMb: 32768,
    };
    const both = snapshot({
      tablespaces: [tablespace],
      tables: [{ name: 'T', tablespace: 'USERS', partitioned: 'NO', temporary: 'N' }],
      sequences: [{ name: 'S', minValue: '1', maxValue: '9999', incrementBy: '1', cycle: 'N', order: 'N', cacheSize: '20' }],
    });
    expect(compareSnapshots(both, both, ['TABLE', 'TABLESPACE']).map((item) => item.type)).toEqual(['TABLESPACE', 'TABLE']);
  });

  it('테이블스페이스 크기 차이는 참고 정보일 뿐 "다름"으로 치지 않는다', () => {
    const base = {
      name: 'USERS', contents: 'PERMANENT', blockSize: 8192, bigfile: 'NO', extentManagement: 'LOCAL', allocationType: 'SYSTEM',
      segmentSpaceManagement: 'AUTO', logging: 'LOGGING', status: 'ONLINE', autoextensible: 'YES', fileCount: 1, sizeMb: 100, maxSizeMb: 32768,
    };
    const [sizeOnly] = compareSnapshots(snapshot({ tablespaces: [base] }), snapshot({ tablespaces: [{ ...base, sizeMb: 5000, fileCount: 3 }] }), ['TABLESPACE']);
    expect(sizeOnly.result).toBe('SAME');
    expect(sizeOnly.diffs.every((diff) => diff.info)).toBe(true);

    const [blockSize] = compareSnapshots(snapshot({ tablespaces: [base] }), snapshot({ tablespaces: [{ ...base, blockSize: 16384 }] }), ['TABLESPACE']);
    expect(blockSize.result).toBe('DIFF');
  });

  it('ignoreTablespace 옵션이면 테이블의 테이블스페이스 차이를 무시한다', () => {
    const source = snapshot({ tables: [{ name: 'T', tablespace: 'TS_PROD', partitioned: 'NO', temporary: 'N' }] });
    const target = snapshot({ tables: [{ name: 'T', tablespace: 'TS_DEV', partitioned: 'NO', temporary: 'N' }] });
    expect(compareSnapshots(source, target, ['TABLE'])[0].result).toBe('DIFF');
    expect(compareSnapshots(source, target, ['TABLE'], { ignoreTablespace: true })[0].result).toBe('SAME');
  });

  it('시스템이 이름 붙인 인덱스는 이름이 달라도 테이블+컬럼으로 짝을 맞춘다', () => {
    const index = (name: string) => ({
      name, table: 'T', uniqueness: 'UNIQUE', indexType: 'NORMAL', tablespace: 'USERS', partitioned: 'NO', generated: 'Y', columns: ['ID'],
    });
    const items = compareSnapshots(snapshot({ indexes: [index('SYS_C0011')] }), snapshot({ indexes: [index('SYS_C0099')] }), ['INDEX']);
    expect(items).toHaveLength(1);
    expect(items[0].result).toBe('SAME');
  });

  it('소스 해시가 다르면 DIFF + 소스 diff 조회 가능으로 표시한다', () => {
    const source = snapshot({ sourceHashes: [{ type: 'PROCEDURE', name: 'P', lines: 10, hash: '1-1' }] });
    const target = snapshot({ sourceHashes: [{ type: 'PROCEDURE', name: 'P', lines: 12, hash: '2-2' }] });
    const [item] = compareSnapshots(source, target, ['PROCEDURE']);
    expect(item).toMatchObject({ result: 'DIFF', hasSourceDiff: true, summary: '소스 다름 (기준 10줄 / 대상 12줄)' });
    expect(compareSnapshots(source, source, ['PROCEDURE'])[0]).toMatchObject({ result: 'SAME', hasSourceDiff: false });
  });

  it('뷰 정의는 줄 끝 공백과 맨 끝 빈 줄 차이를 무시한다', () => {
    const view = (text: string) => snapshot({ textObjects: [{ type: 'VIEW', name: 'V', text }] });
    expect(compareSnapshots(view('select 1\nfrom dual'), view('select 1  \r\nfrom dual\n\n'), ['VIEW'])[0].result).toBe('SAME');
    expect(compareSnapshots(view('select 1 from dual'), view('select 2 from dual'), ['VIEW'])[0].result).toBe('DIFF');
  });
});

describe('diffLines', () => {
  const ops = (a: string[], b: string[]) => diffLines(a, b).map((line) => `${line.op[0]}:${line.text}`);

  it('같으면 전부 same', () => {
    expect(ops(['a', 'b'], ['a', 'b'])).toEqual(['s:a', 's:b']);
  });

  it('줄 끝 공백/개행 차이는 무시한다', () => {
    expect(ops(['a \n', 'b\r\n'], ['a', 'b']).every((line) => line.startsWith('s:'))).toBe(true);
  });

  it('추가/삭제/변경된 줄을 찾고 줄 번호를 붙인다', () => {
    const result = diffLines(['begin', '  x := 1;', '  y := 2;', 'end;'], ['begin', '  x := 10;', '  y := 2;', '  z := 3;', 'end;']);
    expect(result).toEqual([
      { op: 'same', text: 'begin', sourceLine: 1, targetLine: 1 },
      { op: 'del', text: '  x := 1;', sourceLine: 2, targetLine: null },
      { op: 'add', text: '  x := 10;', sourceLine: null, targetLine: 2 },
      { op: 'same', text: '  y := 2;', sourceLine: 3, targetLine: 3 },
      { op: 'add', text: '  z := 3;', sourceLine: null, targetLine: 4 },
      { op: 'same', text: 'end;', sourceLine: 4, targetLine: 5 },
    ]);
  });

  it('한쪽이 비어 있어도 동작한다', () => {
    expect(ops([], ['a'])).toEqual(['a:a']);
    expect(ops(['a'], [])).toEqual(['d:a']);
    expect(ops([], [])).toEqual([]);
  });

  it('diff 결과를 적용하면 항상 원래의 양쪽이 복원된다 (무작위 입력)', () => {
    let seed = 42;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: random(30) }, () => `line${random(6)}`);
      const b = Array.from({ length: random(30) }, () => `line${random(6)}`);
      const result = diffLines(a, b);
      expect(result.filter((line) => line.op !== 'add').map((line) => line.text)).toEqual(a);
      expect(result.filter((line) => line.op !== 'del').map((line) => line.text)).toEqual(b);
    }
  });

  it('완전히 다른 큰 파일도 (정밀 diff를 포기하더라도) 양쪽을 빠짐없이 돌려준다', () => {
    const a = Array.from({ length: 4000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 4000 }, (_, i) => `b${i}`);
    const result = diffLines(a, b);
    expect(result.filter((line) => line.op === 'del')).toHaveLength(4000);
    expect(result.filter((line) => line.op === 'add')).toHaveLength(4000);
  });
});

describe('compareSchemaPairs — 여러 스키마', () => {
  const table = (name: string): TableInfo => ({ name, tablespace: 'USERS', partitioned: 'NO', temporary: 'N' });
  const tablespace = (name: string): TablespaceInfo => ({
    name,
    contents: 'PERMANENT',
    blockSize: 8192,
    bigfile: 'NO',
    extentManagement: 'LOCAL',
    allocationType: 'SYSTEM',
    segmentSpaceManagement: 'AUTO',
    logging: 'LOGGING',
    status: 'ONLINE',
    autoextensible: 'YES',
    fileCount: 1,
    sizeMb: 100,
    maxSizeMb: 1000,
  });
  const side = (dbname: string, schemas: Record<string, string[]>, tablespaces: string[]) => ({
    dbname,
    snapshots: new Map(Object.entries(schemas).map(([owner, tables]) => [owner, snapshot({ dbname, tables: tables.map(table), tablespaces: tablespaces.map(tablespace) })])),
  });
  const getSnapshots = vi.mocked(objectCompareModel.getSnapshots);

  beforeEach(() => {
    getSnapshots.mockReset();
  });

  it('짝마다 비교해 항목에 스키마를 붙이고, TABLESPACE는 한 번만 비교한다', async () => {
    getSnapshots
      .mockResolvedValueOnce(side('SRC', { HR: ['EMP', 'DEPT'], SH: ['SALES'] }, ['USERS', 'DATA']))
      .mockResolvedValueOnce(side('TGT', { HR: ['EMP'], SH2: ['SALES', 'COSTS'] }, ['USERS']));
    const result = await compareSchemaPairs(
      1,
      2,
      [
        { source: 'HR', target: 'HR' },
        { source: 'SH', target: 'SH2' },
      ],
      ['TABLESPACE', 'TABLE']
    );
    // DB마다 한 번씩만 읽고, 그 DB 쪽 스키마 목록을 넘긴다
    expect(getSnapshots).toHaveBeenCalledTimes(2);
    expect(getSnapshots.mock.calls.map((call) => call[1])).toEqual([
      ['HR', 'SH'],
      ['HR', 'SH2'],
    ]);
    expect(result.pairs).toEqual([
      { source: 'HR', target: 'HR' },
      { source: 'SH', target: 'SH2' },
    ]);
    expect(result.source).toMatchObject({ dbname: 'SRC', schema: 'HR, SH' });
    expect(result.items.map((item) => [item.type, item.sourceSchema, item.targetSchema, item.name, item.result])).toEqual([
      ['TABLESPACE', null, null, 'DATA', 'ONLY_SOURCE'],
      ['TABLESPACE', null, null, 'USERS', 'SAME'],
      ['TABLE', 'HR', 'HR', 'DEPT', 'ONLY_SOURCE'],
      ['TABLE', 'HR', 'HR', 'EMP', 'SAME'],
      ['TABLE', 'SH', 'SH2', 'COSTS', 'ONLY_TARGET'],
      ['TABLE', 'SH', 'SH2', 'SALES', 'SAME'],
    ]);
  });

  it('짝 검증: 비었거나, 한쪽 스키마 중복, 같은 DB 자기 자신, 너무 많으면 오류 (DB는 읽지 않음)', async () => {
    const run = (pairs: unknown, target = 2) => compareSchemaPairs(1, target, pairs, ['TABLE']);
    await expect(run([])).rejects.toThrow(ObjectCompareValidationError);
    await expect(run([{ source: 'HR', target: '' }])).rejects.toThrow(/1번째 짝/);
    await expect(
      run([
        { source: 'HR', target: 'A' },
        { source: 'HR', target: 'B' },
      ])
    ).rejects.toThrow(/기준 스키마 HR가 두 짝/);
    await expect(
      run([
        { source: 'A', target: 'HR' },
        { source: 'B', target: 'HR' },
      ])
    ).rejects.toThrow(/대상 스키마 HR가 두 짝/);
    await expect(run([{ source: 'HR', target: 'HR' }], 1)).rejects.toThrow(/자기 자신/);
    await expect(run(Array.from({ length: 51 }, (_, i) => ({ source: `S${i}`, target: `S${i}` })))).rejects.toThrow(/50개/);
    expect(getSnapshots).not.toHaveBeenCalled();
  });
});

describe('차이 DDL (대상을 기준에 맞춤)', () => {
  const tableRow = (name: string, overrides: Partial<TableInfo> = {}): TableInfo => ({ name, tablespace: 'USERS', partitioned: 'NO', temporary: 'N', ...overrides });
  const options = { sourceSchema: 'HR', targetSchema: 'HR2' };
  const ddlOf = (source: Partial<SchemaSnapshot>, target: Partial<SchemaSnapshot>, types: Parameters<typeof compareSnapshots>[2], extra = {}) =>
    compareSnapshots(snapshot(source), snapshot(target), types, { ...options, ...extra }).map((item) => [item.name, item.result, item.ddl]);

  it('테이블: 컬럼 추가/타입·길이/NULL/기본값 변경, 대상에만 있는 컬럼은 주석, 동일하면 DDL 없음', () => {
    const source = {
      tables: [tableRow('EMP'), tableRow('SAME')],
      columns: [
        column({ table: 'EMP', name: 'ID', dataType: 'NUMBER', precision: 10, scale: 0, nullable: 'N' }),
        column({ table: 'EMP', name: 'NAME', dataLength: 50, charLength: 50 }),
        column({ table: 'EMP', name: 'CODE', dataLength: 10, charLength: 10, nullable: 'N', defaultValue: "'A'  " }),
        column({ table: 'EMP', name: 'NEW_NN', nullable: 'N' }),
        column({ table: 'EMP', name: 'NEW_DEF', defaultValue: 'SYSDATE', dataType: 'DATE' }),
        column({ table: 'SAME', name: 'X' }),
      ],
    };
    const target = {
      tables: [tableRow('EMP'), tableRow('SAME')],
      columns: [
        column({ table: 'EMP', name: 'ID', dataType: 'NUMBER', precision: 10, scale: 0, nullable: 'N' }),
        column({ table: 'EMP', name: 'NAME', dataLength: 100, charLength: 100 }),
        column({ table: 'EMP', name: 'CODE', dataLength: 10, charLength: 10, nullable: 'Y' }),
        column({ table: 'EMP', name: 'OLD_COL' }),
        column({ table: 'SAME', name: 'X' }),
      ],
    };
    expect(ddlOf(source, target, ['TABLE'])).toEqual([
      [
        'EMP',
        'DIFF',
        [
          '-- NAME: 길이 줄임 (VARCHAR2(100 BYTE) → VARCHAR2(50 BYTE)) — 더 긴 값이 있으면 실패',
          'ALTER TABLE HR2.EMP MODIFY (NAME VARCHAR2(50 BYTE));',
          "ALTER TABLE HR2.EMP MODIFY (CODE DEFAULT 'A');",
          '-- CODE: NULL 값이 있으면 실패',
          'ALTER TABLE HR2.EMP MODIFY (CODE NOT NULL);',
          'ALTER TABLE HR2.EMP ADD (NEW_NN VARCHAR2(20 BYTE));',
          '-- NEW_NN: 기존 행에 값을 채운 뒤 NOT NULL로',
          'ALTER TABLE HR2.EMP MODIFY (NEW_NN NOT NULL);',
          'ALTER TABLE HR2.EMP ADD (NEW_DEF DATE DEFAULT SYSDATE);',
          '-- OLD_COL: 대상에만 있는 컬럼 — 지우려면 주석을 풀고 실행 (데이터가 삭제됨)',
          '-- ALTER TABLE HR2.EMP DROP COLUMN OLD_COL;',
        ],
      ],
      ['SAME', 'SAME', undefined],
    ]);
  });

  it('테이블: 타입 변경 경고, 소문자 이름은 따옴표, 테이블스페이스는 주석 MOVE (무시 옵션이면 없음)', () => {
    const source = { tables: [tableRow('t1', { tablespace: 'DATA' })], columns: [column({ table: 't1', name: 'v', dataType: 'CLOB' })] };
    const target = { tables: [tableRow('t1', { tablespace: 'USERS' })], columns: [column({ table: 't1', name: 'v' })] };
    expect(ddlOf(source, target, ['TABLE'])[0][2]).toEqual([
      '-- v: 타입 변경 (VARCHAR2(20 BYTE) → CLOB) — 데이터가 있으면 실패할 수 있음',
      'ALTER TABLE HR2."t1" MODIFY ("v" CLOB);',
      '-- 테이블스페이스가 다름 — 옮기려면 주석을 풀고 실행 (테이블이 잠기고, 인덱스는 다시 빌드해야 함)',
      '-- ALTER TABLE HR2."t1" MOVE TABLESPACE DATA;',
    ]);
    expect(ddlOf(source, target, ['TABLE'], { ignoreTablespace: true })[0][2]).toHaveLength(2);
  });

  it('인덱스: DROP + CREATE (UNIQUE/BITMAP/DESC/함수식), 제약조건·파티션 인덱스는 안내만', () => {
    const index = (overrides: Partial<IndexInfo>): IndexInfo => ({
      name: 'IX',
      table: 'EMP',
      uniqueness: 'NONUNIQUE',
      indexType: 'NORMAL',
      tablespace: 'USERS',
      partitioned: 'NO',
      generated: 'N',
      columns: ['A'],
      ...overrides,
    });
    const run = (source: IndexInfo, target: IndexInfo) => ddlOf({ indexes: [source] }, { indexes: [target] }, ['INDEX'])[0][2];
    expect(run(index({ uniqueness: 'UNIQUE', columns: ['A', 'B DESC', 'UPPER("NAME")'] }), index({}))).toEqual([
      '-- 다시 만드는 동안 이 인덱스를 쓰는 쿼리가 느려질 수 있음',
      'DROP INDEX HR2.IX;',
      'CREATE UNIQUE INDEX HR2.IX ON HR2.EMP (A, B DESC, UPPER("NAME")) TABLESPACE USERS;',
    ]);
    expect(run(index({ indexType: 'BITMAP', columns: ['C'] }), index({}))?.[2]).toBe('CREATE BITMAP INDEX HR2.IX ON HR2.EMP (C) TABLESPACE USERS;');
    expect(run(index({ partitioned: 'YES', columns: ['C'] }), index({}))?.[0]).toMatch(/파티션 인덱스/);
  });

  it('시퀀스는 달라진 항목만 ALTER, 시노님은 기준 스키마를 대상 스키마로 바꿔 CREATE OR REPLACE', () => {
    const seq = (overrides: Partial<SequenceInfo>): SequenceInfo => ({ name: 'S', minValue: '1', maxValue: '999', incrementBy: '1', cycle: 'N', order: 'N', cacheSize: '20', ...overrides });
    expect(ddlOf({ sequences: [seq({ incrementBy: '10', cycle: 'Y', cacheSize: '0' })] }, { sequences: [seq({})] }, ['SEQUENCE'])[0][2]).toEqual([
      'ALTER SEQUENCE HR2.S INCREMENT BY 10 CYCLE NOCACHE;',
    ]);
    expect(ddlOf({ synonyms: [{ name: 'SYN', target: 'HR.EMP' }] }, { synonyms: [{ name: 'SYN', target: 'HR2.DEPT' }] }, ['SYNONYM'])[0][2]).toEqual([
      'CREATE OR REPLACE SYNONYM HR2.SYN FOR HR2.EMP;',
    ]);
    expect(ddlOf({ synonyms: [{ name: 'SYN', target: 'APP.X@LINK1' }] }, { synonyms: [{ name: 'SYN', target: 'APP.Y' }] }, ['SYNONYM'])[0][2]).toEqual([
      'CREATE OR REPLACE SYNONYM HR2.SYN FOR APP.X@LINK1;',
    ]);
  });
});

describe('시노님 비교: 각자 자기 스키마를 가리키면 같음', () => {
  it('HR.EMP ↔ HR2.EMP (짝 스키마가 HR/HR2)는 동일, 다른 오브젝트면 다름', () => {
    const run = (source: string, target: string) =>
      compareSnapshots(snapshot({ synonyms: [{ name: 'S', target: source }] }), snapshot({ synonyms: [{ name: 'S', target }] }), ['SYNONYM'], {
        sourceSchema: 'HR',
        targetSchema: 'HR2',
      })[0].result;
    expect(run('HR.EMP', 'HR2.EMP')).toBe('SAME');
    expect(run('HR.EMP', 'HR2.DEPT')).toBe('DIFF');
    expect(run('APP.X', 'APP.X')).toBe('SAME');
    expect(run('APP.X', 'HR2.X')).toBe('DIFF');
  });
});

describe('제약조건 (PK/UK/FK/CHECK) 비교와 DDL', () => {
  const cons = (overrides: Partial<ConstraintInfo> & { name: string }): ConstraintInfo => ({
    table: 'EMP',
    type: 'P',
    generated: false,
    columns: ['ID'],
    status: 'ENABLED',
    validated: 'VALIDATED',
    deferrable: 'NOT DEFERRABLE',
    deferred: 'IMMEDIATE',
    deleteRule: null,
    refOwner: null,
    refTable: null,
    refColumns: [],
    condition: null,
    ...overrides,
  });
  const run = (source: ConstraintInfo[], target: ConstraintInfo[]) =>
    compareSnapshots(snapshot({ constraints: source }), snapshot({ constraints: target }), ['CONSTRAINT'], { sourceSchema: 'HR', targetSchema: 'HR2' }).map((item) => ({
      name: item.name,
      result: item.result,
      diffs: item.diffs.map((diff) => diff.attribute),
      ddl: item.ddl,
    }));

  it('시스템 이름은 테이블+종류+컬럼(CHECK는 조건)으로 짝짓고, 자기 스키마 FK는 스키마 이름이 달라도 같음', () => {
    const result = run(
      [
        cons({ name: 'SYS_C001', generated: true }),
        cons({ name: 'SYS_C002', generated: true, type: 'C', columns: ['SAL'], condition: 'sal  > 0' }),
        cons({ name: 'FK_DEPT', type: 'R', columns: ['DEPT_ID'], refOwner: 'HR', refTable: 'DEPT', refColumns: ['ID'], deleteRule: 'NO ACTION' }),
      ],
      [
        cons({ name: 'SYS_C999', generated: true }),
        cons({ name: 'SYS_C998', generated: true, type: 'C', columns: ['SAL'], condition: 'sal > 0' }),
        cons({ name: 'FK_DEPT', type: 'R', columns: ['DEPT_ID'], refOwner: 'HR2', refTable: 'DEPT', refColumns: ['ID'], deleteRule: 'NO ACTION' }),
      ]
    );
    expect(result.map((item) => [item.name, item.result])).toEqual([
      ['(시스템 생성) EMP CHECK(sal > 0)', 'SAME'],
      ['(시스템 생성) EMP PRIMARY KEY(ID)', 'SAME'],
      ['FK_DEPT', 'SAME'],
    ]);
  });

  it('정의가 다르면 DROP + ADD (FK ON DELETE, 자기 스키마 참조는 대상 스키마로), 상태만 다르면 ENABLE/DISABLE', () => {
    const result = run(
      [
        cons({ name: 'FK_DEPT', type: 'R', columns: ['DEPT_ID'], refOwner: 'HR', refTable: 'DEPT', refColumns: ['ID'], deleteRule: 'CASCADE' }),
        cons({ name: 'PK_EMP', columns: ['ID', 'SEQ'] }),
        cons({ name: 'CK_SAL', type: 'C', columns: ['SAL'], condition: 'SAL > 0', status: 'ENABLED', validated: 'VALIDATED' }),
        cons({ name: 'UK_CODE', type: 'U', columns: ['CODE'], status: 'DISABLED', validated: 'NOT VALIDATED', deferrable: 'DEFERRABLE', deferred: 'DEFERRED' }),
      ],
      [
        cons({ name: 'FK_DEPT', type: 'R', columns: ['DEPT_ID'], refOwner: 'HR2', refTable: 'DEPT', refColumns: ['ID'], deleteRule: 'NO ACTION' }),
        cons({ name: 'PK_EMP', columns: ['ID'] }),
        cons({ name: 'CK_SAL', type: 'C', columns: ['SAL'], condition: 'SAL > 0', status: 'DISABLED', validated: 'NOT VALIDATED' }),
        cons({ name: 'UK_CODE', type: 'U', columns: ['CODE'] }),
      ]
    );
    const byName = Object.fromEntries(result.map((item) => [item.name, item]));
    expect(byName.FK_DEPT.diffs).toEqual(['ON DELETE']);
    expect(byName.FK_DEPT.ddl).toEqual([
      'ALTER TABLE HR2.EMP DROP CONSTRAINT FK_DEPT;',
      '-- 기존 데이터가 제약조건을 어기면 ADD가 실패함',
      'ALTER TABLE HR2.EMP ADD CONSTRAINT FK_DEPT FOREIGN KEY (DEPT_ID) REFERENCES HR2.DEPT (ID) ON DELETE CASCADE;',
    ]);
    expect(byName.PK_EMP.ddl).toEqual([
      '-- 다른 테이블의 FK가 이 제약조건을 참조하면 DROP이 실패함 (CASCADE를 붙이면 그 FK도 지워짐)',
      'ALTER TABLE HR2.EMP DROP CONSTRAINT PK_EMP;',
      '-- 기존 데이터가 제약조건을 어기면 ADD가 실패함',
      'ALTER TABLE HR2.EMP ADD CONSTRAINT PK_EMP PRIMARY KEY (ID, SEQ);',
    ]);
    expect(byName.CK_SAL.diffs).toEqual(['상태', '검증']);
    expect(byName.CK_SAL.ddl).toEqual(['-- 기존 데이터가 제약조건을 어기면 실패함', 'ALTER TABLE HR2.EMP ENABLE VALIDATE CONSTRAINT CK_SAL;']);
    // 정의(DEFERRABLE)가 달라서 다시 만들고, 기준 상태(DISABLE)까지 붙인다
    expect(byName.UK_CODE.ddl).toEqual([
      '-- 다른 테이블의 FK가 이 제약조건을 참조하면 DROP이 실패함 (CASCADE를 붙이면 그 FK도 지워짐)',
      'ALTER TABLE HR2.EMP DROP CONSTRAINT UK_CODE;',
      'ALTER TABLE HR2.EMP ADD CONSTRAINT UK_CODE UNIQUE (CODE) DEFERRABLE INITIALLY DEFERRED DISABLE;',
    ]);
  });

  it('시스템 이름 제약조건을 다시 만들 때는 이름 없이 ADD', () => {
    const result = run(
      [cons({ name: 'SYS_C001', generated: true, type: 'U', columns: ['A'], deferrable: 'DEFERRABLE' })],
      [cons({ name: 'SYS_C777', generated: true, type: 'U', columns: ['A'] })]
    );
    expect(result[0].ddl?.slice(-1)).toEqual(['ALTER TABLE HR2.EMP ADD UNIQUE (A) DEFERRABLE;']);
    expect(result[0].ddl).toContain('ALTER TABLE HR2.EMP DROP CONSTRAINT SYS_C777;');
  });
});
