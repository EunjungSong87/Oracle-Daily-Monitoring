import { fail } from './dataPumpErrors';
import { parseLogItems, type LogItem } from './dataPumpLogVerify';
import { itemKey, mapSchema, mapTablespace, placementsFor, remapKey, tableKeyOf, type RemapMapping, type SegmentPlacement } from './dataPumpMigration';
import { parseQualified, sqlName } from './dataPumpNames';

// 이관 검증 (Maintenance > 이관 검증) — DB 접근 없는 순수 함수. 범위(이관한 테이블/파티션)만 본다.
// 키는 정확한 이름의 OWNER.TABLE 또는 OWNER.TABLE:PARTITION. 원본 키를 매핑(REMAP_SCHEMA)하면 대상 키.

export const MAX_SCOPE = 5000;

// 붙여넣은 범위: 한 줄에 OWNER.TABLE[:PARTITION] (SQL 표기). 같은 테이블을 통째로도 적었으면 파티션 줄은 통째에 합친다.
export function parseScopeList(text: string): string[] {
  const lines = text
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (lines.length === 0) fail('검증할 범위를 한 줄에 하나씩 적어 주세요 (OWNER.TABLE 또는 OWNER.TABLE:PARTITION).');
  const keys = lines.map((line) => {
    const parsed = parseQualified(line, '범위');
    return itemKey(parsed.owner, parsed.table, parsed.partition);
  });
  const whole = new Set(keys.filter((key) => !key.includes(':')));
  const result = [...new Set(keys.filter((key) => !key.includes(':') || !whole.has(tableKeyOf(key))))];
  if (result.length > MAX_SCOPE) fail(`범위는 한 번에 ${MAX_SCOPE}개까지 볼 수 있습니다.`);
  return result;
}

export type RowFilterKind = 'NONE' | 'QUERY' | 'SAMPLE' | 'UNKNOWN';

export interface ScopeItem {
  sourceKey: string;
  targetKey: string;
  exportRows: number | null; // Export 로그 행 수 (없으면 null)
  importRows: number | null; // Import 로그 행 수 (Import를 안 돌렸거나 로그에 없으면 null)
  importRan: boolean; // 이 항목을 넣는 Import가 끝났는지 (끝났는데 로그에 없으면 빠진 것)
  rowFilter: RowFilterKind; // Export에 걸린 행 조건 — SAMPLE이면 COUNT 비교 불가
  where: string | null; // QUERY 조건 (원본 COUNT에 같은 WHERE)
}

// Import 로그의 imported 줄 → 대상 키별 행 수 (기준이 파티션 단위인 키는 파티션 단위로)
export function importedRows(targetKeys: string[], items: LogItem[]): Map<string, number> {
  const parts = new Set(targetKeys.filter((key) => key.includes(':')));
  const map = new Map<string, number>();
  for (const item of items) {
    if (item.action !== 'imported') continue;
    const part = item.partition ? itemKey(item.owner, item.table, item.partition) : null;
    const key = part && parts.has(part) ? part : itemKey(item.owner, item.table);
    map.set(key, (map.get(key) ?? 0) + (item.rows ?? 0));
  }
  return map;
}

export function importedRowsFromLog(targetKeys: string[], logText: string): Map<string, number> {
  return importedRows(targetKeys, parseLogItems(logText));
}

export type RowStatus = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

export interface RowCheck {
  sourceKey: string;
  targetKey: string;
  exportRows: number | null;
  importRows: number | null;
  sourceCount: number | null;
  targetCount: number | null;
  status: RowStatus;
  detail: string;
}

