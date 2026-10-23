import { fail } from './dataPumpErrors';
import { tableFilterStatus, type DataFilter, type ObjectFilter } from './dataPumpFilters';
import { logLines, parseLogItems, type LogItem } from './dataPumpLogVerify';
import { exactName, parseIdentifier, parseParList, parseQualified, sqlName } from './dataPumpNames';
import type { DataPumpPlan } from '../models/dataPumpModel';
import type { DataPumpRequest } from './dataPumpService';

// "Export → Import 생성 → 이관 검증" 흐름의 규칙 (DB 접근 없는 순수 함수 — 단위 테스트로 검증).
// 최우선 원칙: 사용자가 고른 Export/Import 대상이 사용자가 모르는 채로 빠지거나 중복되면 안 된다.
// 기준 목록은 Export 계획이 아니라 "Export 로그에서 실제로 exported된 테이블/파티션"이고, Import parfile → 실행 필터 → Import 로그까지
// 모두 이 목록과 대조한다. 키는 정확한 이름의 OWNER.TABLE 또는 OWNER.TABLE:PARTITION.

export interface DumpFile {
  name: string;
  bytes: number | null; // null = 크기를 모름 (존재만 확인)
}

// Export 이력 한 줄 = 덤프 세트 하나 (스키마별로 나눠 실행한 하위 작업도 각각 한 세트)
export interface ExportDumpSet {
  historyId: number;
  jobName: string;
  bundleJobNo: number | null; // 분할 계획의 작업 번호 (외부 실행이면 null)
  mode: 'SCHEMA' | 'TABLE';
  schemas: string[]; // SCHEMA 모드 대상 (정확한 이름)
  tables: { owner: string; table: string }[]; // TABLE 모드 대상 (VIEWS_AS_TABLES의 뷰 포함)
  directory: string;
  dumpfile: string; // export DUMPFILE 그대로 (%U 포함 가능, 외부 작업은 실제 파일 이름 목록)
  logfile: string;
  status: string; // 이력 상태
  expected: string[] | null; // 계획 대상 (없으면 null — 외부 스키마 작업 등)
  logItems: LogItem[] | null; // 로그의 exported 줄 (못 읽었으면 null)
  dumpFiles: DumpFile[] | null; // 끝날 때 남긴 파일별 크기 (없으면 null)
  rowFilter: 'NONE' | 'QUERY' | 'SAMPLE' | 'UNKNOWN'; // export에 걸린 행 필터 (행 수 COUNT 비교 가능 여부)
  errorSummary: string | null;
}

export interface PlannedJob {
  no: number;
  jobName: string;
  expected: string[];
}

export function itemKey(owner: string, table: string, partition: string | null = null): string {
  return `${owner}.${table}${partition ? `:${partition}` : ''}`;
}

export function tableKeyOf(key: string): string {
  return key.split(':')[0];
}

function splitKey(key: string): { owner: string; table: string; partition: string | null } {
  const [table, partition] = key.split(':');
  const dot = table.indexOf('.');
  return { owner: table.slice(0, dot), table: table.slice(dot + 1), partition: partition ?? null };
}

// 로그의 exported 줄 → 기준 목록 (키 → 행 수). 계획이 파티션 단위(OWNER.T:P)로 고른 테이블은 파티션 단위,
// 그 외는 테이블 단위로 행 수를 합친다 (서브파티션 줄은 파티션으로).
export function baselineOf(set: Pick<ExportDumpSet, 'expected' | 'logItems'>): Map<string, number> {
  const partExpected = new Set((set.expected ?? []).filter((key) => key.includes(':')));
  const map = new Map<string, number>();
  for (const item of set.logItems ?? []) {
    if (item.action !== 'exported') continue;
    const table = itemKey(item.owner, item.table);
    const part = item.partition ? itemKey(item.owner, item.table, item.partition) : null;
    const key = part && partExpected.has(part) ? part : table;
    map.set(key, (map.get(key) ?? 0) + (item.rows ?? 0));
  }
  return map;
}

export interface DumpSetAssessment {
  set: ExportDumpSet;
  baseline: Map<string, number>;
  blockers: string[]; // 이 덤프 세트로는 Import를 만들 수 없는 이유
  warnings: string[];
}

export interface ExportAssessment {
  sets: DumpSetAssessment[];
  exportGaps: string[]; // 계획에 있는데 Export 로그에 없음 (에러로 안 나간 것) — Import 생성 차단
  notRun: PlannedJob[]; // 분할 계획에 있는데 실행 기록이 없는 작업 — 빠지는 목록으로 확인을 받아야 함
  duplicates: string[]; // 두 덤프 세트에 같은 테이블/파티션 — 차단
  blocked: boolean;
}

const FINISHED_OK = ['COMPLETED', 'COMPLETED_WITH_ERRORS'];

