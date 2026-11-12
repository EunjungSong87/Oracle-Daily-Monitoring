import ExcelJS from 'exceljs';
import * as dataPumpModel from '../models/dataPumpModel';
import * as migrationModel from '../models/dataPumpMigrationModel';
import * as migrationDbModel from '../models/migrationDbModel';
import { fail } from './dataPumpErrors';
import { checkSqlCondition } from './dataPumpFilters';
import type { LogItem } from './dataPumpLogVerify';
import { normalizeMapping, remapKey, tableKeyOf, type RemapMapping } from './dataPumpMigration';
import {
  checkRows,
  compareFindings,
  compareTablespaces,
  compileSql,
  importedRows,
  missingPrivileges,
  parseScopeList,
  rebuildSql,
  scopedFindings,
  statsSql,
  summarize,
  type FindingView,
  type RowCheck,
  type ScopeItem,
  type TablespaceCheck,
  type VerifySummary,
} from './migrationVerify';

// Maintenance > 이관 검증. 범위(이관한 테이블/파티션)만 본다 — 원본·대상 DB 조회는 모두 범위 테이블의 OWNER+이름 조건.
// 행 수는 기본이 로그 대조(DB 조회 없음), COUNT는 사용자가 고른 테이블만 (개수 상한, DB별 동시 1개).

export const MAX_COUNT_TABLES = 20;
const COUNT_TIMEOUT_MS = Math.max(10000, Number(process.env.MIGRATION_COUNT_TIMEOUT_MS) || 10 * 60 * 1000);
const counting = new Set<string>(); // COUNT 중인 DB (dbms id)

export interface ScopeInput {
  planId?: unknown;
  list?: unknown;
  sourceDbmsId?: unknown;
  targetDbmsId?: unknown;
  remapSetId?: unknown;
}

interface Scope {
  label: string;
  sourceDbmsId: string;
  targetDbmsId: string;
  sourceDbname: string;
  targetDbname: string;
  mapping: RemapMapping;
  items: ScopeItem[];
}

function isMissingTable(error: unknown): boolean {
  return migrationModel.isMissingTable(error);
}

async function meta<T>(work: () => Promise<T>, what: string): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isMissingTable(error)) fail('이관 테이블이 없습니다. 메타데이터 DB에 scripts/add_datapump_bundle.sql, scripts/add_datapump_migration.sql을 실행하세요.');
    throw new Error(`${what} 실패`, { cause: error });
  }
}

function dbmsIdOf(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) fail(`${label}을(를) 골라주세요.`);
  return text;
}

