import { describe, expect, it } from 'vitest';
import type { RemapMapping, SegmentPlacement } from './dataPumpMigration';
import {
  checkRows,
  compareFindings,
  compareTablespaces,
  compileSql,
  importedRowsFromLog,
  missingPrivileges,
  parseScopeList,
  rebuildSql,
  scopedFindings,
  statsSql,
  summarize,
  type Finding,
  type ScopeItem,
} from './migrationVerify';

const mapping: RemapMapping = {
  schemas: [{ from: 'SRC', to: 'TGT', keep: false }],
  tablespaces: [
    { from: 'D1', to: 'TD1', keep: false },
    { from: 'L1', to: 'TL1', keep: false },
    { from: 'USERS', to: '', keep: true },
  ],
};

const place = (kind: SegmentPlacement['kind'], owner: string, table: string, extra: Partial<SegmentPlacement> = {}): SegmentPlacement => ({
  kind,
  owner,
  tableOwner: owner,
  table,
  name: table,
  partition: null,
  subpartition: null,
  tablespace: null,
  ...extra,
});

describe('parseScopeList', () => {
  it('OWNER.TABLE[:PART] 목록, 통째가 있으면 파티션 줄은 합친다', () => {
    expect(parseScopeList('SRC.A\nSRC.B:P1\n"Src2"."Mx":"p1", SRC.A:P9\n# 주석')).toEqual(['SRC.A', 'SRC.B:P1', 'Src2.Mx:p1']);
    expect(() => parseScopeList('  \n')).toThrow(/범위/);
  });
});

describe('행 수', () => {
  const item = (over: Partial<ScopeItem>): ScopeItem => ({ sourceKey: 'SRC.A', targetKey: 'TGT.A', exportRows: 10, importRows: 10, importRan: true, rowFilter: 'NONE', where: null, ...over });

  it('로그 대조: 일치 / 불일치 / Import 로그에 없음 / 미실행', () => {
    expect(checkRows(item({}), null).status).toBe('MATCH');
    expect(checkRows(item({ importRows: 9 }), null)).toMatchObject({ status: 'MISMATCH', detail: '로그 export 10행 / import 9행' });
    expect(checkRows(item({ importRows: null }), null)).toMatchObject({ status: 'MISMATCH', detail: 'Import 로그에 없음 (빠짐)' });
    expect(checkRows(item({ importRows: null, importRan: false }), null).status).toBe('UNKNOWN');
  });

  it('COUNT가 우선, SAMPLE은 비교 불가', () => {
    expect(checkRows(item({ importRows: 9 }), { source: 10, target: 10 }).status).toBe('MATCH');
    expect(checkRows(item({ rowFilter: 'SAMPLE' }), { source: 10, target: 3 })).toMatchObject({ status: 'UNKNOWN', detail: expect.stringMatching(/비교 불가/) });
    expect(checkRows(item({ rowFilter: 'QUERY' }), { source: 5, target: 6 }).detail).toMatch(/QUERY/);
  });

  it('Import 로그(LOGTIME/METRICS 포함)에서 파티션 단위로 읽는다', () => {
    const log = ['22-OCT-26 13:47:58.178: W-1 . . imported "TGT"."S":"P1"   21.2 KB   526 rows in 0 seconds using direct_path', '. . imported "TGT"."A"   1 KB   10 rows'].join('\n');
    expect([...importedRowsFromLog(['TGT.S:P1', 'TGT.A'], log)]).toEqual([
      ['TGT.S:P1', 526],
      ['TGT.A', 10],
    ]);
  });
});

describe('테이블스페이스 위치', () => {
  it('매핑대로면 일치, 원본 이름 그대로면 매핑 누락 의심, LOB은 컬럼으로 맞춘다', () => {
    const source = [
      place('TABLE', 'SRC', 'DOC', { tablespace: 'D1' }),
      place('LOB', 'SRC', 'DOC', { name: 'BODY (SYS_LOB0001$$)', tablespace: 'L1' }),
      place('INDEX', 'SRC', 'DOC', { name: 'PK_DOC', tablespace: 'D1' }),
      place('TABLE', 'SRC', 'CUST', { tablespace: 'USERS' }),
      place('TABLE_PARTITION', 'SRC', 'S', { partition: 'P1', tablespace: 'D1' }),
      place('TABLE_PARTITION', 'SRC', 'S', { partition: 'P2', tablespace: 'D1' }),
    ];
    const target = [
      place('TABLE', 'TGT', 'DOC', { tablespace: 'TD1' }),
      place('LOB', 'TGT', 'DOC', { name: 'BODY (SYS_LOB0099$$)', tablespace: 'L1' }),
      place('INDEX', 'TGT', 'DOC', { name: 'PK_DOC', tablespace: 'USERS' }),
      place('TABLE', 'TGT', 'CUST', { tablespace: 'USERS' }),
      place('TABLE_PARTITION', 'TGT', 'S', { partition: 'P1', tablespace: 'TD1' }),
    ];
    const result = compareTablespaces(['SRC.DOC', 'SRC.CUST', 'SRC.S:P1'], source, target, mapping);
    expect(result.map((row) => `${row.kind}:${row.object || row.partition || row.table}:${row.status}`)).toEqual([
      'TABLE:TGT.DOC:일치',
      'LOB:BODY:매핑 누락 의심',
      'INDEX:TGT.PK_DOC:불일치',
      'TABLE:TGT.CUST:일치',
      'TABLE_PARTITION:P1:일치',
    ]);
    expect(compareTablespaces(['SRC.S:P2'], source, target, mapping)[0].status).toBe('대상에 없음');
    // 시스템 이름 인덱스(SYS_C…)는 DB마다 이름이 달라도 같은 테이블에 하나씩이면 짝짓는다
    const sys = compareTablespaces(['SRC.CUST'], [place('INDEX', 'SRC', 'CUST', { name: 'SYS_C001', tablespace: 'USERS' })], [place('INDEX', 'TGT', 'CUST', { name: 'SYS_C999', tablespace: 'USERS' })], mapping);
    expect(sys.map((row) => row.status)).toEqual(['일치']);
  });
});