// 불변식 1 (+ 2의 묶음 완전성): Export 묶음 전체를 로그 기준으로 평가한다.
export function assessExport(planned: PlannedJob[] | null, rawSets: ExportDumpSet[]): ExportAssessment {
  // 같은 작업 이름을 다시 돌렸으면 가장 최근 것만
  const latest = new Map<string, ExportDumpSet>();
  for (const set of rawSets) if (!latest.has(set.jobName) || latest.get(set.jobName)!.historyId < set.historyId) latest.set(set.jobName, set);
  const sets = [...latest.values()].sort((a, b) => (a.bundleJobNo ?? 0) - (b.bundleJobNo ?? 0) || a.jobName.localeCompare(b.jobName));

  const exportGaps: string[] = [];
  const assessed = sets.map((set): DumpSetAssessment => {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const baseline = baselineOf(set);
    if (set.status === 'RUNNING') blockers.push('Export가 아직 진행 중입니다.');
    else if (!FINISHED_OK.includes(set.status)) blockers.push(`Export 결과가 ${set.status}입니다.`);
    if (set.logItems === null) blockers.push('Export 로그를 읽지 못해(또는 대조 정보 없음) 실제로 나간 목록을 알 수 없습니다.');
    if (set.status === 'COMPLETED_WITH_ERRORS') warnings.push(`Export가 에러와 함께 끝났습니다${set.errorSummary ? `: ${set.errorSummary}` : ''}`);
    if (set.logItems !== null && set.expected) {
      for (const key of set.expected) {
        const present = key.includes(':') ? baseline.has(key) : baseline.has(key);
        if (!present) exportGaps.push(`${key} (${set.jobName}): 계획에 있는데 Export 로그에 없음`);
      }
      const planned = new Set(set.expected);
      const extra = [...baseline.keys()].filter((key) => !planned.has(key));
      if (extra.length > 0) warnings.push(`계획에 없던 ${extra.length}개가 Export 로그에 있어 함께 가져옵니다: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}`);
    }
    if (set.logItems !== null && !set.expected) warnings.push('계획 목록이 없는 작업(직접 실행 등)이라 "계획엔 있는데 빠짐"은 대조할 수 없고, 로그에 나간 목록 기준으로만 진행합니다.');
    if (set.rowFilter === 'QUERY' || set.rowFilter === 'SAMPLE') warnings.push(`Export에 ${set.rowFilter} 조건이 있어 원본 전체 행이 아닙니다.`);
    if (set.rowFilter === 'UNKNOWN') warnings.push('Export에 걸린 행 필터(QUERY/SAMPLE)를 알 수 없습니다.');
    if (expectedDumpFiles(set) === null) blockers.push('덤프 파일 목록/크기 정보가 없어 파일을 확인할 수 없습니다 (스크립트 적용 전 작업이거나 로그를 못 읽음).');
    return { set, baseline, blockers, warnings };
  });

  const notRun = (planned ?? []).filter((job) => !sets.some((set) => set.bundleJobNo === job.no));

  // 같은 테이블이 두 덤프 세트에: 통째끼리, 통째+파티션, 같은 파티션 — 그대로 두 번 가져오게 된다
  const owners = new Map<string, { whole: string[]; parts: Map<string, string[]> }>();
  for (const { set, baseline } of assessed) {
    for (const key of baseline.keys()) {
      const table = tableKeyOf(key);
      const entry = owners.get(table) ?? { whole: [], parts: new Map<string, string[]>() };
      if (key.includes(':')) entry.parts.set(key, [...(entry.parts.get(key) ?? []), set.jobName]);
      else entry.whole.push(set.jobName);
      owners.set(table, entry);
    }
  }
  const duplicates: string[] = [];
  for (const [table, entry] of owners) {
    const partJobs = [...new Set([...entry.parts.values()].flat())];
    if (entry.whole.length > 1 || (entry.whole.length === 1 && partJobs.some((job) => job !== entry.whole[0]))) {
      duplicates.push(`${table}: ${[...new Set([...entry.whole, ...partJobs])].join(', ')}`);
      continue;
    }
    for (const [part, jobs] of entry.parts) if (jobs.length > 1) duplicates.push(`${part}: ${jobs.join(', ')}`);
  }

  const blocked = assessed.some((item) => item.blockers.length > 0) || exportGaps.length > 0 || duplicates.length > 0 || assessed.length === 0;
  return { sets: assessed, exportGaps, notRun, duplicates, blocked };
}

// 덤프 파일 기대 목록: 끝날 때 남긴 파일별 크기, 없으면 %U 없는 이름(들)만 (크기 모름). 둘 다 안 되면 null.
export function expectedDumpFiles(set: Pick<ExportDumpSet, 'dumpFiles' | 'dumpfile'>): DumpFile[] | null {
  if (set.dumpFiles && set.dumpFiles.length > 0) return set.dumpFiles;
  if (!set.dumpfile || /%U/i.test(set.dumpfile)) return null;
  return set.dumpfile
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, bytes: null }));
}

// 일부 덤프 세트만 고르면 빠지는 항목 (안 고른 세트의 기준 목록 + 실행 안 된 계획 작업의 목록) — 사용자가 확인해야 한다.
export function omittedItems(assessment: ExportAssessment, selectedHistoryIds: number[]): string[] {
  const selected = new Set(selectedHistoryIds);
  const items = assessment.sets.filter((item) => !selected.has(item.set.historyId)).flatMap((item) => [...item.baseline.keys()].map((key) => `${key} (${item.set.jobName})`));
  for (const job of assessment.notRun) items.push(...job.expected.map((key) => `${key} (${job.jobName} — Export 실행 기록 없음)`));
  return items.sort();
}

// ── 매핑 (REMAP_SCHEMA / REMAP_TABLESPACE) ──

// keep = "그대로 사용" (명시적으로 고른 것). keep이 아니고 to가 비었으면 미입력 → 생성 불가.
export interface MappingRow {
  from: string;
  to: string;
  keep: boolean;
}

export interface RemapMapping {
  schemas: MappingRow[];
  tablespaces: MappingRow[];
}