// 범위: (a) 이관 Import 계획 = 그 Export/Import 짝의 대상, (b) 붙여넣은 목록 + 원본/대상 DB + 매핑표
async function resolveScope(input: ScopeInput): Promise<Scope> {
  if (typeof input.planId === 'string' && input.planId) {
    if (!/^[0-9a-f-]{36}$/.test(input.planId)) fail('이관 Import 계획이 올바르지 않습니다.');
    const plan = await meta(() => migrationModel.getMigrationPlan(input.planId as string), '이관 Import 조회');
    if (!plan) fail('이관 Import 계획을 찾을 수 없습니다.');
    const jobs = await meta(() => migrationModel.getMigrationJobs(plan.planId), '이관 Import 조회');
    const mapping = normalizeMapping(plan.mapping);
    const exportRows = await migrationModel.getExportRows(plan.sourceDbmsId, plan.bundleKey).catch(() => []);
    const imports = await meta(() => migrationModel.getImportLogItems(plan.targetDbmsId, jobs.map((job) => job.jobName)), 'Import 이력 조회');
    const items: ScopeItem[] = [];
    for (const job of jobs) {
      // 같은 작업 이름의 이력이 여러 줄이면(다시 실행, 중복 기록) 이름마다 가장 최근 것만 — 행 수를 두 번 더하지 않게
      const latest = new Map(imports.filter((row) => row.jobName === job.jobName || row.jobName.startsWith(`${job.jobName}_S`)).map((row) => [row.jobName, row]));
      const runs = [...latest.values()];
      const ran = runs.length > 0 && runs.every((row) => ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(row.status));
      const logged = importedRows(job.expected.targetKeys, runs.flatMap((row) => (row.logItems as LogItem[] | null) ?? []));
      const request = exportRows.find((row) => row.id === job.exportHistoryId)?.request as { dataFilter?: { queries?: { owner?: string | null; table?: string | null; where: string }[]; samples?: unknown[] } } | null;
      for (const [sourceKey, rows] of Object.entries(job.expected.baseline)) {
        const targetKey = remapKey(sourceKey, mapping);
        const [owner, table] = [sourceKey.split('.')[0], tableKeyOf(sourceKey).split('.').slice(1).join('.')];
        const query = (request?.dataFilter?.queries ?? []).find((q) => (!q.table || (q.table === table && (!q.owner || q.owner === owner))));
        const sampled = (request?.dataFilter?.samples ?? []).length > 0;
        items.push({
          sourceKey,
          targetKey,
          exportRows: rows,
          importRows: logged.get(targetKey) ?? null,
          importRan: ran,
          rowFilter: !request ? 'UNKNOWN' : sampled ? 'SAMPLE' : query ? 'QUERY' : 'NONE',
          where: query?.where ?? null,
        });
      }
    }
    const [source, target] = await Promise.all([dataPumpModel.getTargetInfo({ dbmsid: plan.sourceDbmsId }), dataPumpModel.getTargetInfo({ dbmsid: plan.targetDbmsId })]);
    return { label: `이관 Import ${plan.createdAt ?? ''} (${jobs.length}개 작업)`, sourceDbmsId: String(plan.sourceDbmsId), targetDbmsId: String(plan.targetDbmsId), sourceDbname: source.dbname, targetDbname: target.dbname, mapping, items };
  }
  const keys = parseScopeList(typeof input.list === 'string' ? input.list : '');
  const sourceDbmsId = dbmsIdOf(input.sourceDbmsId, '원본 DB');
  const targetDbmsId = dbmsIdOf(input.targetDbmsId, '대상 DB');
  let mapping: RemapMapping = { schemas: [], tablespaces: [] };
  if (input.remapSetId !== undefined && input.remapSetId !== null && input.remapSetId !== '') {
    const set = (await meta(() => migrationModel.listRemapSets(), '매핑표 조회')).find((row) => String(row.id) === String(input.remapSetId));
    if (!set) fail('매핑표를 찾을 수 없습니다.');
    mapping = normalizeMapping({ schemas: set.schemas, tablespaces: set.tablespaces });
  }
  const [source, target] = await Promise.all([dataPumpModel.getTargetInfo({ dbmsid: sourceDbmsId }), dataPumpModel.getTargetInfo({ dbmsid: targetDbmsId })]);
  return {
    label: `붙여넣은 범위 ${keys.length}개`,
    sourceDbmsId,
    targetDbmsId,
    sourceDbname: source.dbname,
    targetDbname: target.dbname,
    mapping,
    items: keys.map((sourceKey) => ({ sourceKey, targetKey: remapKey(sourceKey, mapping), exportRows: null, importRows: null, importRan: false, rowFilter: 'NONE', where: null })),
  };
}

function tablesOf(keys: string[]): { owner: string; table: string }[] {
  return [...new Set(keys.map(tableKeyOf))].map((key) => ({ owner: key.slice(0, key.indexOf('.')), table: key.slice(key.indexOf('.') + 1) }));
}

export interface VerifyResult {
  label: string;
  sourceDbmsId: string;
  targetDbmsId: string;
  sourceDbname: string;
  targetDbname: string;
  generatedAt: string;
  rows: RowCheck[];
  rowFilters: Record<string, { kind: ScopeItem['rowFilter']; where: string | null }>;
  tablespaces: TablespaceCheck[];
  findings: (FindingView & { sql: string | null; compilable: boolean })[];
  summary: VerifySummary;
  notes: string[];
}

