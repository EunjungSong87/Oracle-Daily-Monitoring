import { describe, expect, it } from 'vitest';
import { parseManifest, planPartitionImportJobs } from './dataPumpPartitionService';
import type { PartitionImportOptions } from './dataPumpPartitionService';
import { buildParfile, buildPlan, DataPumpValidationError, planExportGroups } from './dataPumpService';
import type { ExportSplitOptions } from './dataPumpService';
import { buildManifest, buildRanges, manifestText, overlaps, parseHighValue } from './partitionRanges';
import type { PartitionManifestEntry } from './partitionRanges';
import type { PartitionRow, PartitionTableInfo } from '../models/dataPumpModel';

const NOW = new Date(2026, 9, 6, 9, 30, 0);
const TARGET = { dbname: 'PRODDB', user: 'SYSTEM', host: '10.0.0.5', port: '1521', sid: 'ORCL' };
const G = 1024 ** 3;
const toDate = (date: string) => `TO_DATE(' ${date} 00:00:00', 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')`;
const rows = (highs: string[]): PartitionRow[] =>
  highs.map((highValue, index) => ({ name: `P${index + 1}`, position: index + 1, highValue, numRows: 10, bytes: (index + 1) * G }));
const TABLE: PartitionTableInfo = { owner: 'SALES', name: 'ORDERS', keyColumn: 'ORDER_DT', keyType: 'DATE', partitionCount: 4, interval: null, subpartitioning: null };
const IMPORT_OPTIONS: PartitionImportOptions = { directory: 'DATA_PUMP_DIR', logPrefix: 'imp_orders', parallel: 1 };
const splitOptions = (chunkSize: string): ExportSplitOptions => ({ directory: 'DATA_PUMP_DIR', filePrefix: 'exp_orders', chunkSize, parallel: 1, filesizeMode: 'NONE' });

// 1월(1G) / 2월(2G) / 3월(3G) / 그 이후(4G)
const RANGES = buildRanges(rows([toDate('2026-02-01'), toDate('2026-03-01'), toDate('2026-04-01'), 'MAXVALUE']));
const partitionSource = (names: string[]) => ({ kind: 'PARTITIONS' as const, owner: 'SALES', table: 'ORDERS', partitions: RANGES.filter((r) => names.includes(r.name)) });

describe('parseHighValue', () => {
  it('DATE / TIMESTAMP / 숫자·문자 날짜 / MAXVALUE', () => {
    expect(parseHighValue(toDate('2026-02-01'))).toEqual({ kind: 'VALUE', value: '2026-02-01 00:00:00' });
    expect(parseHighValue("TIMESTAMP' 2026-02-01 12:30:00'")).toEqual({ kind: 'VALUE', value: '2026-02-01 12:30:00' });
    expect(parseHighValue("'202602'")).toEqual({ kind: 'VALUE', value: '2026-02-01 00:00:00' });
    expect(parseHighValue('20260215')).toEqual({ kind: 'VALUE', value: '2026-02-15 00:00:00' });
    expect(parseHighValue("'2026-02-15'")).toEqual({ kind: 'VALUE', value: '2026-02-15 00:00:00' });
    expect(parseHighValue("'2026-02'")).toEqual({ kind: 'VALUE', value: '2026-02-01 00:00:00' });
    expect(parseHighValue('MAXVALUE')).toEqual({ kind: 'MAXVALUE' });
  });

  it('날짜가 아닌 값은 UNKNOWN (일련번호, 없는 날짜)', () => {
    expect(parseHighValue('10000000')).toEqual({ kind: 'UNKNOWN' });
    expect(parseHighValue("'20260230'")).toEqual({ kind: 'UNKNOWN' });
    expect(parseHighValue("'A'")).toEqual({ kind: 'UNKNOWN' });
  });
});