// 행 수: 기본은 로그 대조, COUNT를 했으면 그 결과가 우선
export function checkRows(item: ScopeItem, count: { source: number | null; target: number | null; error?: string } | null): RowCheck {
  const base = { sourceKey: item.sourceKey, targetKey: item.targetKey, exportRows: item.exportRows, importRows: item.importRows, sourceCount: count?.source ?? null, targetCount: count?.target ?? null };
  if (count) {
    if (count.error) return { ...base, status: 'UNKNOWN', detail: `COUNT 실패: ${count.error}` };
    if (item.rowFilter === 'SAMPLE') return { ...base, status: 'UNKNOWN', detail: 'SAMPLE로 일부 행만 내보낸 작업이라 COUNT 비교 불가' };
    if (count.source === null || count.target === null) return { ...base, status: 'UNKNOWN', detail: 'COUNT 결과 없음' };
    const where = item.rowFilter === 'QUERY' ? ` (원본은 Export QUERY 조건으로)` : '';
    return count.source === count.target
      ? { ...base, status: 'MATCH', detail: `COUNT 일치 ${count.target}행${where}` }
      : { ...base, status: 'MISMATCH', detail: `COUNT 원본 ${count.source}행 / 대상 ${count.target}행${where}` };
  }
  if (item.exportRows === null) return { ...base, status: 'UNKNOWN', detail: 'Export 로그 없음 — COUNT로 확인하세요' };
  if (item.importRows === null) {
    return item.importRan ? { ...base, status: 'MISMATCH', detail: 'Import 로그에 없음 (빠짐)' } : { ...base, status: 'UNKNOWN', detail: 'Import를 아직 실행하지 않았거나 로그 없음' };
  }
  return item.exportRows === item.importRows
    ? { ...base, status: 'MATCH', detail: `로그 일치 ${item.importRows}행` }
    : { ...base, status: 'MISMATCH', detail: `로그 export ${item.exportRows}행 / import ${item.importRows}행` };
}

// ── 테이블스페이스 위치 ──

export type TablespaceStatus = '일치' | '매핑 누락 의심' | '불일치' | '대상에 없음';

export interface TablespaceCheck {
  kind: SegmentPlacement['kind'];
  table: string; // 대상 OWNER.TABLE
  object: string; // 인덱스 이름 / LOB 컬럼 (테이블 자체면 빈 값)
  partition: string | null;
  subpartition: string | null;
  sourceTablespace: string | null;
  expected: string | null;
  actual: string | null;
  status: TablespaceStatus;
}

const LOB_KINDS = new Set(['LOB', 'LOB_PARTITION', 'LOB_DEFAULT']);
const INDEX_KINDS = new Set(['INDEX', 'INDEX_PARTITION', 'INDEX_DEFAULT']);

// 원본 위치와 대상 위치를 같은 오브젝트끼리 맞춘다: 인덱스는 (소유자→매핑).이름, LOB은 컬럼(세그먼트 이름은 DB마다 다름), 파티션은 이름.
function placementKey(row: SegmentPlacement, owner: (name: string) => string): string {
  const object = INDEX_KINDS.has(row.kind) ? `${owner(row.owner)}.${row.name}` : LOB_KINDS.has(row.kind) ? row.name.split(' (')[0] : '';
  return [row.kind, itemKey(owner(row.tableOwner), row.table), object, row.partition ?? '', row.subpartition ?? ''].join('\u0001');
}

export function compareTablespaces(sourceKeys: string[], sourceRows: SegmentPlacement[], targetRows: SegmentPlacement[], mapping: RemapMapping): TablespaceCheck[] {
  const targetKeys = sourceKeys.map((key) => remapKey(key, mapping));
  const targets = placementsFor(targetKeys, targetRows);
  const sources = placementsFor(sourceKeys, sourceRows);
  const actual = new Map(targets.map((row) => [placementKey(row, (name) => name), row]));
  // 시스템이 붙인 이름(SYS_C… 인덱스)은 DB마다 다르다 — 같은 테이블·종류·파티션에 원본/대상 각각 하나뿐이면 서로 짝짓는다
  const systemGroup = (row: SegmentPlacement, owner: (name: string) => string) => [row.kind, itemKey(owner(row.tableOwner), row.table), row.partition ?? '', row.subpartition ?? ''].join('\u0001');
  const isSystem = (row: SegmentPlacement) => INDEX_KINDS.has(row.kind) && /^SYS_/.test(row.name);
  const systemTargets = new Map<string, SegmentPlacement[]>();
  for (const row of targets.filter((item) => isSystem(item) && ![...sources].some((s) => placementKey(s, (name) => mapSchema(mapping, name)) === placementKey(item, (name) => name)))) {
    const group = systemGroup(row, (name) => name);
    systemTargets.set(group, [...(systemTargets.get(group) ?? []), row]);
  }
  const systemSources = new Map<string, number>();
  for (const row of sources.filter((item) => isSystem(item) && !actual.has(placementKey(item, (name) => mapSchema(mapping, name))))) {
    const group = systemGroup(row, (name) => mapSchema(mapping, name));
    systemSources.set(group, (systemSources.get(group) ?? 0) + 1);
  }
  return sources.map((row) => {
    const key = placementKey(row, (name) => mapSchema(mapping, name));
    let target = actual.get(key);
    if (!target && isSystem(row)) {
      const group = systemGroup(row, (name) => mapSchema(mapping, name));
      const candidates = systemTargets.get(group) ?? [];
      if (candidates.length === 1 && systemSources.get(group) === 1) target = candidates[0];
    }
    const expected = row.tablespace ? mapTablespace(mapping, row.tablespace) : null;
    const base = {
      kind: row.kind,
      table: itemKey(mapSchema(mapping, row.tableOwner), row.table),
      object: INDEX_KINDS.has(row.kind) ? `${mapSchema(mapping, row.owner)}.${row.name}` : LOB_KINDS.has(row.kind) ? row.name.split(' (')[0] : '',
      partition: row.partition,
      subpartition: row.subpartition,
      sourceTablespace: row.tablespace,
      expected,
    };
    if (!target) return { ...base, actual: null, status: '대상에 없음' as const };
    const got = target.tablespace;
    const status: TablespaceStatus = got === expected ? '일치' : got !== null && got === row.tablespace && expected !== row.tablespace ? '매핑 누락 의심' : '불일치';
    return { ...base, actual: got, status };
  });
}