async function run(input: ScopeInput): Promise<VerifyResult> {
  const scope = await resolveScope(input);
  const sourceKeys = scope.items.map((item) => item.sourceKey);
  const targetKeys = scope.items.map((item) => item.targetKey);
  const sourceOwners = [...new Set(sourceKeys.map((key) => key.split('.')[0]))];
  const targetOwners = [...new Set(targetKeys.map((key) => key.split('.')[0]))];
  const read = async <T>(work: () => Promise<T>, what: string): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw new Error(`${what} 실패`, { cause: error });
    }
  };
  const [sourcePlace, targetPlace, sourceFind, targetFind] = await Promise.all([
    read(() => migrationDbModel.readPlacements({ dbmsid: scope.sourceDbmsId }, tablesOf(sourceKeys)), '원본 DB 위치 조회'),
    read(() => migrationDbModel.readPlacements({ dbmsid: scope.targetDbmsId }, tablesOf(targetKeys)), '대상 DB 위치 조회'),
    read(() => migrationDbModel.readFindings({ dbmsid: scope.sourceDbmsId }, tablesOf(sourceKeys), sourceOwners), '원본 DB 정리 점검'),
    read(() => migrationDbModel.readFindings({ dbmsid: scope.targetDbmsId }, tablesOf(targetKeys), targetOwners), '대상 DB 정리 점검'),
  ]);
  const notes: string[] = [];
  if (sourcePlace.truncated || targetPlace.truncated || sourceFind.truncated || targetFind.truncated) notes.push('조회 행 수 상한에 걸려 일부만 보여 줍니다. 범위를 나눠 확인하세요.');
  const findings = [
    ...compareFindings(scopedFindings(sourceFind.findings, sourceKeys), scopedFindings(targetFind.findings, targetKeys), scope.mapping),
    ...missingPrivileges(sourceFind.privileges, targetFind.privileges, scope.mapping).map((finding) => ({ ...finding, origin: '새로 생김' as const })),
  ].map((finding) => ({
    ...finding,
    sql: finding.category === 'INVALID' ? compileSql(finding) : (rebuildSql(finding) ?? statsSql(finding)),
    compilable: finding.category === 'INVALID' && compileSql(finding) !== null,
  }));
  const rows = scope.items.map((item) => checkRows(item, null));
  const tablespaces = compareTablespaces(sourceKeys, sourcePlace.rows, targetPlace.rows, scope.mapping);
  return {
    label: scope.label,
    sourceDbmsId: scope.sourceDbmsId,
    targetDbmsId: scope.targetDbmsId,
    sourceDbname: scope.sourceDbname,
    targetDbname: scope.targetDbname,
    generatedAt: new Date().toISOString(),
    rows,
    rowFilters: Object.fromEntries(scope.items.map((item) => [item.targetKey, { kind: item.rowFilter, where: item.where }])),
    tablespaces,
    findings,
    summary: summarize(rows, tablespaces, findings),
    notes,
  };
}