// 화면이 보낸 매핑을 정확한 이름으로 정리한다. from은 정확한 이름, to는 SQL 표기(따옴표 가능)로 받는다.
export function normalizeMapping(raw: unknown): RemapMapping {
  const rows = (value: unknown, label: string): MappingRow[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) fail(`${label} 매핑 형식이 올바르지 않습니다.`);
    const seen = new Set<string>();
    return value.map((row) => {
      const from = exactName(row?.from, `${label} 원본`);
      if (seen.has(from)) fail(`${label} 매핑에 ${sqlName(from)}이(가) 두 번 있습니다.`);
      seen.add(from);
      const keep = row?.keep === true;
      const text = typeof row?.to === 'string' ? row.to.trim() : '';
      return { from, keep, to: keep || text === '' ? '' : parseIdentifier(text, `${label} 대상`) };
    });
  };
  const data = (raw ?? {}) as { schemas?: unknown; tablespaces?: unknown };
  return { schemas: rows(data.schemas, 'REMAP_SCHEMA'), tablespaces: rows(data.tablespaces, 'REMAP_TABLESPACE') };
}

function mapped(rows: MappingRow[], name: string): string | null {
  const row = rows.find((item) => item.from === name);
  if (!row) return null;
  if (row.keep) return name;
  return row.to || null;
}

export function mapSchema(mapping: RemapMapping, owner: string): string {
  return mapped(mapping.schemas, owner) ?? owner;
}

export function mapTablespace(mapping: RemapMapping, tablespace: string): string {
  return mapped(mapping.tablespaces, tablespace) ?? tablespace;
}

// 매핑 표의 모든 행은 "그대로 사용" 또는 대상 이름이 있어야 한다 (비어 있는 행이 있으면 생성 불가).
export function unmapped(owners: string[], tablespaces: string[], mapping: RemapMapping): string[] {
  const missing: string[] = [];
  for (const owner of owners) if (mapped(mapping.schemas, owner) === null) missing.push(`REMAP_SCHEMA ${sqlName(owner)}: 매핑 없음 ("그대로 사용" 또는 대상 스키마를 고르세요)`);
  for (const ts of tablespaces) if (mapped(mapping.tablespaces, ts) === null) missing.push(`REMAP_TABLESPACE ${sqlName(ts)}: 매핑 없음 ("그대로 사용" 또는 대상 테이블스페이스를 고르세요)`);
  return missing;
}

export function remapKey(key: string, mapping: RemapMapping): string {
  const { owner, table, partition } = splitKey(key);
  return itemKey(mapSchema(mapping, owner), table, partition);
}

// REMAP_SCHEMA로 서로 다른 원본이 같은 대상 이름이 되는 경우 (A.T, B.T → X.T) — 하나가 다른 하나를 덮거나 건너뛰게 된다.
export function remapCollisions(keys: string[], mapping: RemapMapping): string[] {
  const byTarget = new Map<string, Set<string>>();
  for (const key of keys) {
    const table = tableKeyOf(key);
    const target = tableKeyOf(remapKey(key, mapping));
    byTarget.set(target, (byTarget.get(target) ?? new Set()).add(table));
  }
  return [...byTarget]
    .filter(([, sources]) => sources.size > 1)
    .map(([target, sources]) => `${[...sources].sort().join(', ')} → ${target}`);
}

// ── Import 작업 만들기 ──

export interface ImportBuildOptions {
  directory: string; // 대상 DB의 DIRECTORY (덤프를 옮겨 둔 곳)
  parallel: number;
  content: 'ALL' | 'DATA_ONLY' | 'METADATA_ONLY';
  excludeStatistics: boolean;
  metrics?: boolean; // METRICS=YES (12c 이상)
  logtime?: 'NONE' | 'STATUS' | 'LOGFILE' | 'ALL' | null; // LOGTIME (12c 이상)
  tableExistsAction: 'SKIP' | 'APPEND' | 'TRUNCATE' | 'REPLACE';
  objectFilter?: ObjectFilter | null; // 사용자가 추가한 대상 축소 조건 (불변식 4로 확인)
  dataFilter?: DataFilter | null;
  stamp: string; // 작업 이름용 시각 (YYYYMMDDHH24MISS)
}

export interface MigrationImportJob {
  no: number;
  historyId: number; // 원본 Export 덤프 세트
  exportJobName: string;
  request: DataPumpRequest;
  baseline: Record<string, number>; // 원본 키 → Export 로그 행 수
  sourceKeys: string[];
  targetKeys: string[]; // REMAP 반영
  remap: { from: string; to: string }[]; // 정확한 이름
  expectedSchemas: string[]; // 실행 필터 검증용 (SCHEMA 모드)
  expectedTables: string[]; // 실행 필터 검증용 (TABLE 모드, OWNER.TABLE 원본 이름)
  waitFor: string[]; // 먼저 끝나야 하는 작업 (같은 테이블의 다른 파티션 덤프 — 먼저 넣은 작업이 테이블을 만든다)
  notes: string[];
}

export function setOwners(set: Pick<ExportDumpSet, 'mode' | 'schemas' | 'tables'>): string[] {
  return set.mode === 'SCHEMA' ? [...set.schemas] : [...new Set(set.tables.map((pair) => pair.owner))].sort();
}

