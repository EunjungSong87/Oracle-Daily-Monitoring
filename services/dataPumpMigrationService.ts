import { randomUUID } from 'crypto';
import * as dataPumpModel from '../models/dataPumpModel';
import * as migrationModel from '../models/dataPumpMigrationModel';
import type { ExportHistoryRow, MigrationJobRecord } from '../models/dataPumpMigrationModel';
import * as migrationDbModel from '../models/migrationDbModel';
import type { DbmsIdParam } from '../models/dbmsModel';
import { fail } from './dataPumpErrors';
import type { DataFilter, ObjectFilter } from './dataPumpFilters';
import type { LogItem } from './dataPumpLogVerify';
import {
  assertImportExecution,
  assertImportParfilesCover,
  assessExport,
  buildImportJobs,
  bundleImportStatus,
  checkDumpFiles,
  evaluatePrecheck,
  expectedDumpFiles,
  filterImpact,
  itemKey,
  mapSchema,
  mapTablespace,
  normalizeMapping,
  omittedItems,
  placementsFor,
  remapCollisions,
  remapKey,
  requiredBytes,
  tableKeyOf,
  tablespacesOf,
  unmapped,
  type DumpSetAssessment,
  type ExportAssessment,
  type ExportDumpSet,
  type PlannedJob,
  type PrecheckRow,
  type RemapMapping,
  type SegmentPlacement,
} from './dataPumpMigration';
import { recordPrecheck } from './dataPumpMigrationGate';
import { parseIdentifier } from './dataPumpNames';
import { assertImportCovers, buildParfile, buildPlan, executionPlans, getFilterEnv, identifier, timestamp } from './dataPumpService';
import type { DataPumpRequest } from './dataPumpService';
import { buildRanges, MANIFEST_KIND, manifestText, truncateTargetsByRange } from './partitionRanges';
import type { PartitionManifest } from './partitionRanges';

// "Export → Import 생성 → 사전 점검" (Data Pump 화면의 "이관 Import" 탭).
// 원본 Export 묶음은 메타 DB의 작업 이력(로그에서 실제로 나간 목록)을 기준으로 하고, 원본 DB는 테이블스페이스 위치만(OWNER+이름 조건),
// 대상 DB는 DIRECTORY/덤프 파일/사전 점검만 읽는다.

const INSTALL_HINT = '이관 테이블이 없습니다. 메타데이터 DB에 scripts/add_datapump_bundle.sql, scripts/add_datapump_migration.sql을 실행하세요.';

async function meta<T>(work: () => Promise<T>, what: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (migrationModel.isMissingTable(error)) fail(INSTALL_HINT);
    throw new Error(`${what} 실패`, { cause: error });
  }
}

function parseList(values: unknown): string[] {
  return Array.isArray(values) ? values.map((value) => parseIdentifier(value, '이름')) : [];
}

// 이력 한 줄 → 덤프 세트 (요청 원문이 있으면 그 대상, 없으면(외부 작업) 마스터 테이블/로그에서 읽은 대상)
function toDumpSet(row: ExportHistoryRow): ExportDumpSet {
  const request = (row.request ?? null) as (DataPumpRequest & { runJobName?: string }) | null;
  const expected = row.expected?.items ?? null;
  const logItems = (row.logItems as LogItem[] | null) ?? null;
  const mode: ExportDumpSet['mode'] = row.jobMode === 'SCHEMA' ? 'SCHEMA' : 'TABLE';
  let schemas: string[] = [];
  let tables: { owner: string; table: string }[] = [];
  if (mode === 'SCHEMA') {
    schemas = request?.schemas ? parseList(request.schemas) : [...new Set((logItems ?? []).map((item) => item.owner))].sort();
  } else if (request) {
    const pairs =
      Array.isArray(request.qualifiedTables) && request.qualifiedTables.length > 0
        ? request.qualifiedTables.map((pair) => ({ owner: parseIdentifier(pair.owner, '소유자'), table: parseIdentifier(pair.table, '테이블') }))
        : (request.tables ?? []).map((table) => ({ owner: parseIdentifier(request.tableOwner, '소유자'), table: parseIdentifier(table, '테이블') }));
    const views = (request.dataFilter?.viewsAsTables ?? []).map((view) => ({ owner: parseIdentifier(view.owner, '소유자'), table: parseIdentifier(view.view, '뷰') }));
    // 스키마별로 나눠 실행한 하위 작업은 그 스키마 것만 (이력의 대상 목록이 그 스키마로 걸러져 있음)
    const runOwners = expected ? new Set(expected.map((key) => key.split('.')[0])) : null;
    tables = [...pairs, ...views].filter((pair) => !runOwners || runOwners.has(pair.owner));
  } else {
    tables = [...new Set((expected ?? []).map(tableKeyOf))].map((key) => ({ owner: key.slice(0, key.indexOf('.')), table: key.slice(key.indexOf('.') + 1) }));
  }
  const filter = request?.dataFilter;
  const rowFilter: ExportDumpSet['rowFilter'] = !request ? 'UNKNOWN' : (filter?.queries ?? []).length > 0 ? 'QUERY' : (filter?.samples ?? []).length > 0 ? 'SAMPLE' : 'NONE';
  return {
    historyId: row.id,
    jobName: row.jobName,
    bundleJobNo: row.bundleJobNo,
    mode,
    schemas,
    tables,
    directory: row.directory,
    dumpfile: row.dumpfile ?? '',
    logfile: row.logfile,
    status: row.status,
    expected,
    logItems,
    dumpFiles: row.dumpFiles,
    rowFilter,
    errorSummary: row.errorSummary,
  };
}