// 고른 테이블만 원본·대상 COUNT(*). QUERY로 내보낸 작업이면 원본은 같은 WHERE로, SAMPLE이면 비교 불가.
async function count(input: ScopeInput, targetKeys: unknown): Promise<RowCheck[]> {
  if (!Array.isArray(targetKeys) || targetKeys.length === 0) fail('COUNT할 테이블을 골라주세요.');
  if (targetKeys.length > MAX_COUNT_TABLES) fail(`COUNT는 한 번에 ${MAX_COUNT_TABLES}개까지 고를 수 있습니다.`);
  const scope = await resolveScope(input);
  const picked = scope.items.filter((item) => targetKeys.includes(item.targetKey));
  if (picked.length !== new Set(targetKeys).size) fail('범위에 없는 테이블이 있습니다.');
  for (const id of [scope.sourceDbmsId, scope.targetDbmsId]) if (counting.has(id)) fail('같은 DB에서 COUNT가 이미 진행 중입니다. 끝난 뒤 다시 시도하세요.');
  const ids = [...new Set([scope.sourceDbmsId, scope.targetDbmsId])];
  ids.forEach((id) => counting.add(id));
  try {
    const spec = (key: string, where: string | null) => {
      const [table, partition] = key.split(':');
      const dot = table.indexOf('.');
      return { key, owner: table.slice(0, dot), table: table.slice(dot + 1), partition: partition ?? null, where };
    };
    const sourceSpecs = picked
      .filter((item) => item.rowFilter !== 'SAMPLE')
      .map((item) => {
        const where = item.rowFilter === 'QUERY' && item.where ? checkSqlCondition(item.where, 'WHERE', `${item.sourceKey} QUERY`) : null;
        return spec(item.sourceKey, where && /^WHERE\b/i.test(where) ? where : null);
      });
    const targetSpecs = picked.filter((item) => item.rowFilter !== 'SAMPLE').map((item) => spec(item.targetKey, null));
    const run = async (dbmsid: string, specs: ReturnType<typeof spec>[]) => {
      try {
        return await migrationDbModel.countRows({ dbmsid }, specs, COUNT_TIMEOUT_MS);
      } catch (error) {
        throw new Error('COUNT 실패', { cause: error });
      }
    };
    const [sourceCounts, targetCounts] = await Promise.all([run(scope.sourceDbmsId, sourceSpecs), run(scope.targetDbmsId, targetSpecs)]);
    return picked.map((item) => {
      if (item.rowFilter === 'SAMPLE') return checkRows(item, { source: null, target: null });
      const s = sourceCounts[item.sourceKey];
      const t = targetCounts[item.targetKey];
      const error = [s?.error && `원본: ${s.error}`, t?.error && `대상: ${t.error}`].filter(Boolean).join(' / ');
      return checkRows(item, { source: s?.rows ?? null, target: t?.rows ?? null, ...(error ? { error } : {}) });
    });
  } finally {
    ids.forEach((id) => counting.delete(id));
  }
}

// INVALID 재컴파일 (SUPER_ADMIN, 대상 DB명 확인). 범위 안의 INVALID 오브젝트인지 서버가 다시 확인하고, 하나하나 기록한다.
async function compile(input: ScopeInput, objects: unknown, confirmDbname: unknown, doneBy: string) {
  const scope = await resolveScope(input);
  const typed = typeof confirmDbname === 'string' ? confirmDbname.trim().toUpperCase() : '';
  if (typed !== scope.targetDbname.trim().toUpperCase()) fail(`확인을 위해 대상 DB명(${scope.targetDbname})을 정확히 입력해주세요.`);
  if (!(await migrationModel.actionLogAvailable())) fail('조치 기록 테이블이 없습니다. 메타데이터 DB에 scripts/add_migration_action_log.sql을 실행하세요.');
  if (!Array.isArray(objects) || objects.length === 0) fail('재컴파일할 오브젝트를 골라주세요.');
  const targetKeys = scope.items.map((item) => item.targetKey);
  let current;
  try {
    current = await migrationDbModel.readFindings({ dbmsid: scope.targetDbmsId }, tablesOf(targetKeys), [...new Set(targetKeys.map((key) => key.split('.')[0]))]);
  } catch (error) {
    throw new Error('대상 DB INVALID 오브젝트 확인 실패', { cause: error });
  }
  const invalid = current.findings.filter((finding) => finding.category === 'INVALID');
  const picked = objects.map((object) => {
    const found = invalid.find((finding) => finding.owner === object?.owner && finding.name === object?.name && finding.type === object?.type);
    if (!found) fail(`범위 안의 INVALID 오브젝트가 아닙니다 (이미 VALID이거나 범위 밖): ${String(object?.owner)}.${String(object?.name)}`);
    const sql = compileSql(found);
    if (!sql) fail(`재컴파일할 수 없는 유형입니다: ${found.type}`);
    return { owner: found.owner, name: found.name, type: found.type, sql };
  });
  let results;
  try {
    results = await migrationDbModel.compileObjects({ dbmsid: scope.targetDbmsId }, picked);
  } catch (error) {
    throw new Error('재컴파일 실패', { cause: error });
  }
  for (const result of results) {
    await migrationModel.insertActionLog({
      dbmsId: Number(scope.targetDbmsId),
      dbname: scope.targetDbname,
      action: 'COMPILE',
      owner: result.owner,
      name: result.name,
      type: result.type,
      sql: result.sql,
      result: result.ok ? 'OK' : 'FAILED',
      message: result.error ?? (result.ok ? null : `컴파일 후 상태 ${result.status ?? '?'}`),
      doneBy,
    });
  }
  return results;
}