// 덤프 세트 하나 → impdp 작업 하나 (1:1). DUMPFILE은 export와 같은 패턴, LOGFILE은 imp_ 접두어, 대상은 export의 TABLES/SCHEMAS 그대로.
export function buildImportJobs(
  selected: DumpSetAssessment[],
  mapping: RemapMapping,
  tablespacesBySet: Map<number, string[]>,
  options: ImportBuildOptions,
  truncateBySet: Map<number, string[]> = new Map()
): MigrationImportJob[] {
  const digits = Math.max(2, String(selected.length).length);
  const jobNameOf = (index: number) => `DBC_IMP_${options.stamp}_${String(index + 1).padStart(digits, '0')}`;
  // 같은 테이블의 파티션이 덤프 여러 개에 나뉜 경우: 첫 작업이 테이블을 만들고 나머지는 이미 있는 테이블에 넣는다.
  //   SKIP → 두 번째부터 테이블째 건너뜀(파티션이 빠짐), REPLACE/TRUNCATE → 먼저 넣은 파티션이 지워짐
  //   → 이 덤프들은 APPEND로 만들고 순서대로 실행하게 한다 (REPLACE/TRUNCATE를 골랐으면 거부).
  const holders = new Map<string, number[]>();
  selected.forEach(({ baseline }, index) => {
    for (const table of new Set([...baseline.keys()].map(tableKeyOf))) holders.set(table, [...(holders.get(table) ?? []), index]);
  });
  const shared = [...holders].filter(([, indexes]) => indexes.length > 1);
  if (shared.length > 0 && (options.tableExistsAction === 'REPLACE' || options.tableExistsAction === 'TRUNCATE')) {
    fail(
      '같은 테이블이 여러 덤프에 나뉘어 있어 이 TABLE_EXISTS_ACTION으로는 만들 수 없습니다.',
      shared.map(
        ([table, indexes]) =>
          `${table}: 덤프 ${indexes.length}개(${indexes.map((i) => selected[i].set.jobName).join(', ')})에 나뉘어 있어 TABLE_EXISTS_ACTION=${options.tableExistsAction}면 먼저 넣은 파티션이 지워집니다 — SKIP/APPEND(또는 파티션 비우고 넣기)로 만드세요`
      )
    );
  }
  return selected.map(({ set, baseline }, index) => {
    const no = index + 1;
    const mineShared = shared.filter(([, indexes]) => indexes.includes(index));
    const waitFor = [...new Set(mineShared.flatMap(([, indexes]) => indexes.filter((other) => other < index)))].sort((a, b) => a - b).map(jobNameOf);
    const notes = mineShared.length > 0 ? [`${mineShared.map(([table]) => table).join(', ')}이(가) 다른 덤프에도 나뉘어 있어 APPEND로 넣습니다${waitFor.length > 0 ? ` (먼저 ${waitFor.join(', ')}이(가) 끝나야 실행)` : ' (이 작업이 먼저)'}`] : [];
    const owners = setOwners(set);
    const remap = owners.map((owner) => ({ from: owner, to: mapSchema(mapping, owner) })).filter((pair) => pair.to !== pair.from);
    const tsRemap = (tablespacesBySet.get(set.historyId) ?? [])
      .map((ts) => ({ from: ts, to: mapTablespace(mapping, ts) }))
      .filter((pair) => pair.to !== pair.from);
    const truncate = truncateBySet.get(set.historyId) ?? [];
    const request: DataPumpRequest = {
      operation: 'IMPORT',
      mode: set.mode,
      ...(set.mode === 'SCHEMA'
        ? { schemas: set.schemas.map(sqlName) }
        : { qualifiedTables: set.tables.map((pair) => ({ owner: sqlName(pair.owner), table: sqlName(pair.table) })) }),
      directory: options.directory,
      dumpfile: set.dumpfile,
      logfile: `imp_${set.logfile}`,
      jobName: jobNameOf(index),
      parallel: options.parallel,
      content: options.content,
      excludeStatistics: options.excludeStatistics,
      metrics: !!options.metrics,
      logtime: options.logtime ?? null,
      tableExistsAction: truncate.length > 0 || mineShared.length > 0 ? 'APPEND' : options.tableExistsAction,
      remapSchemas: remap.map((pair) => ({ from: sqlName(pair.from), to: sqlName(pair.to) })),
      remapTablespaces: tsRemap.map((pair) => ({ from: sqlName(pair.from), to: sqlName(pair.to) })),
      truncatePartitions: truncate.map(sqlName),
      objectFilter: options.objectFilter ?? null,
      dataFilter: options.dataFilter ?? null,
    };
    const sourceKeys = [...baseline.keys()].sort();
    return {
      no,
      historyId: set.historyId,
      exportJobName: set.jobName,
      request,
      baseline: Object.fromEntries(baseline),
      sourceKeys,
      targetKeys: sourceKeys.map((key) => remapKey(key, mapping)),
      remap,
      expectedSchemas: set.mode === 'SCHEMA' ? [...set.schemas].sort() : [],
      expectedTables: set.mode === 'TABLE' ? [...new Set(set.tables.map((pair) => itemKey(pair.owner, pair.table)))].sort() : [],
      waitFor,
      notes,
    };
  });
}