interface LoadedBundle {
  rows: ExportHistoryRow[];
  planned: PlannedJob[] | null;
  tableSizes: Map<string, number>;
  assessment: ExportAssessment;
}

async function loadBundle(dbmsid: DbmsIdParam, bundleKey: string): Promise<LoadedBundle> {
  if (typeof bundleKey !== 'string' || !/^(H\d+|[0-9a-f-]{36})$/.test(bundleKey)) fail('Export 묶음이 올바르지 않습니다.');
  const rows = await meta(() => migrationModel.getExportRows(dbmsid.dbmsid, bundleKey), 'Export 이력 조회');
  if (rows.length === 0) fail('이 DB의 Export 이력에서 묶음을 찾을 수 없습니다.');
  const bundleJobs = bundleKey.startsWith('H') ? null : await meta(() => migrationModel.getBundleJobs(bundleKey), 'Export 묶음 조회');
  const planned = bundleJobs ? bundleJobs.map((job) => ({ no: job.no, jobName: job.jobName, expected: job.expected })) : null;
  const tableSizes = new Map<string, number>();
  for (const job of bundleJobs ?? []) for (const size of job.tableSizes) tableSizes.set(itemKey(size.owner, size.name), size.bytes);
  const sets = rows.map((row) => {
    const set = toDumpSet(row);
    // 지원하지 않는 모드(외부 FULL 등)는 차단 사유로
    return row.jobMode === 'SCHEMA' || row.jobMode === 'TABLE' ? set : { ...set, status: `${row.jobMode} 모드(지원 안 함)` };
  });
  return { rows, planned, tableSizes, assessment: assessExport(planned, sets) };
}

function setView(item: DumpSetAssessment, startedAt: string | null) {
  return {
    historyId: item.set.historyId,
    jobName: item.set.jobName,
    bundleJobNo: item.set.bundleJobNo,
    mode: item.set.mode,
    owners: item.set.mode === 'SCHEMA' ? item.set.schemas : [...new Set(item.set.tables.map((pair) => pair.owner))],
    status: item.set.status,
    startedAt,
    items: [...item.baseline].map(([key, rows]) => ({ key, rows })),
    dumpfile: item.set.dumpfile,
    dumpFiles: expectedDumpFiles(item.set),
    blockers: item.blockers,
    warnings: item.warnings,
  };
}

async function listBundles(dbmsid: DbmsIdParam) {
  return meta(() => migrationModel.listExportBundles(dbmsid.dbmsid), 'Export 묶음 목록 조회');
}

// 원본 DB의 테이블스페이스 위치 (기준 목록의 테이블만, OWNER+이름 조건)
async function sourcePlacements(dbmsid: DbmsIdParam, keys: string[]): Promise<{ rows: SegmentPlacement[]; truncated: boolean }> {
  const tables = [...new Set(keys.map(tableKeyOf))].map((key) => ({ owner: key.slice(0, key.indexOf('.')), table: key.slice(key.indexOf('.') + 1) }));
  try {
    return await migrationDbModel.readPlacements(dbmsid, tables);
  } catch (error) {
    throw new Error('원본 DB 테이블스페이스 위치 조회 실패', { cause: error });
  }
}

