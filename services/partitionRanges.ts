import type { PartitionRow, PartitionTableInfo } from '../models/dataPumpModel';

// Range 파티션의 기간 계산과 파티션 export 매니페스트 (DB 접근/검증 의존 없는 순수 함수 — 단위 테스트로 검증).
//  - 파티션 범위는 DBA_TAB_PARTITIONS.HIGH_VALUE로 [이전 파티션 HIGH_VALUE, 이 파티션 HIGH_VALUE)를 계산한다.
//  - 경계는 'YYYY-MM-DD HH24:MI:SS' 문자열이라 문자열 비교가 곧 시간 비교.

export interface PartitionRange {
  name: string;
  position: number;
  highValue: string;
  known: boolean; // 하한/상한을 날짜로 해석했는지 (못 하면 기간 선택에서 빠지고 직접 체크만 가능)
  low: string | null; // null = 하한 없음 (첫 파티션)
  high: string | null; // null = MAXVALUE
  numRows: number | null;
  bytes: number;
}

type Bound = { kind: 'MAXVALUE' } | { kind: 'VALUE'; value: string } | { kind: 'UNKNOWN' };

function validDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDay;
}

function fmt(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p2(month)}-${p2(day)} ${p2(hour)}:${p2(minute)}:${p2(second)}`;
}

// 오라클이 HIGH_VALUE에 남기는 형태:
//   DATE      TO_DATE(' 2024-02-01 00:00:00', 'SYYYY-MM-DD HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')
//   TIMESTAMP TIMESTAMP' 2024-02-01 00:00:00'  (WITH TIME ZONE이면 뒤에 존이 붙음 — 존은 무시)
//   문자/숫자 키를 날짜처럼 쓰는 경우  '202402' / '20240201' / 20240201 / '20240201000000' / '2024-02-01' / '2024-02'
//   MAXVALUE
export function parseHighValue(raw: string): Bound {
  const text = raw.trim();
  if (/^MAXVALUE$/i.test(text)) return { kind: 'MAXVALUE' };
  const dt = text.match(/^(?:TO_DATE\(\s*|TIMESTAMP\s*)'\s*(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/i);
  if (dt) {
    const [y, mo, d, h, mi, se] = dt.slice(1).map((v) => Number(v ?? 0));
    return validDate(y, mo, d, h, mi, se) ? { kind: 'VALUE', value: fmt(y, mo, d, h, mi, se) } : { kind: 'UNKNOWN' };
  }
  // 문자 키를 'YYYY-MM-DD' / 'YYYY-MM'로 쓰는 경우도 있다.
  const dashed = text.match(/^'(\d{4})-(\d{2})(?:-(\d{2}))?'$/);
  if (dashed) {
    const [y, mo, d] = [Number(dashed[1]), Number(dashed[2]), Number(dashed[3] ?? 1)];
    return validDate(y, mo, d) ? { kind: 'VALUE', value: fmt(y, mo, d) } : { kind: 'UNKNOWN' };
  }
  const digits = text.match(/^'?(\d{6}|\d{8}|\d{10}|\d{12}|\d{14})'?$/);
  if (digits) {
    const v = digits[1];
    const n = (from: number, len: number, fallback: number) => (v.length >= from + len ? Number(v.substr(from, len)) : fallback);
    const [y, mo, d, h, mi, se] = [n(0, 4, 0), n(4, 2, 1), n(6, 2, 1), n(8, 2, 0), n(10, 2, 0), n(12, 2, 0)];
    return validDate(y, mo, d, h, mi, se) ? { kind: 'VALUE', value: fmt(y, mo, d, h, mi, se) } : { kind: 'UNKNOWN' };
  }
  return { kind: 'UNKNOWN' };
}

// 파티션 순서대로 [이전 상한, 내 상한) 범위를 붙인다.
export function buildRanges(rows: PartitionRow[]): PartitionRange[] {
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  let previous: Bound | null = null; // null = 첫 파티션 (하한 없음)
  return sorted.map((row) => {
    const bound = parseHighValue(row.highValue);
    const prev: Bound | null = previous;
    previous = bound;
    return {
      name: row.name,
      position: row.position,
      highValue: row.highValue,
      known: (prev === null || prev.kind === 'VALUE') && bound.kind !== 'UNKNOWN',
      low: prev !== null && prev.kind === 'VALUE' ? prev.value : null,
      high: bound.kind === 'VALUE' ? bound.value : null,
      numRows: row.numRows,
      bytes: row.bytes,
    };
  });
}

// 기간(from 이상 toExclusive 미만, 각각 null이면 제한 없음)과 겹치는지.
export function overlaps(range: Pick<PartitionRange, 'known' | 'low' | 'high'>, from: string | null, toExclusive: string | null): boolean {
  if (!range.known) return false;
  return (toExclusive === null || range.low === null || range.low < toExclusive) && (from === null || range.high === null || range.high > from);
}

export function sameRange(a: Pick<PartitionRange, 'low' | 'high'>, b: Pick<PartitionRange, 'low' | 'high'>): boolean {
  return a.low === b.low && a.high === b.high;
}

export function rangeLabel(partition: Pick<PartitionRange, 'known' | 'low' | 'high' | 'highValue'>): string {
  if (!partition.known) return `HIGH_VALUE ${partition.highValue}`;
  return `${partition.low ?? '(처음)'} ~ ${partition.high ?? 'MAXVALUE'}`;
}

// 덤프/로그 파일 이름에 쓸 수 있게 ($, # 같은 문자는 _로).
export function safeFilePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

// ── 매니페스트: 파티션 export 결과를 덤프와 같은 DIRECTORY에 남겨 import 화면이 기간으로 고를 수 있게 함 ──

export const MANIFEST_KIND = 'DBC_PARTITION_EXPORT';

export interface PartitionManifestEntry extends PartitionRange {
  dumpfile: string; // 이 파티션이 들어 있는 덤프 (파티션 여러 개를 한 작업으로 묶었으면 같은 덤프를 공유)
}

export interface PartitionManifest {
  kind: typeof MANIFEST_KIND;
  version: 1;
  createdAt: string;
  sourceDb: string;
  owner: string;
  table: string;
  keyColumn: string;
  keyType: string;
  interval: string | null;
  directory: string;
  partitions: PartitionManifestEntry[];
}

export function buildManifest(
  table: PartitionTableInfo,
  sourceDb: string,
  directory: string,
  entries: PartitionManifestEntry[],
  now: Date
): PartitionManifest {
  return {
    kind: MANIFEST_KIND,
    version: 1,
    createdAt: now.toISOString(),
    sourceDb,
    owner: table.owner,
    table: table.name,
    keyColumn: table.keyColumn,
    keyType: table.keyType,
    interval: table.interval,
    directory,
    partitions: [...entries].sort((a, b) => a.position - b.position),
  };
}

// 파티션이 수천 개여도 UTL_FILE 한 줄 길이에 걸리지 않게 파티션마다 한 줄로 쓴다 (내용은 ASCII만).
export function manifestText(manifest: PartitionManifest): string {
  const { partitions, ...head } = manifest;
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  const lines = partitions.map((entry) => `    ${JSON.stringify(entry)}`);
  return `${headText},\n  "partitions": [\n${lines.join(',\n')}\n  ]\n}\n`;
}
