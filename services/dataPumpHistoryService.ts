import * as dataPumpModel from '../models/dataPumpModel';
import * as historyModel from '../models/dataPumpHistoryModel';
import type { DataPumpHistoryRow, DataPumpHistoryStatus, ExpectedSpec, HistoryExtras, NewHistory } from '../models/dataPumpHistoryModel';
import { compareRows, parseErrorSummary, parseLogItems, reconcile } from './dataPumpLogVerify';
import type { LogItem } from './dataPumpLogVerify';
import { parseMasterRows, runnerOf } from './dataPumpMaster';
import type { MasterInfo, MasterRow, Runner } from './dataPumpMaster';
import type { DataPumpJob } from '../models/dataPumpModel';
import type { DataPumpPlan } from '../models/dataPumpModel';
import { logger } from '../utils/logger';

// Data Pump 작업 이력: 시작할 때 RUNNING으로 기록하고, 작업이 대상 DB에서 사라지면 로그를 읽어 마무리한다.
// 이력은 부가 기능이라 이력 저장/마무리가 실패해도 작업 자체(시작/취소/조회)는 막지 않는다.

// 이력 테이블(scripts/add_datapump_history.sql)이 아직 없는 환경이면 매분 에러 로그가 쌓이지 않게,
// 처음 한 번만 알리고 이 프로세스에서는 이력 기능을 쉰다.
let historyTableMissing = false;

function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && /ORA-00942|ORA-02289/.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function handleHistoryError(action: string, error: unknown): void {
  if (isMissingTable(error)) {
    if (!historyTableMissing) {
      logger.warn('DataPump', '작업 이력 테이블이 없어 이력 기능을 건너뜁니다 (scripts/add_datapump_history.sql 실행 필요)');
    }
    historyTableMissing = true;
    return;
  }
  logger.warn('DataPump', `작업 이력 ${action} 실패 (작업 자체에는 영향 없음)`, error);
}

// ── 로그 해석 (DB 접근 없는 순수 함수, 단위 테스트로 검증) ──

export interface ParsedLog {
  status: DataPumpHistoryStatus;
  elapsedSec: number | null;
  errorCount: number | null;
  resultMessage: string | null;
  dumpFiles: string[]; // 덤프 파일 이름 (경로 제외)
}

// expdp/impdp 로그의 마지막 결과 줄과 "Dump file set ... is:" 목록을 읽는다. 예:
//   Job "SYSTEM"."DBC_EXP_..." successfully completed at Fri Oct 2 07:49:21 2026 elapsed 0 00:00:35
//   Job "SYSTEM"."DBC_IMP_..." completed with 1 error(s) at Fri Oct 2 07:49:33 2026 elapsed 0 00:00:08
//   Job "SYSTEM"."X" stopped due to fatal error at ...
function parseDataPumpLog(text: string): ParsedLog {
  const lines = text.split(/\r?\n/);
  const resultLine = [...lines].reverse().find((line) => /^Job ".+"\.".+" .+ at /.test(line.trim()))?.trim() ?? null;

  let status: DataPumpHistoryStatus = 'UNKNOWN';
  let errorCount: number | null = null;
  if (resultLine) {
    const withErrors = resultLine.match(/completed with (\d+) error/);
    if (/successfully completed/.test(resultLine)) {
      status = 'COMPLETED';
      errorCount = 0;
    } else if (withErrors) {
      status = 'COMPLETED_WITH_ERRORS';
      errorCount = Number(withErrors[1]);
    } else if (/stopped due to fatal error/.test(resultLine)) {
      status = 'FAILED';
    } else if (/stopped|killed/i.test(resultLine)) {
      status = 'CANCELLED';
    }
  }

  let elapsedSec: number | null = null;
  const elapsed = resultLine?.match(/elapsed (\d+) (\d{1,2}):(\d{2}):(\d{2})/);
  if (elapsed) {
    elapsedSec = Number(elapsed[1]) * 86400 + Number(elapsed[2]) * 3600 + Number(elapsed[3]) * 60 + Number(elapsed[4]);
  }

  // "Dump file set for X is:" 다음 줄들(들여쓴 파일 경로)이 실제로 만들어진 덤프 파일.
  const dumpFiles: string[] = [];
  const start = lines.findIndex((line) => /^Dump file set for .+ is:/.test(line.trim()));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const path = line.trim();
      if (!path || path.startsWith('Job ') || path.startsWith('*')) break;
      const name = path.split(/[\\/]/).pop();
      if (name) dumpFiles.push(name);
    }
  }

  return { status, elapsedSec, errorCount, resultMessage: resultLine, dumpFiles };
}