async function importStatuses(sourceDbmsId: number | string, bundleKey: string) {
  const plans = await migrationModel.listMigrationPlans(sourceDbmsId, bundleKey).catch(() => []);
  const result = [];
  for (const plan of plans.slice(0, 5)) {
    const jobs = await migrationModel.getMigrationJobs(plan.planId);
    const runs = await migrationModel.getImportResults(plan.targetDbmsId, jobs.map((job) => job.jobName));
    const perJob = jobs.map((job) => {
      const mine = runs.filter((run) => run.jobName === job.jobName || run.jobName.startsWith(`${job.jobName}_S`));
      if (mine.length === 0) return { jobName: job.jobName, status: null, verifyStatus: null };
      const status = mine.some((run) => run.status === 'RUNNING') ? 'RUNNING' : mine[mine.length - 1].status;
      const verifyStatus = mine.every((run) => run.verifyStatus === 'MATCH') ? 'MATCH' : (mine.find((run) => run.verifyStatus !== 'MATCH')?.verifyStatus ?? null);
      return { jobName: job.jobName, status, verifyStatus };
    });
    result.push({ planId: plan.planId, createdAt: plan.createdAt, createdBy: plan.createdBy, targetDbmsId: plan.targetDbmsId, omitted: plan.omitted.length, jobs: perJob, ...bundleImportStatus(perJob, plan.omitted.length) });
  }
  return result;
}

async function getBundle(dbmsid: DbmsIdParam, bundleKey: string) {
  const loaded = await loadBundle(dbmsid, bundleKey);
  const { assessment } = loaded;
  const keys = assessment.sets.flatMap((item) => [...item.baseline.keys()]);
  let placements: { tablespaces: string[]; owners: string[]; truncated: boolean; error: string | null; bySet: Record<number, string[]> };
  try {
    const read = await sourcePlacements(dbmsid, keys);
    placements = {
      tablespaces: tablespacesOf(placementsFor(keys, read.rows)),
      owners: [...new Set(keys.map((key) => key.split('.')[0]))].sort(),
      truncated: read.truncated,
      error: null,
      bySet: Object.fromEntries(assessment.sets.map((item) => [item.set.historyId, tablespacesOf(placementsFor([...item.baseline.keys()], read.rows))])),
    };
  } catch (error) {
    placements = { tablespaces: [], owners: [...new Set(keys.map((key) => key.split('.')[0]))].sort(), truncated: false, error: error instanceof Error ? `${error.message}${error.cause instanceof Error ? ` ← ${error.cause.message}` : ''}` : String(error), bySet: {} };
  }
  const startedAt = new Map(loaded.rows.map((row) => [row.id, row.startedAt]));
  const partitionTables = bundleKey.startsWith('H') ? [] : await migrationModel.getPartitionRows(bundleKey).then((rows) => [...new Set(rows.map((row) => `${row.owner}.${row.table}`))]).catch(() => []);
  return {
    bundleKey,
    sets: assessment.sets.map((item) => setView(item, startedAt.get(item.set.historyId) ?? null)),
    planned: loaded.planned,
    exportGaps: assessment.exportGaps,
    notRun: assessment.notRun,
    duplicates: assessment.duplicates,
    blocked: assessment.blocked,
    placements,
    partitionTables,
    imports: await importStatuses(dbmsid.dbmsid, bundleKey),
  };
}

export interface GenerateInput {
  targetDbmsId: unknown;
  directory: unknown;
  mapping: unknown;
  selected: unknown;
  options: {
    parallel?: unknown;
    content?: unknown;
    excludeStatistics?: unknown;
    metrics?: unknown;
    logtime?: unknown;
    tableExistsAction?: unknown;
    truncatePartitions?: unknown;
    objectFilter?: ObjectFilter | null;
    dataFilter?: DataFilter | null;
  };
  ack: { omitted?: unknown; filterExcluded?: unknown } | null;
}