describe('buildRanges / overlaps', () => {
  it('파티션마다 [앞 파티션 상한, 내 상한) 범위', () => {
    expect(RANGES.map((range) => [range.name, range.low, range.high])).toEqual([
      ['P1', null, '2026-02-01 00:00:00'],
      ['P2', '2026-02-01 00:00:00', '2026-03-01 00:00:00'],
      ['P3', '2026-03-01 00:00:00', '2026-04-01 00:00:00'],
      ['P4', '2026-04-01 00:00:00', null],
    ]);
  });

  it('기간과 겹치는 파티션만 (경계 파티션 포함)', () => {
    const pick = (from: string | null, to: string | null) => RANGES.filter((range) => overlaps(range, from, to)).map((range) => range.name);
    expect(pick('2026-02-15 00:00:00', '2026-03-02 00:00:00')).toEqual(['P2', 'P3']);
    expect(pick('2026-02-01 00:00:00', '2026-03-01 00:00:00')).toEqual(['P2']);
    expect(pick(null, '2026-01-10 00:00:00')).toEqual(['P1']);
    expect(pick('2026-05-01 00:00:00', null)).toEqual(['P4']);
  });

  it('해석 못 한 파티션 다음 파티션은 하한을 모르므로 known=false', () => {
    expect(buildRanges(rows(["'A'", toDate('2026-02-01')])).map((range) => range.known)).toEqual([false, false]);
  });
});

describe('Export 분할 — Range 파티션 대상', () => {
  it('기간 순서대로 분할 크기까지 채워 묶고, 파티션 크기로 계산한다', () => {
    // 1G+2G = 3G ≤ 3G, 3G 혼자
    const { groups, totalBytes } = planExportGroups(partitionSource(['P1', 'P2', 'P3']), [], splitOptions('3G'), NOW);
    expect(groups.map((group) => [group.partitions.map((p) => p.name), group.bytes / G])).toEqual([
      [['P1', 'P2'], 3],
      [['P3'], 3],
    ]);
    expect(totalBytes).toBe(6 * G);
    const plan = buildPlan(groups[0].request, NOW);
    expect(plan).toMatchObject({ partitionExpr: "IN ('P1','P2')", partitionTable: { owner: 'SALES', name: 'ORDERS' } });
    expect(buildParfile(plan, groups[0].request, TARGET).parfile).toContain('TABLES=SALES.ORDERS:P1,SALES.ORDERS:P2\n');
  });

  it('"파티션마다 하나"면 파티션 하나당 작업 하나, 덤프 이름에 파티션 이름', () => {
    const { groups } = planExportGroups(partitionSource(['P2', 'P3']), [], splitOptions('PARTITION'), NOW);
    expect(groups.map((group) => group.request.dumpfile)).toEqual(['exp_orders_P2_%U.dmp', 'exp_orders_P3_%U.dmp']);
  });

  it('"파티션마다 하나"는 파티션 대상에서만', () => {
    expect(() => planExportGroups({ kind: 'SCHEMAS', schemas: ['HR'] }, [], splitOptions('PARTITION'), NOW)).toThrow(DataPumpValidationError);
  });

  it('파티션 지정은 export에서만, 테이블 하나일 때만', () => {
    const base = { operation: 'EXPORT' as const, mode: 'TABLE' as const, tableOwner: 'SALES', directory: 'D', dumpfile: 'x.dmp', logfile: 'x.log' };
    expect(() => buildPlan({ ...base, tables: ['A', 'B'], partitions: ['P1'] }, NOW)).toThrow(/테이블을 하나만/);
    expect(() => buildPlan({ ...base, operation: 'IMPORT', tables: ['A'], partitions: ['P1'] }, NOW)).toThrow(/Export에서만/);
  });
});

// 파티션 export 결과 매니페스트: P1+P2는 한 덤프, P3는 따로
function exportedManifest() {
  const entries: PartitionManifestEntry[] = [
    { ...RANGES[0], dumpfile: 'exp_orders_01_%U.dmp' },
    { ...RANGES[1], dumpfile: 'exp_orders_01_%U.dmp' },
    { ...RANGES[2], dumpfile: 'exp_orders_P3_%U.dmp' },
  ];
  return buildManifest(TABLE, 'PRODDB', 'DATA_PUMP_DIR', entries, NOW);
}