// 이력 목록의 "대상" 칸에 남길 요약.
function describeTarget(plan: DataPumpPlan): string {
  const list = (expr: string | null) => (expr ?? '').replace(/^(NOT )?IN \(|\)$/g, '').replace(/'/g, '');
  const parts: string[] = [];
  if (plan.jobMode === 'SCHEMA') {
    parts.push(`SCHEMAS=${list(plan.schemaExpr)}`);
    if (plan.excludeTableExpr) parts.push(`제외 테이블 ${list(plan.excludeTableExpr).split(',').length}개`);
  } else if (plan.jobMode === 'TABLE') {
    // 실제 목록(소유자, 테이블) 기준 — 스키마가 하나면 이름만, 여럿이면 OWNER.TABLE
    const owners = [...new Set(plan.tables.map((pair) => pair.owner))];
    const names = plan.tables.map((pair) => (owners.length > 1 ? `${pair.owner}.${pair.table}` : pair.table));
    if (names.length > 0) {
      parts.push(`${owners.join(',')} 테이블 ${names.length}개: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ' …' : ''}`);
    }
  } else {
    parts.push('덤프 전체');
  }
  if (plan.partitionFilters.length > 0) {
    const single = plan.partitionFilters.length === 1;
    parts.push(`파티션 ${plan.partitionFilters.map((filter) => (single ? filter.partitions.join(',') : `${filter.table}:${filter.partitions.join(',')}`)).join(' ')}`);
  }
  if (plan.truncatePartitions.length > 0) parts.push(`비우고 넣음: ${plan.truncatePartitions.join(', ')}`);
  if (plan.networkLink) parts.push(`NETWORK_LINK=${plan.networkLink}`);
  parts.push(...plan.filters.summary); // INCLUDE/EXCLUDE, QUERY, SAMPLE, DATA_OPTIONS, VIEWS_AS_TABLES 요약
  for (const pair of plan.remapSchemas) parts.push(`REMAP_SCHEMA ${pair.from}→${pair.to}`);
  for (const pair of plan.remapTablespaces) parts.push(`REMAP_TABLESPACE ${pair.from}→${pair.to}`);
  return parts.join(' / ');
}

// ── DB를 거치는 기능 ──

async function recordStart(
  dbmsId: number | string,
  target: { dbname: string; user: string },
  plan: DataPumpPlan,
  startedBy: string | null,
  estimatedBytes: number | null,
  // 여러 스키마 작업을 스키마별로 나눠 실행한 하위 작업이면 묶음 정보 (화면은 jobName의 _S1, _S2…로 한 줄에 묶어 보여 줌)
  group: { jobName: string; index: number; count: number } | null = null,
  // export: 계획의 대상 목록(분할 계획에서) + 사용자가 확인하고 뺀 항목
  planInfo: { expected: string[] | null; acknowledged: { missing: string[]; filteredOut: string[]; by: string | null } | null } | null = null
): Promise<void> {
  if (historyTableMissing) return;
  // 실행 후 대조 기준. import TABLE 모드는 REMAP을 반영한 대상 테이블, 그 외 import는 같은 덤프를 만든 export 기록으로 (마무리할 때).
  const remap = plan.remapSchemas.map((pair) => ({ from: pair.from, to: pair.to }));
  const remapped = (owner: string) => remap.find((pair) => pair.from === owner)?.to ?? owner;
  const items =
    plan.operation === 'EXPORT'
      ? (planInfo?.expected ?? null)
      : plan.jobMode === 'TABLE' && plan.filters.viewsAsTables.length === 0
        ? plan.tables.map((pair) => `${remapped(pair.owner)}.${pair.table}`)
        : null;
  const extras: HistoryExtras = { expectedItems: { items, remap }, acknowledged: planInfo?.acknowledged ?? null };
  const row: NewHistory = {
    dbmsId,
    dbname: target.dbname,
    jobOwner: target.user.toUpperCase(),
    jobName: plan.jobName,
    operation: plan.operation,
    jobMode: plan.jobMode,
    targetDesc: `${group ? `[${group.jobName} 스키마별 ${group.index}/${group.count}] ` : ''}${describeTarget(plan)}`,
    directory: plan.directory,
    dumpfile: plan.dumpfile,
    logfile: plan.logfile,
    parallel: plan.parallel,
    tableExistsAction: plan.tableExistsAction,
    estimatedBytes,
    startedBy,
  };
  try {
    await historyModel.insertHistory(row, extras);
  } catch (error) {
    handleHistoryError('기록', error);
  }
}

async function recordCancel(dbmsId: number | string, owner: string, jobName: string, cancelledBy: string | null = null, external: { dbname: string; runner: Runner | null } | null = null): Promise<void> {
  if (historyTableMissing) return;
  try {
    const running = await historyModel.listRunning(dbmsId);
    if (external && !running.some((row) => row.jobOwner === owner && row.jobName === jobName)) {
      await recordExternal(dbmsId, external.dbname, { owner, jobName }, external.runner);
    }
    await historyModel.markCancelled(dbmsId, owner, jobName, cancelledBy);
  } catch (error) {
    handleHistoryError('취소 표시', error);
  }
}

// 덤프 파일 이름에 %U가 있으면 로그의 "Dump file set" 목록이 실제 이름이고, 없으면 지정한 이름 그대로다.
async function dumpBytesOf(row: DataPumpHistoryRow, parsed: ParsedLog): Promise<number | null> {
  const names = parsed.dumpFiles.length > 0 ? parsed.dumpFiles : !row.dumpfile || /%U/i.test(row.dumpfile) ? [] : [row.dumpfile];
  if (names.length === 0) return null;
  const sizes = await dataPumpModel.getFileSizes({ dbmsid: row.dbmsId }, row.directory, names);
  const values = Object.values(sizes);
  return values.length > 0 ? values.reduce((sum, size) => sum + size, 0) : null;
}

// ── 앱 밖에서 직접 돌린 작업 감시 ──
// 부하 원칙: 등록된 모든 DB를 매분 도는 게 아니라, Data Pump 화면을 최근 N분(기본 30분) 안에 연 DB와 이력에 진행 중(RUNNING)
// 작업이 있는 DB만 본다. 그 DB마다 DBA_DATAPUMP_JOBS 한 번 + (처음 보는 작업만) 마스터 테이블 메타 행 + 세션 정보.
const WATCH_MS = Math.max(1, Number(process.env.DATAPUMP_WATCH_MINUTES) || 30) * 60 * 1000;
const viewedAt = new Map<string, number>();

function markViewed(dbmsId: number | string): void {
  viewedAt.set(String(dbmsId), Date.now());
}

// 마스터 테이블 정보는 작업 중에 바뀌지 않으므로 작업마다 한 번만 읽는다 (작업 현황 15초 폴링이 매번 읽지 않게).
const masterCache = new Map<string, { at: number; info: MasterInfo | null }>();
const SAFE_NAME = /^[A-Za-z0-9_$#]{1,128}$/;

async function masterInfo(dbmsId: number | string, owner: string, jobName: string): Promise<MasterInfo | null> {
  const key = `${dbmsId}\u0001${owner}\u0001${jobName}`;
  const hit = masterCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.info;
  let info: MasterInfo | null = null;
  if (SAFE_NAME.test(owner) && SAFE_NAME.test(jobName)) {
    try {
      info = parseMasterRows((await dataPumpModel.getMasterRows({ dbmsid: dbmsId }, owner, jobName)) as MasterRow[], jobName);
    } catch {
      info = null; // 마스터 테이블을 못 읽는 권한/버전 — 로그 위치는 화면에서 직접 입력
    }
  }
  while (masterCache.size > 500) masterCache.delete(masterCache.keys().next().value as string);
  masterCache.set(key, { at: Date.now(), info });
  return info;
}

// 앱이 시작한 작업은 시작 직후 이력에 넣으므로, 방금 시작한 DBC_ 작업은 한 번 기다려 앱 작업을 외부로 잘못 적지 않게 한다.
const APP_JOB = /^DBC_(EXP|IMP)_/;
const APP_GRACE_MS = 2 * 60 * 1000;

async function recordExternal(dbmsId: number | string, dbname: string, job: { owner: string; jobName: string }, runner: Runner | null): Promise<boolean> {
  const info = await masterInfo(dbmsId, job.owner, job.jobName);
  if (APP_JOB.test(job.jobName) && info?.startedAt && Date.now() - new Date(info.startedAt.replace(' ', 'T')).getTime() < APP_GRACE_MS) return false;
  const row: NewHistory = {
    dbmsId,
    dbname,
    jobOwner: job.owner,
    jobName: job.jobName,
    operation: info?.operation ?? 'UNKNOWN',
    jobMode: info?.jobMode ?? 'UNKNOWN',
    targetDesc: info?.target ?? '[외부 실행]',
    directory: info?.logDirectory ?? info?.dumpDirectory ?? '',
    dumpfile: info?.dumpFiles.join(',') || null,
    logfile: info?.logFile ?? '',
    parallel: 1,
    tableExistsAction: null,
    estimatedBytes: null,
    startedBy: runner?.username ?? info?.userName ?? null,
  };
  return historyModel.insertHistory(
    row,
    { expectedItems: { items: info?.expected ?? null, remap: info?.remap ?? [] } },
    { source: 'EXTERNAL', runner, startedAt: info?.startedAt ?? null }
  );
}

// 감시 대상 DB에서 이력에 없는 진행 중 작업을 찾아 EXTERNAL로 한 줄 남긴다 (끝나면 아래 마무리 흐름이 그대로 로그를 읽어 채움).
async function discoverExternal(dbmsIds: string[], running: DataPumpHistoryRow[]): Promise<void> {
  for (const dbKey of dbmsIds) {
    if ((unreachableUntil.get(dbKey) ?? 0) > Date.now()) continue;
    try {
      const jobs = await dataPumpModel.listActiveJobs({ dbmsid: dbKey });
      const known = new Set(running.filter((row) => String(row.dbmsId) === dbKey).map((row) => `${row.jobOwner}.${row.jobName}`));
      const unknown = jobs.filter((job) => !known.has(`${job.owner}.${job.jobName}`));
      if (unknown.length === 0) continue;
      const sessions = await dataPumpModel.getJobSessions({ dbmsid: dbKey }, unknown);
      const target = await dataPumpModel.getTargetInfo({ dbmsid: dbKey });
      for (const job of unknown) {
        const runner = runnerOf(sessions.filter((s) => s.owner === job.owner && s.jobName === job.jobName));
        if (await recordExternal(dbKey, target.dbname, job, runner)) {
          logger.info('DataPump', `외부 작업 발견: ${target.dbname} ${job.owner}.${job.jobName} (${runner?.osuser ?? '?'}@${runner?.machine ?? '?'})`);
        }
      }
    } catch (error) {
      if (!unreachableUntil.has(dbKey)) logger.warn('DataPump', `외부 작업 확인 보류: dbmsid=${dbKey} — 10분 뒤 다시 확인`, error);
      unreachableUntil.set(dbKey, Date.now() + RETRY_AFTER_MS);
    }
  }
}

// 작업 현황 화면용: 앱/외부 구분, 실행자, 로그 위치 (외부 작업은 마스터 테이블에서)
export interface JobView extends DataPumpJob {
  source: 'APP' | 'EXTERNAL';
  runner: Runner | null;
  logDirectory: string | null;
  logFile: string | null;
  noLogfile: boolean;
}

async function describeJobs(dbmsId: number | string, jobs: DataPumpJob[]): Promise<JobView[]> {
  markViewed(dbmsId);
  if (jobs.length === 0) return [];
  let rows: DataPumpHistoryRow[] = [];
  try {
    rows = historyTableMissing ? [] : await historyModel.listRunning(dbmsId);
  } catch (error) {
    handleHistoryError('조회', error);
  }
  let sessions: Awaited<ReturnType<typeof dataPumpModel.getJobSessions>>;
  try {
    sessions = await dataPumpModel.getJobSessions({ dbmsid: dbmsId }, jobs);
  } catch {
    sessions = []; // 실행자 정보는 참고용 (DBA_DATAPUMP_SESSIONS/V$SESSION 권한이 없으면 비움)
  }
  const views: JobView[] = [];
  for (const job of jobs) {
    const row = rows.find((item) => item.jobOwner === job.owner && item.jobName === job.jobName);
    const external = !row || row.source === 'EXTERNAL';
    const info = !row || !row.logfile ? await masterInfo(dbmsId, job.owner, job.jobName) : null;
    const runner = runnerOf(sessions.filter((s) => s.owner === job.owner && s.jobName === job.jobName)) ?? row?.runner ?? null;
    const logDirectory = row?.logfile ? row.directory : (info?.logDirectory ?? null);
    const logFile = row?.logfile ? row.logfile : (info?.logFile ?? null);
    views.push({ ...job, source: external ? 'EXTERNAL' : 'APP', runner, logDirectory, logFile, noLogfile: !logFile });
  }
  return views;
}

// 마무리 때는 대조를 위해 로그를 넉넉히 읽는다 (화면 로그 보기는 512KB).
const FINISH_LOG_BYTES = 16 * 1024 * 1024;

// 실행 후 대조: 로그의 exported/imported 줄 vs 계획 대상, import는 같은 덤프를 만든 export의 행 수와도 비교. ORA- 요약도 남긴다.
async function verifyFinished(row: DataPumpHistoryRow, text: string, truncated: boolean): Promise<HistoryExtras> {
  const items = parseLogItems(text);
  const errorSummary = parseErrorSummary(text);
  if (truncated) {
    return { logItems: items, errorSummary, verifyStatus: 'NA', verifyDetail: { notInLog: [], notInPlan: [], skipped: [], rowDiffs: ['로그가 너무 커서 앞부분을 못 읽어 대조하지 못했습니다'] } };
  }
  const spec: ExpectedSpec = row.expectedItems ?? { items: null, remap: [] };
  let expected = spec.items;
  let rowDiffs: string[] = [];
  if (row.operation === 'IMPORT' && row.dumpfile) {
    const exported = (await historyModel.findExportLogItems(row.dumpfile)) as LogItem[] | null;
    if (exported) {
      const remap = new Map(spec.remap.map((pair) => [pair.from, pair.to]));
      // 대상을 따로 알 수 없으면(스키마/FULL) 덤프를 만든 export가 내보낸 것 전부가 들어와야 한다
      if (!expected) expected = [...new Set(exported.map((item) => `${remap.get(item.owner) ?? item.owner}.${item.table}${item.partition ? `:${item.partition}` : ''}`))];
      rowDiffs = compareRows(exported, items, spec.remap);
    }
  }
  const result = reconcile(expected, text);
  const status = result.status === 'NA' ? 'NA' : result.status === 'MATCH' && rowDiffs.length === 0 ? 'MATCH' : 'MISMATCH';
  return { logItems: items, errorSummary, verifyStatus: status, verifyDetail: { notInLog: result.notInLog, notInPlan: result.notInPlan, skipped: result.skipped, rowDiffs } };
}

// RUNNING으로 남아 있는 이력 중, 대상 DB에서 이미 사라진(끝난) 작업을 로그로 마무리한다.
// 같은 DB를 동시에 두 번 마무리하지 않도록 진행 중인 것은 건너뛴다.
const syncing = new Set<string>();

// 대상 DB에 못 붙으면(ORA-12170 접속 시간 초과 등) 스케줄러가 매분 접속 시간 초과를 기다리며 같은 경고를 쌓지 않도록,
// 그 DB는 잠시 건너뛰고 경고도 처음 한 번만 남긴다. 다시 붙으면 복구 로그를 한 번 남긴다.
const RETRY_AFTER_MS = 10 * 60 * 1000;
const unreachableUntil = new Map<string, number>();

async function syncRunning(dbmsId: number | string | null): Promise<void> {
  if (historyTableMissing) return;
  const key = String(dbmsId ?? 'ALL');
  if (syncing.has(key)) return;
  syncing.add(key);
  try {
    let running = await historyModel.listRunning(dbmsId);
    // 외부 작업 감시: 이 DB(화면에서 부른 경우) 또는 최근 화면을 연 DB + 진행 중 이력이 있는 DB
    const now = Date.now();
    const watched = dbmsId !== null
      ? [String(dbmsId)]
      : [...new Set([...[...viewedAt].filter(([, at]) => now - at < WATCH_MS).map(([id]) => id), ...running.map((row) => String(row.dbmsId))])];
    if (watched.length > 0) {
      await discoverExternal(watched, running);
      running = await historyModel.listRunning(dbmsId);
    }
    const failedNow = new Set<string>();
    for (const row of running) {
      const dbKey = String(row.dbmsId);
      if (failedNow.has(dbKey) || (unreachableUntil.get(dbKey) ?? 0) > Date.now()) continue;
      try {
        const stillRunning = await dataPumpModel.jobExists({ dbmsid: row.dbmsId }, row.jobOwner ?? '', row.jobName);
        if (unreachableUntil.delete(dbKey)) logger.info('DataPump', `작업 이력 확인 재개: ${row.dbname} 접속 복구`);
        if (stillRunning) continue;
        // NOLOGFILE로 직접 돌린 작업은 로그가 없다 — 끝났다는 것만 남긴다
        const log = row.logfile
          ? await dataPumpModel.readLog({ dbmsid: row.dbmsId }, row.directory, row.logfile, FINISH_LOG_BYTES)
          : { exists: false, text: '', truncated: false };
        const parsed = log.exists
          ? parseDataPumpLog(log.text)
          : { status: 'UNKNOWN' as const, elapsedSec: null, errorCount: null, resultMessage: row.logfile ? '로그 파일을 찾을 수 없음' : '로그 없음 (NOLOGFILE)', dumpFiles: [] };
        const dumpBytes = row.operation === 'EXPORT' && parsed.status !== 'UNKNOWN' ? await dumpBytesOf(row, parsed) : null;
        const extras = log.exists ? await verifyFinished(row, log.text, log.truncated) : {};
        await historyModel.finishHistory(
          row.id,
          {
            status: parsed.status,
            elapsedSec: parsed.elapsedSec,
            errorCount: parsed.errorCount,
            resultMessage: parsed.resultMessage,
            dumpBytes,
          },
          extras
        );
      } catch (error) {
        // 대상 DB에 못 붙는 경우 등 — 그 DB의 나머지 작업도 이번엔 건너뛰고 10분 뒤 다시 확인한다.
        failedNow.add(dbKey);
        if (!unreachableUntil.has(dbKey)) {
          logger.warn('DataPump', `작업 이력 마무리 보류: ${row.dbname} 확인 실패 (${row.jobName}) — 10분 뒤 다시 확인, 그동안 이 경고는 생략`, error);
        }
        unreachableUntil.set(dbKey, Date.now() + RETRY_AFTER_MS);
      }
    }
  } catch (error) {
    handleHistoryError('마무리', error);
  } finally {
    syncing.delete(key);
  }
}

export interface HistoryResponse {
  available: boolean; // 이력 테이블이 없으면 false
  rows: DataPumpHistoryRow[];
  throughput: { exportBytesPerSec: number | null; samples: number };
}

async function getHistory(dbmsId: number | string, limit = 100, includeExternal = false): Promise<HistoryResponse> {
  markViewed(dbmsId);
  const empty: HistoryResponse = { available: false, rows: [], throughput: { exportBytesPerSec: null, samples: 0 } };
  if (historyTableMissing) return empty;
  await syncRunning(dbmsId);
  try {
    const [rows, exportSpeed] = await Promise.all([historyModel.listHistory(dbmsId, limit), historyModel.getExportThroughput(dbmsId, includeExternal)]);
    return { available: true, rows, throughput: { exportBytesPerSec: exportSpeed.bytesPerSec, samples: exportSpeed.samples } };
  } catch (error) {
    handleHistoryError('조회', error);
    if (historyTableMissing) return empty;
    throw new Error('Data Pump 작업 이력 조회 실패', { cause: error });
  }
}

export { parseDataPumpLog, describeTarget, recordStart, recordCancel, syncRunning, getHistory, describeJobs, markViewed };