describe('정리 점검', () => {
  const f = (over: Partial<Finding>): Finding => ({ category: 'INVALID', owner: 'TGT', name: 'V1', type: 'VIEW', table: null, partition: null, detail: '', ...over });

  it('원본에서도 같은 상태면 "원래 그랬음", 시스템 이름은 테이블+유형으로 맞춘다', () => {
    const source = [f({ owner: 'SRC', name: 'V_OLD' }), f({ category: 'CONSTRAINT', owner: 'SRC', name: 'SYS_C001', type: 'C', table: 'SRC.A' })];
    const target = [f({ name: 'V_OLD' }), f({ name: 'V_NEW' }), f({ category: 'CONSTRAINT', name: 'SYS_C999', type: 'C', table: 'TGT.A' })];
    expect(compareFindings(source, target, mapping).map((x) => `${x.name}:${x.origin}`)).toEqual(['V_OLD:원래 그랬음', 'V_NEW:새로 생김', 'SYS_C999:원래 그랬음']);
  });

  it('원본 대비 빠진 오브젝트 권한 (권한 받은 쪽이 이관 스키마면 매핑 이름으로)', () => {
    const missing = missingPrivileges(
      [
        { owner: 'SRC', table: 'A', grantee: 'APP', privilege: 'SELECT' },
        { owner: 'SRC', table: 'A', grantee: 'REPORT', privilege: 'UPDATE' },
        { owner: 'SRC', table: 'A', grantee: 'TGT', privilege: 'DELETE' }, // 매핑 뒤 자기 자신 → 뺌
      ],
      [{ owner: 'TGT', table: 'A', grantee: 'APP', privilege: 'SELECT' }],
      mapping
    );
    expect(missing.map((x) => x.detail)).toEqual(['REPORT에게 UPDATE (원본에 있던 권한이 없음)']);
  });

  it('통계 없는 파티션은 범위 안의 것만', () => {
    const rows = [f({ category: 'NO_STATS', table: 'TGT.S', partition: 'P1', name: 'S' }), f({ category: 'NO_STATS', table: 'TGT.S', partition: 'P9', name: 'S' })];
    expect(scopedFindings(rows, ['TGT.S:P1']).map((x) => x.partition)).toEqual(['P1']);
  });

  it('조치 SQL: 재컴파일·REBUILD·통계', () => {
    expect(compileSql({ owner: 'TGT', name: 'PKG', type: 'PACKAGE BODY' })).toBe('ALTER PACKAGE TGT.PKG COMPILE BODY');
    expect(compileSql({ owner: 'TGT', name: 'X', type: 'JAVA CLASS' })).toBeNull();
    expect(rebuildSql(f({ category: 'UNUSABLE', name: 'IX', partition: 'P1' }))).toBe('ALTER INDEX TGT.IX REBUILD PARTITION P1;');
    expect(statsSql(f({ category: 'NO_STATS', table: 'TGT.S', partition: 'P1' }))).toBe("EXEC DBMS_STATS.GATHER_TABLE_STATS(ownname => 'TGT', tabname => 'S', partname => 'P1', granularity => 'PARTITION');");
  });

  it('요약', () => {
    const s = summarize(
      [checkRows({ sourceKey: 'A', targetKey: 'A', exportRows: 1, importRows: 1, importRan: true, rowFilter: 'NONE', where: null }, null)],
      [],
      [{ ...f({}), origin: '새로 생김' }]
    );
    expect(s).toMatchObject({ total: 1, rows: { MATCH: 1 }, cleanup: { total: 1, new: 1, byCategory: { INVALID: 1 } } });
  });
});