describe('매니페스트', () => {
  it('써 둔 매니페스트를 그대로 다시 읽는다', () => {
    const manifest = exportedManifest();
    expect(parseManifest(manifestText(manifest))).toEqual(manifest);
  });

  it('다른 JSON이나 경로가 든 파일 이름은 거부', () => {
    expect(() => parseManifest('{"kind":"OTHER"}')).toThrow(DataPumpValidationError);
    const manifest = exportedManifest();
    const tampered = { ...manifest, partitions: [{ ...manifest.partitions[0], dumpfile: '../etc/passwd' }] };
    expect(() => parseManifest(JSON.stringify(tampered))).toThrow(DataPumpValidationError);
  });
});

describe('planPartitionImportJobs', () => {
  const manifest = exportedManifest();

  it('덤프 하나당 작업 하나, 같은 덤프의 안 고른 파티션도 같이 들어감을 알린다', () => {
    const result = planPartitionImportJobs(manifest, ['P2', 'P3'], IMPORT_OPTIONS, RANGES);
    expect(result.jobs.map((job) => [job.dumpfile, job.partitions.map((p) => p.name), job.extraPartitions])).toEqual([
      ['exp_orders_01_%U.dmp', ['P1', 'P2'], ['P1']],
      ['exp_orders_P3_%U.dmp', ['P3'], []],
    ]);
    expect(result.notes.some((note) => note.includes('P1'))).toBe(true);
  });

  it('대상 테이블이 있으면 APPEND로 데이터만, 같은 범위 파티션을 비우기 대상으로', () => {
    const result = planPartitionImportJobs(manifest, ['P3'], { ...IMPORT_OPTIONS, truncateBeforeLoad: true }, RANGES, NOW);
    expect(result.createsTable).toBe(false);
    expect(result.jobs.map((job) => [job.request.tableExistsAction, job.request.content, job.truncatePartitions])).toEqual([['APPEND', 'DATA_ONLY', ['P3']]]);
    const plan = buildPlan(result.jobs[0].request, NOW);
    expect(plan.truncateTarget).toEqual({ owner: 'SALES', name: 'ORDERS' });
    expect(buildParfile(plan, result.jobs[0].request, TARGET).parfile).toContain('#   ALTER TABLE SALES.ORDERS TRUNCATE PARTITION P3 UPDATE INDEXES;');
  });

  it('대상 스키마가 다르면 REMAP_SCHEMA, 비울 테이블도 대상 스키마 쪽', () => {
    const result = planPartitionImportJobs(manifest, ['P3'], { ...IMPORT_OPTIONS, targetOwner: 'sales_dev', truncateBeforeLoad: true }, RANGES, NOW);
    expect(result.jobs[0].request.remapSchemas).toEqual([{ from: 'SALES', to: 'SALES_DEV' }]);
    expect(buildPlan(result.jobs[0].request, NOW).truncateTarget).toEqual({ owner: 'SALES_DEV', name: 'ORDERS' });
  });

  it('대상 파티션 범위가 다르면(예: 분기 파티션) 비우기를 거부 — 다른 기간까지 지워지므로', () => {
    const quarterly = buildRanges(rows([toDate('2026-04-01'), 'MAXVALUE']));
    expect(() => planPartitionImportJobs(manifest, ['P3'], { ...IMPORT_OPTIONS, truncateBeforeLoad: true }, quarterly, NOW)).toThrow(/비우기를 할 수 없습니다/);
    // 비우기 없이 넣는 건 가능
    expect(planPartitionImportJobs(manifest, ['P3'], IMPORT_OPTIONS, quarterly, NOW).jobs[0].truncatePartitions).toEqual([]);
  });

  it('대상 테이블이 없으면 구조 + 데이터여야 하고, 첫 작업이 테이블을 만든다', () => {
    expect(() => planPartitionImportJobs(manifest, ['P3'], IMPORT_OPTIONS, null, NOW)).toThrow(/구조 \+ 데이터/);
    expect(planPartitionImportJobs(manifest, ['P2', 'P3'], { ...IMPORT_OPTIONS, content: 'ALL' }, null, NOW).createsTable).toBe(true);
  });
});