// ── 정리 점검 ──

export type FindingCategory = 'INVALID' | 'UNUSABLE' | 'CONSTRAINT' | 'TRIGGER' | 'NO_STATS' | 'PRIVILEGE';

export interface Finding {
  category: FindingCategory;
  owner: string;
  name: string; // 오브젝트 / 인덱스 / 제약조건 / 트리거 / 테이블 이름
  type: string; // VIEW, PACKAGE BODY, INDEX PARTITION, P/U/R/C, TABLE PARTITION …
  table: string | null; // 관련 테이블 OWNER.TABLE
  partition: string | null;
  detail: string;
}

export interface FindingView extends Finding {
  origin: '원래 그랬음' | '새로 생김';
}

// 시스템 이름(SYS_C…, SYS_IL… 등)은 DB마다 다르므로 테이블 + 유형으로만 맞춘다
function findingKey(finding: Finding, owner: (name: string) => string): string {
  const systemName = /^SYS_/.test(finding.name) && finding.table;
  const table = finding.table ? `${owner(finding.table.split('.')[0])}.${finding.table.split('.').slice(1).join('.')}` : '';
  return [finding.category, owner(finding.owner), systemName ? `#${finding.type}` : finding.name, finding.type, table, finding.partition ?? '', finding.category === 'PRIVILEGE' ? finding.detail : ''].join('\u0001');
}

export function compareFindings(source: Finding[], target: Finding[], mapping: RemapMapping): FindingView[] {
  const before = new Set(source.map((finding) => findingKey(finding, (name) => mapSchema(mapping, name))));
  return target.map((finding) => ({ ...finding, origin: before.has(findingKey(finding, (name) => name)) ? '원래 그랬음' : '새로 생김' }));
}

// 원본에 있던 오브젝트 권한이 대상에 없는 것 (권한을 받은 쪽이 이관한 스키마면 매핑한 이름으로 비교)
export function missingPrivileges(source: { owner: string; table: string; grantee: string; privilege: string }[], target: { owner: string; table: string; grantee: string; privilege: string }[], mapping: RemapMapping): Finding[] {
  const have = new Set(target.map((row) => `${row.owner}.${row.table}|${row.grantee}|${row.privilege}`));
  return source
    .map((row) => ({ ...row, owner: mapSchema(mapping, row.owner), grantee: mapSchema(mapping, row.grantee) }))
    // 매핑 뒤 권한 받는 쪽이 소유자 자신이 되면(원본에서 대상 스키마에 준 권한) 대상에는 있을 수 없는 권한이라 뺀다
    .filter((row) => row.grantee !== row.owner)
    .filter((row) => !have.has(`${row.owner}.${row.table}|${row.grantee}|${row.privilege}`))
    .map((row) => ({
      category: 'PRIVILEGE' as const,
      owner: row.owner,
      name: row.table,
      type: row.privilege,
      table: `${row.owner}.${row.table}`,
      partition: null,
      detail: `${row.grantee}에게 ${row.privilege} (원본에 있던 권한이 없음)`,
    }));
}