// 불변식 3 (parfile 원문 기준): 만든 impdp parfile들을 다시 읽어, 대상 합(REMAP 반영 후 이름)이 기준 목록과 정확히 같은지.
// SCHEMAS=는 그 덤프의 기준 목록 중 그 스키마 것 전부, TABLES=는 그 테이블(파티션 포함)을 덮는다 — 스키마 작업과
// 떼어 낸 큰 테이블의 TABLES= 작업을 합쳐서 본다. 빠짐/중복/대상 밖이 하나라도 있으면 전체 목록과 함께 거부.
export function assertImportParfilesCover(jobs: { jobName: string; parfile: string; sourceKeys: string[] }[], expectedTargets: string[]): void {
  const counts = new Map<string, string[]>();
  const problems: string[] = [];
  for (const job of jobs) {
    const lines = job.parfile.split('\n');
    const listOf = (name: string) => lines.filter((line) => line.startsWith(`${name}=`)).flatMap((line) => parseParList(line.slice(name.length + 1)));
    const schemas = listOf('SCHEMAS').map((item) => parseIdentifier(item, '스키마'));
    const tables = listOf('TABLES').map((item) => parseQualified(item));
    const remap = new Map(
      listOf('REMAP_SCHEMA').map((item) => {
        const [from, to] = item.split(/:(?=[^:]*$)/);
        return [parseIdentifier(from, 'REMAP_SCHEMA 원본'), parseIdentifier(to, 'REMAP_SCHEMA 대상')] as const;
      })
    );
    const covered = new Set<string>();
    for (const schema of schemas) {
      const hit = job.sourceKeys.filter((key) => splitKey(key).owner === schema);
      if (hit.length === 0) problems.push(`${job.jobName}: SCHEMAS=${sqlName(schema)}에 해당하는 기준 항목이 없음 (대상 밖)`);
      hit.forEach((key) => covered.add(key));
    }
    for (const entry of tables) {
      const table = itemKey(entry.owner, entry.table);
      const hit = job.sourceKeys.filter((key) => tableKeyOf(key) === table && (!entry.partition || key === itemKey(entry.owner, entry.table, entry.partition)));
      if (hit.length === 0) problems.push(`${job.jobName}: TABLES=${sqlName(entry.owner)}.${sqlName(entry.table)}이(가) 이 덤프의 기준 목록에 없음 (대상 밖)`);
      hit.forEach((key) => covered.add(key));
    }
    for (const key of covered) {
      const { owner, table, partition } = splitKey(key);
      const target = itemKey(remap.get(owner) ?? owner, table, partition);
      counts.set(target, [...(counts.get(target) ?? []), job.jobName]);
    }
  }
  const expected = new Set(expectedTargets);
  for (const key of expectedTargets) if (!counts.has(key)) problems.push(`${key}: Import parfile에서 빠짐`);
  for (const [key, jobNames] of counts) {
    if (jobNames.length > 1) problems.push(`${key}: Import parfile에 두 번 들어감 (${jobNames.join(', ')})`);
    if (!expected.has(key)) problems.push(`${key}: 기준 목록 밖 (REMAP이 매핑과 다르거나 대상 밖 항목)`);
  }
  if (problems.length > 0) fail(`Import parfile 검증 실패 — ${problems.length}건 (목록 참고). 생성하지 않았습니다.`, problems);
}

// 불변식 4: 사용자가 Import에 추가한 대상 축소 조건(INCLUDE/EXCLUDE, QUERY, SAMPLE)으로 빠지거나 줄어드는 것.
export interface FilterImpact {
  excluded: string[]; // 오브젝트 필터로 빠지는 테이블 (확인 필요)
  unknown: string[]; // 서브쿼리 등으로 미리 계산할 수 없는 테이블 (경고)
  rowFilters: string[]; // QUERY/SAMPLE — 행 수가 Export와 달라짐 (경고)
}

export function filterImpact(tables: string[], objectFilter: ObjectFilter | null | undefined, dataFilter: DataFilter | null | undefined): FilterImpact {
  const excluded: string[] = [];
  const unknown: string[] = [];
  for (const key of [...new Set(tables.map(tableKeyOf))].sort()) {
    const { owner, table } = splitKey(key);
    const status = tableFilterStatus(objectFilter, owner, table);
    if (status === 'EXCLUDED') excluded.push(key);
    else if (status === 'UNKNOWN') unknown.push(key);
  }
  const rowFilters = [
    ...(dataFilter?.queries ?? []).map((q) => `QUERY ${q.owner && q.table ? `${q.owner}.${q.table}` : '(모든 테이블)'}: ${q.where}`),
    ...(dataFilter?.samples ?? []).map((s) => `SAMPLE ${s.owner && s.table ? `${s.owner}.${s.table}` : '(모든 테이블)'}: ${s.percent}%`),
  ];
  return { excluded, unknown, rowFilters };
}

// 불변식 5: 앱이 DBMS_DATAPUMP로 직접 실행할 때 거는 필터(SCHEMA_EXPR/NAME_EXPR, REMAP)가 고르는 대상이 생성 때의 기준과 같은지.
// (Export의 assertExecutionWithinList와 같은 방식 — parfile과 같은 buildPlan에서 나온 실행 계획을 다시 읽는다.)
export function assertImportExecution(
  plan: DataPumpPlan,
  runs: DataPumpPlan[],
  expected: { mode: 'SCHEMA' | 'TABLE'; schemas: string[]; tables: string[]; remap: { from: string; to: string }[] }
): void {
  const list = (expr: string | null) => (expr ? expr.replace(/^(NOT )?IN \(|\)$/g, '').split(',').map((item) => item.trim().replace(/^'|'$/g, '')) : []);
  const problems: string[] = [];
  if (plan.operation !== 'IMPORT' || plan.jobMode !== expected.mode) problems.push(`작업 모드가 다름 (${plan.operation}/${plan.jobMode}, 기대 IMPORT/${expected.mode})`);
  const compare = (label: string, want: string[], got: string[]) => {
    const wantSet = new Set(want);
    const gotCounts = got.reduce((map, item) => map.set(item, (map.get(item) ?? 0) + 1), new Map<string, number>());
    for (const item of want) if (!gotCounts.has(item)) problems.push(`${label}: ${item} 빠짐`);
    for (const [item, n] of gotCounts) {
      if (!wantSet.has(item)) problems.push(`${label}: ${item} 대상 밖`);
      if (n > 1) problems.push(`${label}: ${item} 두 번`);
    }
  };
  if (expected.mode === 'SCHEMA') {
    compare('실행 SCHEMA_EXPR', expected.schemas, runs.flatMap((run) => list(run.schemaExpr)));
    if (runs.some((run) => run.excludeTableExpr || run.nameExpr)) problems.push('스키마 Import에 테이블 이름 필터가 걸려 있음');
  } else {
    compare(
      '실행 SCHEMA_EXPR × NAME_EXPR',
      expected.tables,
      runs.flatMap((run) => list(run.schemaExpr).flatMap((schema) => list(run.nameExpr).map((name) => itemKey(schema, name))))
    );
  }
  if (runs.some((run) => run.partitionFilters.length > 0)) problems.push('Import 실행에 파티션 필터가 걸려 있음');
  if (runs.some((run) => run.dumpfile !== plan.dumpfile)) problems.push('실행 작업의 DUMPFILE이 Export 덤프와 다름');
  compare('REMAP_SCHEMA', expected.remap.map((pair) => `${pair.from}:${pair.to}`), plan.remapSchemas.map((pair) => `${pair.from}:${pair.to}`));
  if (problems.length > 0) fail(`실행 필터 검증 실패 — 생성한 Import와 다릅니다. 실행하지 않았습니다.`, problems);
}