function sameSet(a: string[], b: unknown): boolean {
  if (!Array.isArray(b) || b.some((item) => typeof item !== 'string')) return false;
  const left = new Set(a);
  const right = new Set(b as string[]);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

// 파티션 덤프를 "비우고 넣기": 대상 테이블 파티션을 원본 파티션 범위로 짝짓는다 (이름이 달라도 범위로 — 인터벌 파티션).
async function truncatePlan(
  sourceBundle: string,
  sets: DumpSetAssessment[],
  mapping: RemapMapping,
  targetDbmsId: string
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const problems: string[] = [];
  const partitionRows = sourceBundle.startsWith('H') ? [] : await meta(() => migrationModel.getPartitionRows(sourceBundle), '파티션 이력 조회');
  for (const { set, baseline } of sets) {
    const partKeys = [...baseline.keys()].filter((key) => key.includes(':'));
    if (partKeys.length === 0) continue;
    const tables = [...new Set(partKeys.map(tableKeyOf))];
    if (tables.length > 1 || set.tables.length > 1) {
      problems.push(`${set.jobName}: 테이블이 여러 개인 덤프라 파티션 비우기를 할 수 없음 (${tables.join(', ')})`);
      continue;
    }
    const [owner, table] = [tables[0].slice(0, tables[0].indexOf('.')), tables[0].slice(tables[0].indexOf('.') + 1)];
    const source = partitionRows.filter((row) => row.owner === owner && row.table === table && partKeys.includes(itemKey(owner, table, row.partition)));
    if (source.length !== partKeys.length) {
      problems.push(`${set.jobName}: 파티션 범위 이력이 없어(외부 작업 등) 비울 파티션을 범위로 짝지을 수 없음`);
      continue;
    }
    let target;
    try {
      target = await dataPumpModel.getTablePartitions({ dbmsid: targetDbmsId }, mapSchema(mapping, owner), table);
    } catch (error) {
      throw new Error(`대상 테이블 파티션 조회 실패 (${mapSchema(mapping, owner)}.${table})`, { cause: error });
    }
    if (!target.table) continue; // 대상 테이블이 없으면 비울 것도 없음 (Import가 만든다)
    const matched = truncateTargetsByRange(
      source.map((row) => ({ name: row.partition, known: row.known, low: row.low, high: row.high })),
      buildRanges(target.partitions)
    );
    if (matched.problems.length > 0) problems.push(...matched.problems.map((problem) => `${set.jobName} ${owner}.${table}: ${problem}`));
    else result.set(set.historyId, [...matched.map.values()].filter((name): name is string => !!name));
  }
  if (problems.length > 0) fail('파티션 비우기를 할 수 없는 덤프가 있습니다 (비우면 다른 기간 데이터까지 지워지거나 범위를 모름).', problems);
  return result;
}

const TEA = ['SKIP', 'APPEND', 'TRUNCATE', 'REPLACE'] as const;
const LOGTIMES = ['STATUS', 'LOGFILE', 'ALL'] as const;

async function generate(dbmsid: DbmsIdParam, bundleKey: string, input: GenerateInput, user: { name: string | null; role: string | null }) {
  const loaded = await loadBundle(dbmsid, bundleKey);
  const { assessment } = loaded;
  // 불변식 1: Export 로그 기준 — 계획에 있는데 로그에 없음/진행 중/로그 못 읽음/중복이면 생성 불가
  if (assessment.blocked) {
    fail('Export 단계에서 빠졌거나 확인할 수 없는 항목이 있어 Import를 만들 수 없습니다.', [
      ...assessment.exportGaps.map((gap) => `Export 단계에서 빠짐: ${gap}`),
      ...assessment.duplicates.map((dup) => `두 덤프에 중복: ${dup}`),
      ...assessment.sets.flatMap((item) => item.blockers.map((blocker) => `${item.set.jobName}: ${blocker}`)),
    ]);
  }
  const targetDbmsId = String(input.targetDbmsId ?? '');
  if (!/^\d+$/.test(targetDbmsId)) fail('대상 DB를 골라주세요.');
  const directory = identifier(input.directory, '대상 DIRECTORY');
  const selectedIds = Array.isArray(input.selected) ? [...new Set(input.selected.map(Number))] : [];
  const selected = assessment.sets.filter((item) => selectedIds.includes(item.set.historyId));
  if (selected.length === 0) fail('Import할 덤프 세트를 하나 이상 골라주세요.');
  if (selected.length !== selectedIds.length) fail('이 묶음에 없는 덤프 세트가 있습니다.');

  // 불변식 2: 일부만 고르면 빠지는 테이블을 사용자가 확인해야 한다 (이력에 남김)
  const omitted = omittedItems(assessment, selectedIds);
  if (omitted.length > 0 && !sameSet(omitted, input.ack?.omitted)) fail(`고르지 않은 작업 때문에 ${omitted.length}개가 빠집니다. 목록을 확인하고 "빼고 진행"을 체크해야 만들 수 있습니다.`, omitted);

  const mapping = normalizeMapping(input.mapping);
  const keys = selected.flatMap((item) => [...item.baseline.keys()]);
  const placements = await sourcePlacements(dbmsid, keys);
  if (placements.truncated) fail(`원본 위치 정보가 상한(${migrationDbModel.MAX_PLACEMENT_ROWS}행)을 넘어 매핑 대상을 다 읽지 못했습니다. 묶음을 나눠 주세요.`);
  const scoped = placementsFor(keys, placements.rows);
  const owners = [...new Set(keys.map((key) => key.split('.')[0]))].sort();
  const missingMapping = unmapped(owners, tablespacesOf(scoped), mapping);
  if (missingMapping.length > 0) fail('매핑표에 비어 있는 행이 있어 만들 수 없습니다 ("그대로 사용"도 명시적으로 골라야 함).', missingMapping);
  const collisions = remapCollisions(keys, mapping);
  if (collisions.length > 0) fail('REMAP_SCHEMA 후 같은 이름이 되는 테이블이 있습니다 (하나가 덮이거나 건너뛰어짐).', collisions);

  // 불변식 4: 사용자가 추가한 대상 축소 조건으로 빠지는 테이블
  const impact = filterImpact(keys, input.options.objectFilter, input.options.dataFilter);
  if (impact.excluded.length > 0 && !sameSet(impact.excluded, input.ack?.filterExcluded)) {
    fail(`Import 필터로 ${impact.excluded.length}개 테이블이 빠집니다. 목록을 확인하고 체크해야 만들 수 있습니다.`, impact.excluded);
  }

  const parallel = Number(input.options.parallel ?? 1);
  const content = input.options.content === 'DATA_ONLY' || input.options.content === 'METADATA_ONLY' ? input.options.content : 'ALL';
  const tableExistsAction = TEA.find((value) => value === input.options.tableExistsAction) ?? 'SKIP';
  const truncate = input.options.truncatePartitions === true ? await truncatePlan(bundleKey, selected, mapping, targetDbmsId) : new Map<number, string[]>();
  const now = new Date();
  const bySet = new Map(selected.map((item) => [item.set.historyId, tablespacesOf(placementsFor([...item.baseline.keys()], placements.rows))]));
  const jobs = buildImportJobs(selected, mapping, bySet, { directory, parallel, content, excludeStatistics: input.options.excludeStatistics !== false, metrics: input.options.metrics === true, logtime: LOGTIMES.find((value) => value === input.options.logtime) ?? null, tableExistsAction, objectFilter: input.options.objectFilter ?? null, dataFilter: input.options.dataFilter ?? null, stamp: timestamp(now) }, truncate);

  // 같은 buildPlan에서 parfile과 실행 필터를 만들고 둘 다 기준과 대조한다 (불변식 3, 5)
  const env = await getFilterEnv({ dbmsid: targetDbmsId }, user.role);
  const target = await dataPumpModel.getTargetInfo({ dbmsid: targetDbmsId });
  const built = jobs.map((job) => {
    const plan = buildPlan(job.request, now, env);
    const comment = `이관 Import ${job.no}/${jobs.length}: Export ${job.exportJobName}의 덤프 → ${target.dbname} (기준 ${job.sourceKeys.length}개)`;
    const parfile = buildParfile(plan, job.request, target, comment);
    const notes = [...job.notes, ...assertImportCovers(plan, job.request, parfile.parfile), ...parfile.notes];
    assertImportExecution(plan, executionPlans(plan), { mode: job.request.mode as 'SCHEMA' | 'TABLE', schemas: job.expectedSchemas, tables: job.expectedTables, remap: job.remap });
    return { job, plan, ...parfile, notes };
  });
  assertImportParfilesCover(
    built.map((item) => ({ jobName: item.plan.jobName, parfile: item.parfile, sourceKeys: item.job.sourceKeys })),
    selected.flatMap((item) => [...item.baseline.keys()]).map((key) => remapKey(key, mapping))
  );

  // 대상 DIRECTORY 확인 + 덤프 파일 (없거나 크기가 다르면 실행 불가 — 생성은 됨, 파일을 옮긴 뒤 다시 확인)
  let directories: string[];
  try {
    directories = (await dataPumpModel.getDirectories({ dbmsid: targetDbmsId })).map((dir) => dir.name);
  } catch (error) {
    throw new Error('대상 DB DIRECTORY 조회 실패', { cause: error });
  }
  if (!directories.includes(directory)) fail(`대상 DB에 DIRECTORY ${directory}가 없습니다.`);
  const fileCheck = await checkFiles(targetDbmsId, directory, selected);

  const planId = randomUUID();
  const records: MigrationJobRecord[] = built.map((item) => ({
    jobName: item.plan.jobName,
    planId,
    no: item.job.no,
    exportHistoryId: item.job.historyId,
    exportJobName: item.job.exportJobName,
    targetDbmsId: Number(targetDbmsId),
    request: item.job.request as Record<string, any>,
    parfile: item.parfile,
    expected: {
      baseline: item.job.baseline,
      remap: item.job.remap,
      mode: item.job.request.mode as 'SCHEMA' | 'TABLE',
      schemas: item.job.expectedSchemas,
      tables: item.job.expectedTables,
      targetKeys: item.job.targetKeys,
      waitFor: item.job.waitFor,
    },
    dumpFiles: expectedDumpFiles(selected.find((set) => set.set.historyId === item.job.historyId)!.set) ?? [],
  }));
  await meta(
    () =>
      migrationModel.saveMigration(
        {
          planId,
          sourceDbmsId: Number(dbmsid.dbmsid),
          bundleKey,
          targetDbmsId: Number(targetDbmsId),
          totalSets: assessment.sets.length + assessment.notRun.length,
          omitted,
          filterExcluded: impact.excluded,
          mapping,
          options: { directory, parallel, content, tableExistsAction, truncatePartitions: input.options.truncatePartitions === true, objectFilter: input.options.objectFilter ?? null, dataFilter: input.options.dataFilter ?? null },
          createdBy: user.name,
        },
        records
      ),
    '이관 Import 기록'
  );
  return {
    planId,
    targetDbmsId,
    targetDbname: target.dbname,
    omitted,
    impact,
    warnings: selected.flatMap((item) => item.warnings.map((warning) => `${item.set.jobName}: ${warning}`)),
    fileCheck,
    jobs: built.map((item) => ({
      no: item.job.no,
      jobName: item.plan.jobName,
      exportJobName: item.job.exportJobName,
      request: item.job.request,
      parfile: item.parfile,
      parfileName: item.parfileName,
      command: item.command,
      notes: item.notes,
      items: item.job.targetKeys.length,
      destructive: item.plan.truncatePartitions.length > 0 || ['APPEND', 'TRUNCATE', 'REPLACE'].includes(String(item.plan.tableExistsAction)),
      waitFor: item.job.waitFor,
    })),
  };
}

async function checkFiles(targetDbmsId: string, directory: string, sets: DumpSetAssessment[]) {
  const wanted = sets.map((item) => ({ jobName: item.set.jobName, files: expectedDumpFiles(item.set) ?? [] }));
  let sizes: Record<string, number>;
  try {
    sizes = await dataPumpModel.getFileSizes({ dbmsid: targetDbmsId }, directory, wanted.flatMap((item) => item.files.map((file) => file.name)));
  } catch (error) {
    throw new Error('대상 DIRECTORY의 덤프 파일 확인 실패', { cause: error });
  }
  return checkDumpFiles(wanted, sizes);
}

// 생성한 Import의 덤프 파일을 다시 확인 (파일을 옮긴 뒤)
async function recheckFiles(planId: unknown) {
  const plan = await loadPlan(planId);
  const jobs = await meta(() => migrationModel.getMigrationJobs(plan.planId), '이관 Import 조회');
  const directory = String((plan.options as { directory?: string } | null)?.directory ?? '');
  let sizes: Record<string, number>;
  try {
    sizes = await dataPumpModel.getFileSizes({ dbmsid: plan.targetDbmsId }, directory, jobs.flatMap((job) => job.dumpFiles.map((file) => file.name)));
  } catch (error) {
    throw new Error('대상 DIRECTORY의 덤프 파일 확인 실패', { cause: error });
  }
  return checkDumpFiles(jobs.map((job) => ({ jobName: job.exportJobName, files: job.dumpFiles })), sizes);
}

async function loadPlan(planId: unknown) {
  if (typeof planId !== 'string' || !/^[0-9a-f-]{36}$/.test(planId)) fail('이관 Import 계획이 올바르지 않습니다.');
  const plan = await meta(() => migrationModel.getMigrationPlan(planId), '이관 Import 조회');
  if (!plan) fail('이관 Import 계획을 찾을 수 없습니다.');
  return plan;
}

// 생성한 Import 다시 보기 (화면을 다시 열었을 때)
async function getPlan(planId: unknown) {
  const plan = await loadPlan(planId);
  const jobs = await meta(() => migrationModel.getMigrationJobs(plan.planId), '이관 Import 조회');
  const target = await dataPumpModel.getTargetInfo({ dbmsid: plan.targetDbmsId });
  return {
    planId: plan.planId,
    targetDbmsId: String(plan.targetDbmsId),
    targetDbname: target.dbname,
    omitted: plan.omitted,
    jobs: jobs.map((job) => ({
      no: job.no,
      jobName: job.jobName,
      exportJobName: job.exportJobName,
      request: job.request,
      parfile: job.parfile,
      parfileName: `${job.jobName.toLowerCase()}.par`,
      command: `impdp ${target.user}@${target.host}:${target.port}/${target.sid} parfile=${job.jobName.toLowerCase()}.par`,
      notes: [],
      items: job.expected.targetKeys.length,
      destructive: (job.request.truncatePartitions ?? []).length > 0 || ['APPEND', 'TRUNCATE', 'REPLACE'].includes(String(job.request.tableExistsAction)),
      waitFor: job.expected.waitFor ?? [],
    })),
  };
}

// Import 전 사전 점검 (대상 DB): 스키마/테이블스페이스 존재, 여유 공간, QUOTA. 결과는 실행 전 필수 확인으로 기억한다.
async function precheck(planId: unknown): Promise<{ rows: PrecheckRow[]; blocked: boolean; sizeNote: string }> {
  const plan = await loadPlan(planId);
  const jobs = await meta(() => migrationModel.getMigrationJobs(plan.planId), '이관 Import 조회');
  const mapping = normalizeMapping(plan.mapping);
  const sourceKeys = jobs.flatMap((job) => Object.keys(job.expected.baseline));
  const placements = await sourcePlacements({ dbmsid: plan.sourceDbmsId }, sourceKeys);
  const scoped = placementsFor(sourceKeys, placements.rows);

  // 들어갈 크기: 이력의 계획 크기 (테이블 = 테이블+LOB, 파티션 = 파티션 크기)
  const bundleJobs = plan.bundleKey.startsWith('H') ? [] : await migrationModel.getBundleJobs(plan.bundleKey).catch(() => []);
  const partitionRows = plan.bundleKey.startsWith('H') ? [] : await migrationModel.getPartitionRows(plan.bundleKey).catch(() => []);
  const tableSizes = new Map<string, number>();
  for (const job of bundleJobs) for (const size of job.tableSizes) tableSizes.set(itemKey(size.owner, size.name), size.bytes);
  const sizes: { key: string; bytes: number }[] = [];
  const unknownSize: string[] = [];
  for (const key of sourceKeys) {
    const [table, partition] = key.split(':');
    const bytes = partition
      ? partitionRows.find((row) => itemKey(row.owner, row.table, row.partition) === key)?.bytes
      : tableSizes.get(table);
    if (bytes === undefined) unknownSize.push(key);
    else sizes.push({ key, bytes });
  }
  const need = requiredBytes(sizes, scoped, mapping);
  // 인덱스/LOB 등 크기를 모르는 세그먼트도 그 소유자가 그 테이블스페이스에 QUOTA가 있어야 한다 (0바이트로 넣어 QUOTA만 확인)
  const entries = [...need.entries];
  for (const row of scoped) {
    if (!row.tablespace) continue;
    const owner = mapSchema(mapping, row.owner);
    const tablespace = mapTablespace(mapping, row.tablespace);
    if (!entries.some((entry) => entry.owner === owner && entry.tablespace === tablespace)) entries.push({ owner, tablespace, bytes: 0 });
  }
  const owners = [...new Set(jobs.flatMap((job) => job.expected.targetKeys.map((key) => key.split('.')[0])))];
  const tablespaces = [...new Set(scoped.map((row) => row.tablespace).filter((ts): ts is string => !!ts).map((ts) => mapTablespace(mapping, ts)))];
  let raw;
  try {
    raw = await migrationDbModel.readPrecheck({ dbmsid: plan.targetDbmsId }, owners, tablespaces);
  } catch (error) {
    throw new Error('대상 DB 사전 점검 조회 실패', { cause: error });
  }
  const result = evaluatePrecheck({
    owners,
    existingUsers: raw.users,
    tablespaces,
    existingTablespaces: raw.tablespaces,
    required: entries,
    sizeUnknown: [...unknownSize, ...need.unknown],
    freeBytes: raw.freeBytes,
    quotas: raw.quotas,
    unlimitedUsers: raw.unlimitedUsers,
  });
  recordPrecheck(plan.planId, result.blocked);
  return { ...result, sizeNote: '필요 크기는 Export 계획 때의 테이블(+LOB)/파티션 크기 합이며 인덱스 크기는 포함하지 않습니다.' };
}

// ── 매핑표 ──

async function listRemapSets() {
  return meta(() => migrationModel.listRemapSets(), '매핑표 조회');
}

async function saveRemapSet(name: unknown, mapping: unknown, by: string | null): Promise<void> {
  const label = typeof name === 'string' ? name.trim() : '';
  if (label.length < 1 || label.length > 100 || [...label].some((ch) => ch.charCodeAt(0) < 32)) fail('매핑표 이름은 1~100자로 입력하세요.');
  const normalized = normalizeMapping(mapping);
  await meta(() => migrationModel.saveRemapSet(label, normalized.schemas, normalized.tablespaces, by), '매핑표 저장');
}

async function deleteRemapSet(id: unknown): Promise<void> {
  const value = Number(id);
  if (!Number.isInteger(value)) fail('매핑표가 올바르지 않습니다.');
  await meta(() => migrationModel.deleteRemapSet(value), '매핑표 삭제');
}

// ── 이력 기반 파티션 Import (매니페스트 파일 대신) ──

async function listPartitionExports(dbmsid: DbmsIdParam) {
  return meta(() => migrationModel.listPartitionExports(dbmsid.dbmsid), '파티션 Export 이력 조회');
}

// 이력의 파티션 정보로 매니페스트와 같은 형태를 만든다 → 파티션 Import 탭이 파일에서 읽은 것과 똑같이 쓴다
async function partitionManifestFromHistory(dbmsid: DbmsIdParam, bundleId: unknown, owner: unknown, table: unknown): Promise<{ text: string }> {
  if (typeof bundleId !== 'string' || !/^[0-9a-f-]{36}$/.test(bundleId)) fail('Export 묶음이 올바르지 않습니다.');
  const ownerName = String(owner ?? '');
  const tableName = String(table ?? '');
  const rows = await meta(() => migrationModel.getPartitionRows(bundleId, ownerName, tableName), '파티션 이력 조회');
  if (rows.length === 0) fail('이 묶음에 그 테이블의 파티션 이력이 없습니다.');
  const exportRows = await meta(() => migrationModel.getExportRows(dbmsid.dbmsid, bundleId), 'Export 이력 조회');
  const target = await dataPumpModel.getTargetInfo(dbmsid);
  const manifest: PartitionManifest = {
    kind: MANIFEST_KIND,
    version: 1,
    createdAt: exportRows[0]?.startedAt ?? new Date().toISOString(),
    sourceDb: target.dbname,
    owner: rows[0].owner,
    table: rows[0].table,
    keyColumn: rows[0].keyColumn,
    keyType: rows[0].keyType,
    interval: rows[0].interval,
    directory: exportRows[0]?.directory ?? '',
    partitions: rows.map((row) => ({
      name: row.partition,
      position: row.position,
      highValue: row.highValue,
      known: row.known,
      low: row.low,
      high: row.high,
      numRows: row.numRows,
      bytes: row.bytes,
      dumpfile: row.dumpfile,
    })),
  };
  return { text: manifestText(manifest) };
}

export { listBundles, getBundle, generate, getPlan, recheckFiles, precheck, listRemapSets, saveRemapSet, deleteRemapSet, listPartitionExports, partitionManifestFromHistory };