// 통계 없는 파티션은 범위에 든 파티션만 (통째 테이블이면 그 테이블의 모든 파티션)
export function scopedFindings(findings: Finding[], keys: string[]): Finding[] {
  const whole = new Set(keys.filter((key) => !key.includes(':')));
  const parts = new Set(keys.filter((key) => key.includes(':')));
  return findings.filter((finding) => {
    if (!finding.partition || !finding.table || finding.category !== 'NO_STATS') return true;
    return whole.has(finding.table) || parts.has(`${finding.table}:${finding.partition}`);
  });
}

// ── 조치 SQL ──

const COMPILABLE: Record<string, (owner: string, name: string) => string> = {
  VIEW: (o, n) => `ALTER VIEW ${sqlName(o)}.${sqlName(n)} COMPILE`,
  'MATERIALIZED VIEW': (o, n) => `ALTER MATERIALIZED VIEW ${sqlName(o)}.${sqlName(n)} COMPILE`,
  PROCEDURE: (o, n) => `ALTER PROCEDURE ${sqlName(o)}.${sqlName(n)} COMPILE`,
  FUNCTION: (o, n) => `ALTER FUNCTION ${sqlName(o)}.${sqlName(n)} COMPILE`,
  PACKAGE: (o, n) => `ALTER PACKAGE ${sqlName(o)}.${sqlName(n)} COMPILE`,
  'PACKAGE BODY': (o, n) => `ALTER PACKAGE ${sqlName(o)}.${sqlName(n)} COMPILE BODY`,
  TRIGGER: (o, n) => `ALTER TRIGGER ${sqlName(o)}.${sqlName(n)} COMPILE`,
  TYPE: (o, n) => `ALTER TYPE ${sqlName(o)}.${sqlName(n)} COMPILE`,
  'TYPE BODY': (o, n) => `ALTER TYPE ${sqlName(o)}.${sqlName(n)} COMPILE BODY`,
  SYNONYM: (o, n) => `ALTER SYNONYM ${sqlName(o)}.${sqlName(n)} COMPILE`,
};

export function compileSql(finding: Pick<Finding, 'owner' | 'name' | 'type'>): string | null {
  return COMPILABLE[finding.type]?.(finding.owner, finding.name) ?? null;
}

export function rebuildSql(finding: Finding): string | null {
  if (finding.category !== 'UNUSABLE') return null;
  return finding.partition
    ? `ALTER INDEX ${sqlName(finding.owner)}.${sqlName(finding.name)} REBUILD PARTITION ${sqlName(finding.partition)};`
    : `ALTER INDEX ${sqlName(finding.owner)}.${sqlName(finding.name)} REBUILD;`;
}

export function statsSql(finding: Finding): string | null {
  if (finding.category !== 'NO_STATS' || !finding.table) return null;
  const [owner, table] = [finding.table.split('.')[0], finding.table.split('.').slice(1).join('.')];
  const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
  return finding.partition
    ? `EXEC DBMS_STATS.GATHER_TABLE_STATS(ownname => ${q(owner)}, tabname => ${q(table)}, partname => ${q(finding.partition)}, granularity => 'PARTITION');`
    : `EXEC DBMS_STATS.GATHER_TABLE_STATS(ownname => ${q(owner)}, tabname => ${q(table)});`;
}

// ── 요약 ──

export interface VerifySummary {
  total: number;
  rows: Record<RowStatus, number>;
  tablespaces: { match: number; mismatch: number; suspect: number; missing: number };
  cleanup: { total: number; new: number; byCategory: Record<FindingCategory, number> };
}

export function summarize(rows: RowCheck[], tablespaces: TablespaceCheck[], findings: FindingView[]): VerifySummary {
  const byCategory: Record<FindingCategory, number> = { INVALID: 0, UNUSABLE: 0, CONSTRAINT: 0, TRIGGER: 0, NO_STATS: 0, PRIVILEGE: 0 };
  for (const finding of findings) byCategory[finding.category]++;
  return {
    total: rows.length,
    rows: { MATCH: rows.filter((r) => r.status === 'MATCH').length, MISMATCH: rows.filter((r) => r.status === 'MISMATCH').length, UNKNOWN: rows.filter((r) => r.status === 'UNKNOWN').length },
    tablespaces: {
      match: tablespaces.filter((t) => t.status === '일치').length,
      mismatch: tablespaces.filter((t) => t.status === '불일치').length,
      suspect: tablespaces.filter((t) => t.status === '매핑 누락 의심').length,
      missing: tablespaces.filter((t) => t.status === '대상에 없음').length,
    },
    cleanup: { total: findings.length, new: findings.filter((f) => f.origin === '새로 생김').length, byCategory },
  };
}
