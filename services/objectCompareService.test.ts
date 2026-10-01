import { describe, expect, it } from 'vitest';
import { compareColumns, compareSnapshots, diffLines, formatDataType } from './objectCompareService';
import type { ColumnInfo, SchemaSnapshot } from '../models/objectCompareModel';

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
