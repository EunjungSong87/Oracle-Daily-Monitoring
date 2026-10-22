import { describe, expect, it } from 'vitest';
import { assertParfilesCover, buildParfile, buildPlan, parseTableList, planExportGroups } from './dataPumpService';
import type { DataPumpRequest, ExportSource, ExportSplitOptions } from './dataPumpService';
import { parseParList } from './dataPumpNames';

// 대소문자·따옴표 이름이 계획/parfile/실행 필터를 거치며 바뀌거나 빠지지 않는지.
// 이전에는 parseTableList가 따옴표를 떼고 대문자로 바꿔서 "MyTable"이 MYTABLE이 되어 "DB에 없음"으로 빠졌다.

const NOW = new Date(2026, 9, 22, 11, 0, 0);
const TARGET = { dbname: 'FREEPDB1', user: 'SYSTEM', host: 'localhost', port: '1521', sid: 'FREEPDB1' };
const G = 1024 ** 3;
const options = (overrides: Partial<ExportSplitOptions> = {}): ExportSplitOptions => ({
  directory: 'DATA_PUMP_DIR',
  filePrefix: 'exp_20261022',
  chunkSize: '1T',
  parallel: 1,
  filesizeMode: 'NONE',
  ...overrides,
});

function parfilesOf(groups: { request: DataPumpRequest }[]): string[] {
  return groups.map((group) => buildParfile(buildPlan(group.request, NOW), group.request, TARGET).parfile);
}

describe('parseTableList — 따옴표 이름', () => {
  it('큰따옴표 이름은 대소문자를 보존하고, 따옴표 없는 이름은 대문자', () => {
    expect(parseTableList('"QTest"."MyTable":"p2025"\nQUP."Mixed"\nhr.emp\n"QTest".upper_t P2026')).toEqual([
      { owner: 'QTest', name: 'MyTable', partition: 'p2025' },
      { owner: 'QUP', name: 'Mixed' },
      { owner: 'HR', name: 'EMP' },
      { owner: 'QTest', name: 'UPPER_T', partition: 'P2026' },
    ]);
  });

  it('작은따옴표로 감싼 줄(parfile에서 복사한 것)도 읽는다', () => {
    expect(parseTableList(`'"QTest"."MyTable"'`)).toEqual([{ owner: 'QTest', name: 'MyTable' }]);
  });
});

describe('planExportGroups — 따옴표 이름이 빠지지 않는다', () => {
  it('테이블 목록: DB의 정확한 이름과 맞춰 계획에 들어가고, parfile은 원소를 작은따옴표로 감싼다', () => {
    const source: ExportSource = {
      kind: 'TABLES',
      tables: parseTableList('"QTest"."MyTable"\nQUP."Mixed"\nQUP.EMP'),
    };
    const sizes = [
      { owner: 'QTest', name: 'MyTable', bytes: 1 * G },
      { owner: 'QUP', name: 'Mixed', bytes: 1 * G },
      { owner: 'QUP', name: 'EMP', bytes: 1 * G },
    ];
    const plan = planExportGroups(source, sizes, options(), NOW);
    expect(plan.missing).toEqual([]);
    const parfiles = parfilesOf(plan.groups);
    const tablesLine = parfiles.join('\n').split('\n').find((line) => line.startsWith('TABLES='));
    expect(parseParList(String(tablesLine).slice('TABLES='.length)).sort()).toEqual(['"QTest"."MyTable"', 'QUP."Mixed"', 'QUP.EMP'].sort());
    expect(tablesLine).toContain(`'"QTest"."MyTable"'`);
    expect(tablesLine).toContain(`'QUP."Mixed"'`);
    expect(() => assertParfilesCover(source, plan.missing, parfiles)).not.toThrow();
    // 실행(DBMS_DATAPUMP) 필터는 정확한 이름
    const built = plan.groups.map((group) => buildPlan(group.request, NOW));
    expect(built.flatMap((p) => p.tables)).toEqual(
      expect.arrayContaining([
        { owner: 'QTest', table: 'MyTable' },
        { owner: 'QUP', table: 'Mixed' },
      ])
    );
  });

  it('소문자 파티션 이름도 그대로 (expdp TABLES=...:"p2025")', () => {
    const source: ExportSource = {
      kind: 'TABLES',
      tables: parseTableList('"QTest"."MyTable":"p2025"'),
      partitionRanges: {
        'QTest.MyTable': [
          { name: 'p2025', position: 1, highValue: "TO_DATE(' 2026-01-01 00:00:00', 'SYYYY-MM-DD HH24:MI:SS')", low: null, high: '2026-01-01', known: true, numRows: 1, bytes: G },
          { name: 'P2026', position: 2, highValue: "TO_DATE(' 2027-01-01 00:00:00', 'SYYYY-MM-DD HH24:MI:SS')", low: '2026-01-01', high: '2027-01-01', known: true, numRows: 2, bytes: G },
        ],
      },
    } as ExportSource;
    const plan = planExportGroups(source, [], options(), NOW);
    expect(plan.missing).toEqual([]);
    const parfiles = parfilesOf(plan.groups);
    expect(parfiles[0]).toContain(`TABLES='"QTest"."MyTable":"p2025"'\n`);
    expect(() => assertParfilesCover(source, plan.missing, parfiles)).not.toThrow();
    expect(buildPlan(plan.groups[0].request, NOW).partitionFilters).toEqual([{ owner: 'QTest', table: 'MyTable', partitions: ['p2025'] }]);
  });

  it('스키마 선택: SCHEMAS=\'"QTest"\',QUP 로 쓰고 실행 필터는 IN (\'QTest\',\'QUP\')', () => {
    const source: ExportSource = { kind: 'SCHEMAS', schemas: ['QTest', 'QUP'] };
    const sizes = [
      { owner: 'QTest', name: 'MyTable', bytes: G },
      { owner: 'QUP', name: 'EMP', bytes: G },
    ];
    const plan = planExportGroups(source, sizes, options(), NOW);
    const parfiles = parfilesOf(plan.groups);
    expect(parfiles[0]).toContain(`SCHEMAS='"QTest"',QUP\n`);
    expect(() => assertParfilesCover(source, plan.missing, parfiles)).not.toThrow();
    expect(buildPlan(plan.groups[0].request, NOW).schemaExpr).toBe("IN ('QTest','QUP')");
  });
});

describe('Import parfile — REMAP_SCHEMA 따옴표', () => {
  it('쌍 전체를 작은따옴표로 감싼다 (\'"QTest"\':QUP2는 UDI-00014)', () => {
    const request: DataPumpRequest = {
      operation: 'IMPORT',
      mode: 'TABLE',
      tableOwner: '"QTest"',
      tables: ['"MyTable"'],
      directory: 'DATA_PUMP_DIR',
      dumpfile: 'qt_api1.dmp',
      logfile: 'imp.log',
      remapSchemas: [{ from: '"QTest"', to: 'QUP2' }],
    };
    const { parfile } = buildParfile(buildPlan(request, NOW), request, TARGET);
    expect(parfile).toContain(`TABLES='"QTest"."MyTable"'\n`);
    expect(parfile).toContain(`REMAP_SCHEMA='"QTest":QUP2'\n`);
  });
});