async function listPlans() {
  const plans = await meta(() => migrationModel.listRecentMigrationPlans(), '이관 Import 목록 조회');
  return plans.map((plan) => ({ planId: plan.planId, createdAt: plan.createdAt, createdBy: plan.createdBy, sourceDbmsId: plan.sourceDbmsId, targetDbmsId: plan.targetDbmsId, jobs: plan.jobs }));
}

// 이관 결과 보고용 엑셀 (화면이 받은 검증 결과를 그대로 시트로)
async function excel(result: VerifyResult): Promise<Buffer> {
  if (!result || !Array.isArray(result.rows) || !Array.isArray(result.tablespaces) || !Array.isArray(result.findings)) fail('검증 결과가 없습니다.');
  const workbook = new ExcelJS.Workbook();
  const sheet = (name: string, columns: { header: string; key: string; width: number }[], rows: Record<string, unknown>[]) => {
    const ws = workbook.addWorksheet(name);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    ws.addRows(rows);
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const s = result.summary;
  sheet('요약', [{ header: '항목', key: 'k', width: 28 }, { header: '값', key: 'v', width: 60 }], [
    { k: '범위', v: result.label },
    { k: '원본 → 대상', v: `${result.sourceDbname} → ${result.targetDbname}` },
    { k: '검증 시각', v: result.generatedAt },
    { k: '범위 항목 수', v: s.total },
    { k: '행 수 일치 / 불일치 / 미확인', v: `${s.rows.MATCH} / ${s.rows.MISMATCH} / ${s.rows.UNKNOWN}` },
    { k: '테이블스페이스 일치 / 불일치 / 매핑 누락 의심 / 대상에 없음', v: `${s.tablespaces.match} / ${s.tablespaces.mismatch} / ${s.tablespaces.suspect} / ${s.tablespaces.missing}` },
    { k: '정리 항목 (새로 생김)', v: `${s.cleanup.total} (${s.cleanup.new})` },
    ...result.notes.map((note) => ({ k: '참고', v: note })),
  ]);
  sheet(
    '행 수',
    [
      { header: '원본', key: 'sourceKey', width: 36 },
      { header: '대상', key: 'targetKey', width: 36 },
      { header: 'Export 로그', key: 'exportRows', width: 12 },
      { header: 'Import 로그', key: 'importRows', width: 12 },
      { header: '원본 COUNT', key: 'sourceCount', width: 12 },
      { header: '대상 COUNT', key: 'targetCount', width: 12 },
      { header: '판정', key: 'status', width: 10 },
      { header: '내용', key: 'detail', width: 50 },
    ],
    result.rows as unknown as Record<string, unknown>[]
  );
  sheet(
    '테이블스페이스',
    [
      { header: '종류', key: 'kind', width: 18 },
      { header: '테이블', key: 'table', width: 30 },
      { header: '오브젝트', key: 'object', width: 30 },
      { header: '파티션', key: 'partition', width: 16 },
      { header: '서브파티션', key: 'subpartition', width: 16 },
      { header: '원본', key: 'sourceTablespace', width: 18 },
      { header: '기대', key: 'expected', width: 18 },
      { header: '실제', key: 'actual', width: 18 },
      { header: '판정', key: 'status', width: 14 },
    ],
    result.tablespaces as unknown as Record<string, unknown>[]
  );
  sheet(
    '정리 점검',
    [
      { header: '분류', key: 'category', width: 12 },
      { header: '소유자', key: 'owner', width: 16 },
      { header: '이름', key: 'name', width: 30 },
      { header: '유형', key: 'type', width: 16 },
      { header: '테이블', key: 'table', width: 30 },
      { header: '파티션', key: 'partition', width: 16 },
      { header: '내용', key: 'detail', width: 40 },
      { header: '원본 대비', key: 'origin', width: 14 },
      { header: '조치 SQL', key: 'sql', width: 70 },
    ],
    result.findings as unknown as Record<string, unknown>[]
  );
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export { resolveScope, run, count, compile, listPlans, excel };