// 불변식 6: 실행 후 Import 로그의 imported 목록·행 수를 Export 로그(기준)와 대조. ORA- 줄에 나온 테이블도 따로 모은다.
export interface ImportVerify {
  status: 'MATCH' | 'MISMATCH';
  missing: string[];
  rowDiffs: string[];
  errorTables: string[];
  extra: string[];
}

const QUOTED_OBJECT = /"([^"]+)"\."([^"]+)"(?::"([^"]+)")?/g;

export function verifyMigrationImport(baseline: Record<string, number>, remap: { from: string; to: string }[], logText: string): ImportVerify {
  const remapOwner = new Map(remap.map((pair) => [pair.from, pair.to]));
  const expected = new Map<string, number>();
  for (const [key, rows] of Object.entries(baseline)) {
    const { owner, table, partition } = splitKey(key);
    expected.set(itemKey(remapOwner.get(owner) ?? owner, table, partition), rows);
  }
  const imported = new Map<string, number>();
  for (const item of parseLogItems(logText)) {
    if (item.action !== 'imported') continue;
    const part = item.partition ? itemKey(item.owner, item.table, item.partition) : null;
    const key = part && expected.has(part) ? part : itemKey(item.owner, item.table);
    imported.set(key, (imported.get(key) ?? 0) + (item.rows ?? 0));
  }
  const missing = [...expected.keys()].filter((key) => !imported.has(key)).sort();
  const rowDiffs = [...expected]
    .filter(([key, rows]) => imported.has(key) && imported.get(key) !== rows)
    .map(([key, rows]) => `${key}: export ${rows}행 / import ${imported.get(key)}행`);
  const extra = [...imported.keys()].filter((key) => !expected.has(key)).sort();
  const errorTables = new Set<string>();
  const expectedTables = new Set([...expected.keys()].map(tableKeyOf));
  for (const line of logLines(logText)) {
    if (!/ORA-\d{5}/.test(line)) continue;
    for (const match of line.matchAll(QUOTED_OBJECT)) {
      const table = itemKey(match[1], match[2]);
      if (expectedTables.has(table)) errorTables.add(match[3] && expected.has(itemKey(match[1], match[2], match[3])) ? itemKey(match[1], match[2], match[3]) : table);
    }
  }
  const status = missing.length === 0 && rowDiffs.length === 0 && errorTables.size === 0 && extra.length === 0 ? 'MATCH' : 'MISMATCH';
  return { status, missing, rowDiffs, errorTables: [...errorTables].sort(), extra };
}

// 묶음 전체 기준 Import 상태: 만든 작업 중 실행 안 된 게 있거나 확인하고 뺀 게 있으면 미완료, 하나라도 불일치면 불일치.
export function bundleImportStatus(
  jobs: { status: string | null; verifyStatus: string | null }[],
  omittedCount: number
): { status: '미완료' | '진행 중' | '불일치' | '완료'; reason: string } {
  const notRun = jobs.filter((job) => job.status === null).length;
  if (jobs.some((job) => job.status === 'RUNNING')) return { status: '진행 중', reason: `${jobs.filter((job) => job.status === 'RUNNING').length}개 진행 중` };
  const bad = jobs.filter((job) => job.status !== null && (job.verifyStatus !== 'MATCH' || !FINISHED_OK.includes(job.status)));
  if (bad.length > 0) return { status: '불일치', reason: `${bad.length}개 작업이 기준과 다름` };
  if (notRun > 0) return { status: '미완료', reason: `${notRun}개 작업을 아직 실행하지 않음` };
  if (omittedCount > 0) return { status: '미완료', reason: `확인하고 뺀 항목 ${omittedCount}개` };
  return { status: '완료', reason: '모든 작업이 기준과 일치' };
}

// 대상 서버 DIRECTORY의 덤프 파일 확인: 없거나 크기가 다르면 실행 불가.
export interface DumpFileCheckRow {
  jobName: string;
  name: string;
  expected: number | null;
  actual: number | null;
  status: 'OK' | 'MISSING' | 'SIZE_DIFF' | 'NO_SIZE';
}

export function checkDumpFiles(sets: { jobName: string; files: DumpFile[] }[], actual: Record<string, number | undefined>): { rows: DumpFileCheckRow[]; blocked: boolean } {
  const rows = sets.flatMap(({ jobName, files }) =>
    files.map((file): DumpFileCheckRow => {
      const size = actual[file.name];
      if (size === undefined) return { jobName, name: file.name, expected: file.bytes, actual: null, status: 'MISSING' };
      if (file.bytes === null) return { jobName, name: file.name, expected: null, actual: size, status: 'NO_SIZE' };
      return { jobName, name: file.name, expected: file.bytes, actual: size, status: size === file.bytes ? 'OK' : 'SIZE_DIFF' };
    })
  );
  return { rows, blocked: rows.length === 0 || rows.some((row) => row.status === 'MISSING' || row.status === 'SIZE_DIFF') };
}

// ── 테이블스페이스 위치 ──

export type SegmentKind =
  | 'TABLE'
  | 'TABLE_PARTITION'
  | 'TABLE_SUBPARTITION'
  | 'TABLE_DEFAULT'
  | 'INDEX'
  | 'INDEX_PARTITION'
  | 'INDEX_DEFAULT'
  | 'LOB'
  | 'LOB_PARTITION'
  | 'LOB_DEFAULT';

// 원본 DB의 DBA_TABLES/…/DBA_LOB_PARTITIONS에서 읽은 위치 한 줄. (owner, table) = 기준 테이블, name = 인덱스/LOB 세그먼트 이름.
export interface SegmentPlacement {
  kind: SegmentKind;
  owner: string; // 오브젝트 소유자 (인덱스는 인덱스 소유자)
  tableOwner: string;
  table: string;
  name: string;
  partition: string | null; // 테이블 파티션 (LOB 파티션은 테이블 파티션 이름), 인덱스 파티션 이름
  subpartition: string | null;
  tablespace: string | null; // 파티션 테이블의 테이블 행 등은 null
}

// 기준 목록(키)에 해당하는 위치만: 통째 테이블이면 그 테이블의 전부, 파티션이면 그 파티션(서브파티션·LOB 파티션 포함)과 테이블 수준(기본값·인덱스).
export function placementsFor(keys: string[], rows: SegmentPlacement[]): SegmentPlacement[] {
  const whole = new Set(keys.filter((key) => !key.includes(':')));
  const parts = new Set(keys.filter((key) => key.includes(':')));
  const partTables = new Set([...parts].map(tableKeyOf));
  return rows.filter((row) => {
    const table = itemKey(row.tableOwner, row.table);
    if (whole.has(table)) return true;
    if (!partTables.has(table)) return false;
    if (row.kind === 'TABLE_PARTITION' || row.kind === 'TABLE_SUBPARTITION' || row.kind === 'LOB_PARTITION') return parts.has(itemKey(row.tableOwner, row.table, row.partition));
    return true; // 테이블 수준 기본값, 인덱스(로컬 인덱스 파티션 이름은 테이블 파티션과 다를 수 있어 모두 포함)
  });
}

export function tablespacesOf(rows: SegmentPlacement[]): string[] {
  return [...new Set(rows.map((row) => row.tablespace).filter((ts): ts is string => !!ts))].sort();
}

// 이 위치가 매핑 후 들어가야 할 테이블스페이스
export function expectedTablespace(row: SegmentPlacement, mapping: RemapMapping): string | null {
  return row.tablespace ? mapTablespace(mapping, row.tablespace) : null;
}

// 들어갈 크기를 (대상 소유자, 대상 테이블스페이스)별로: 크기는 이력의 계획 크기(테이블 = 테이블+LOB, 파티션 = 파티션).
// 테이블스페이스를 파티션/서브파티션이 나눠 가지면 고르게 나눈다(근사). 인덱스 크기는 이력에 없어 포함하지 않는다.
export function requiredBytes(
  sizes: { key: string; bytes: number }[],
  rows: SegmentPlacement[],
  mapping: RemapMapping
): { entries: { owner: string; tablespace: string; bytes: number }[]; unknown: string[] } {
  const total = new Map<string, number>();
  const unknown: string[] = [];
  const add = (owner: string, ts: string, bytes: number) => {
    const key = `${mapSchema(mapping, owner)}\u0001${mapTablespace(mapping, ts)}`;
    total.set(key, (total.get(key) ?? 0) + bytes);
  };
  for (const { key, bytes } of sizes) {
    const { owner, table, partition } = splitKey(key);
    const mine = rows.filter((row) => row.tableOwner === owner && row.table === table);
    let homes: string[];
    if (partition) {
      const part = mine.find((row) => row.kind === 'TABLE_PARTITION' && row.partition === partition);
      homes = part?.tablespace ? [part.tablespace] : mine.filter((row) => row.kind === 'TABLE_SUBPARTITION' && row.partition === partition && row.tablespace).map((row) => row.tablespace as string);
    } else {
      const tableRow = mine.find((row) => row.kind === 'TABLE');
      homes = tableRow?.tablespace
        ? [tableRow.tablespace]
        : mine.filter((row) => (row.kind === 'TABLE_PARTITION' || row.kind === 'TABLE_SUBPARTITION') && row.tablespace).map((row) => row.tablespace as string);
    }
    if (homes.length === 0) {
      unknown.push(key);
      continue;
    }
    for (const ts of homes) add(owner, ts, bytes / homes.length);
  }
  return {
    entries: [...total].map(([key, bytes]) => {
      const [owner, tablespace] = key.split('\u0001');
      return { owner, tablespace, bytes: Math.round(bytes) };
    }),
    unknown,
  };
}

// ── Import 전 사전 점검 (대상 DB에서 읽은 값으로 판정) ──

export interface PrecheckInput {
  owners: string[]; // REMAP 반영 후 대상 스키마
  existingUsers: string[];
  tablespaces: string[]; // 매핑 반영 후 대상 테이블스페이스
  existingTablespaces: string[];
  required: { owner: string; tablespace: string; bytes: number }[];
  sizeUnknown: string[]; // 크기를 몰라 합산에서 빠진 항목
  freeBytes: Record<string, number>; // DBA_TABLESPACE_USAGE_METRICS: (자동 확장 최대 크기 - 사용) × 블록 크기
  quotas: { user: string; tablespace: string; maxBytes: number; bytes: number }[]; // DBA_TS_QUOTAS (max_bytes -1 = 무제한)
  unlimitedUsers: string[]; // UNLIMITED TABLESPACE 권한 (롤로는 줄 수 없는 권한이라 DBA_SYS_PRIVS 직접 부여만)
}

export interface PrecheckRow {
  check: '스키마' | '테이블스페이스' | '여유 공간' | 'QUOTA';
  target: string;
  status: 'PASS' | 'WARN' | 'BLOCK';
  detail: string;
  sql?: string; // 부여 SQL (실행하지 않고 보여 주기만)
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function evaluatePrecheck(input: PrecheckInput): { rows: PrecheckRow[]; blocked: boolean } {
  const rows: PrecheckRow[] = [];
  const users = new Set(input.existingUsers);
  const spaces = new Set(input.existingTablespaces);
  for (const owner of [...new Set(input.owners)].sort()) {
    rows.push(users.has(owner) ? { check: '스키마', target: owner, status: 'PASS', detail: '있음' } : { check: '스키마', target: owner, status: 'BLOCK', detail: '대상 DB에 없음 (먼저 만들어야 함)' });
  }
  for (const ts of [...new Set(input.tablespaces)].sort()) {
    rows.push(spaces.has(ts) ? { check: '테이블스페이스', target: ts, status: 'PASS', detail: '있음' } : { check: '테이블스페이스', target: ts, status: 'BLOCK', detail: '대상 DB에 없음' });
  }
  const byTs = new Map<string, number>();
  for (const entry of input.required) byTs.set(entry.tablespace, (byTs.get(entry.tablespace) ?? 0) + entry.bytes);
  for (const [ts, need] of [...byTs].sort()) {
    if (!spaces.has(ts)) continue;
    const free = input.freeBytes[ts];
    if (free === undefined) rows.push({ check: '여유 공간', target: ts, status: 'WARN', detail: `여유 공간을 읽지 못함 (필요 약 ${gb(need)})` });
    else if (free < need) rows.push({ check: '여유 공간', target: ts, status: 'WARN', detail: `부족: 필요 약 ${gb(need)}, 여유(자동 확장 최대까지) ${gb(free)} → ${gb(need - free)} 부족` });
    else rows.push({ check: '여유 공간', target: ts, status: 'PASS', detail: `필요 약 ${gb(need)} / 여유 ${gb(free)}` });
  }
  if (input.sizeUnknown.length > 0) {
    rows.push({ check: '여유 공간', target: `${input.sizeUnknown.length}개 항목`, status: 'WARN', detail: `크기를 알 수 없어 합산에서 빠짐: ${input.sizeUnknown.slice(0, 5).join(', ')}${input.sizeUnknown.length > 5 ? ' …' : ''}` });
  }
  const unlimited = new Set(input.unlimitedUsers);
  const needByOwnerTs = new Map<string, number>();
  for (const entry of input.required) needByOwnerTs.set(`${entry.owner}\u0001${entry.tablespace}`, (needByOwnerTs.get(`${entry.owner}\u0001${entry.tablespace}`) ?? 0) + entry.bytes);
  for (const [key, need] of [...needByOwnerTs].sort()) {
    const [owner, ts] = key.split('\u0001');
    if (!users.has(owner) || !spaces.has(ts)) continue;
    const target = `${owner} @ ${ts}`;
    const grant = `ALTER USER ${sqlName(owner)} QUOTA UNLIMITED ON ${sqlName(ts)};`;
    if (unlimited.has(owner)) {
      rows.push({ check: 'QUOTA', target, status: 'PASS', detail: 'UNLIMITED TABLESPACE 권한' });
      continue;
    }
    const quota = input.quotas.find((row) => row.user === owner && row.tablespace === ts);
    if (!quota) rows.push({ check: 'QUOTA', target, status: 'BLOCK', detail: 'QUOTA 없음 — 그대로 실행하면 ORA-01950으로 중간에 실패합니다', sql: grant });
    else if (quota.maxBytes < 0) rows.push({ check: 'QUOTA', target, status: 'PASS', detail: 'QUOTA 무제한' });
    else if (quota.maxBytes - quota.bytes < need) rows.push({ check: 'QUOTA', target, status: 'WARN', detail: `QUOTA 남은 양 ${gb(quota.maxBytes - quota.bytes)} < 필요 약 ${gb(need)} (ORA-01536 가능)`, sql: grant });
    else rows.push({ check: 'QUOTA', target, status: 'PASS', detail: `QUOTA 남은 양 ${gb(quota.maxBytes - quota.bytes)}` });
  }
  return { rows, blocked: rows.some((row) => row.status === 'BLOCK') };
}

// 매핑표 CSV 붙여넣기: 한 줄에 "원본,대상" (대상이 비었거나 = 이면 "그대로 사용"). 머리줄(FROM,TO)은 건너뛴다.
export function parseMappingCsv(text: string): { from: string; to: string; keep: boolean }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#/.test(line) && !/^from\s*[,\t]\s*to$/i.test(line))
    .map((line) => {
      const [from, to = ''] = line.split(/[,\t]/).map((cell) => cell.trim());
      const keep = to === '' || to === '=' || /^(KEEP|그대로)$/i.test(to);
      return { from: parseIdentifier(from, '원본'), to: keep ? '' : to, keep };
    });
}
