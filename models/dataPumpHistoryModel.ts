import oracledb from 'oracledb';
import * as db from '../db';

// Data Pump 작업 이력 (메타데이터 DB의 system.datapump_job_history — scripts/add_datapump_history.sql).

export type DataPumpHistoryStatus = 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export interface DataPumpHistoryRow {
  id: number;
  dbmsId: number;
  dbname: string | null;
  jobOwner: string | null;
  jobName: string;
  operation: string;
  jobMode: string;
  targetDesc: string | null;
  directory: string;
  dumpfile: string | null; // NETWORK_LINK import는 없음
  logfile: string;
  parallel: number | null;
  tableExistsAction: string | null;
  estimatedBytes: number | null;
  dumpBytes: number | null;
  startedBy: string | null;
  startedAt: string | null; // 'YYYY-MM-DD HH24:MI:SS'
  status: DataPumpHistoryStatus;
  finishedAt: string | null;
  elapsedSec: number | null;
  errorCount: number | null;
  resultMessage: string | null;
  // scripts/add_datapump_history_verify.sql 컬럼 (없는 환경이면 null)
  expectedItems: ExpectedSpec | null;
  acknowledged: { missing: string[]; filteredOut: string[]; by: string | null } | null;
  verifyStatus: 'MATCH' | 'MISMATCH' | 'NA' | null;
  verifyDetail: { notInLog: string[]; notInPlan: string[]; skipped: string[]; rowDiffs: string[] } | null;
  errorSummary: string | null;
  // scripts/add_datapump_history_external.sql 컬럼 (없는 환경이면 APP / null)
  source: 'APP' | 'EXTERNAL';
  runner: { username: string | null; osuser: string | null; machine: string | null; program: string | null } | null;
  firstSeenAt: string | null;
  cancelledBy: string | null;
  // scripts/add_datapump_bundle.sql 컬럼 (없는 환경이면 null)
  bundleId: string | null;
  bundleJobNo: number | null;
}

// 외부 작업 기록용 (컬럼이 있을 때만 저장)
export interface ExternalExtras {
  source: 'APP' | 'EXTERNAL';
  runner: { username: string | null; osuser: string | null; machine: string | null; program: string | null } | null;
  startedAt: string | null; // 마스터 테이블의 작업 시작 시각
}

// 실행 후 대조 기준: 대상 목록(OWNER.TABLE / OWNER.TABLE:PART, 모르면 null)과 import의 REMAP_SCHEMA
export interface ExpectedSpec {
  items: string[] | null;
  remap: { from: string; to: string }[];
}

// 대조용 추가 정보 (컬럼이 있을 때만 저장)
export interface HistoryExtras {
  expectedItems?: ExpectedSpec | null;
  acknowledged?: { missing: string[]; filteredOut: string[]; by: string | null } | null;
  logItems?: unknown[] | null;
  verifyStatus?: 'MATCH' | 'MISMATCH' | 'NA' | null;
  verifyDetail?: { notInLog: string[]; notInPlan: string[]; skipped: string[]; rowDiffs: string[] } | null;
  errorSummary?: string | null;
  // scripts/add_datapump_bundle.sql 컬럼 (있을 때만 저장)
  bundleId?: string | null;
  bundleJobNo?: number | null;
  request?: unknown;
  dumpFiles?: { name: string; bytes: number | null }[] | null;
}

export interface NewHistory {
  dbmsId: number | string;
  dbname: string;
  jobOwner: string;
  jobName: string;
  operation: string;
  jobMode: string;
  targetDesc: string;
  directory: string;
  dumpfile: string | null;
  logfile: string;
  parallel: number;
  tableExistsAction: string | null;
  estimatedBytes: number | null;
  startedBy: string | null;
}

export interface FinishedHistory {
  status: DataPumpHistoryStatus;
  elapsedSec: number | null;
  errorCount: number | null;
  resultMessage: string | null;
  dumpBytes: number | null;
}

const TS = 'YYYY-MM-DD HH24:MI:SS';

// scripts/add_datapump_history_verify.sql로 추가하는 컬럼. 아직 안 돌린 환경에서도 앱이 죽지 않게, 실제로 있는 컬럼만 쓴다.
// (ALTER를 나중에 돌려도 재시작 없이 반영되도록 10분마다 다시 확인)
const EXTRA_COLUMNS = ['ACKNOWLEDGED_EXCLUDED', 'EXPECTED_ITEMS', 'LOG_ITEMS', 'VERIFY_STATUS', 'VERIFY_DETAIL', 'ERROR_SUMMARY'];
let extraCache: { at: number; has: boolean } | null = null;
const EXTERNAL_COLUMNS = ['SOURCE', 'RUN_DB_USER', 'RUN_OS_USER', 'RUN_MACHINE', 'RUN_PROGRAM', 'FIRST_SEEN_AT', 'CANCELLED_BY'];
let externalCache: { at: number; has: boolean } | null = null;
const BUNDLE_COLUMNS = ['BUNDLE_ID', 'BUNDLE_JOB_NO', 'REQUEST_JSON', 'DUMP_FILES'];
let bundleCache: { at: number; has: boolean } | null = null;

// scripts/add_datapump_bundle.sql 컬럼이 있는지 (없으면 묶음/요청/덤프 파일 정보는 남기지 않음 — Import 생성에 못 씀)
async function hasBundleColumns(connection: oracledb.Connection): Promise<boolean> {
  if (bundleCache && Date.now() - bundleCache.at < 10 * 60 * 1000) return bundleCache.has;
  const result = await connection.execute<Record<string, any>>(
    `SELECT COUNT(*) AS n FROM all_tab_columns
      WHERE owner = 'SYSTEM' AND table_name = 'DATAPUMP_JOB_HISTORY' AND column_name IN (${BUNDLE_COLUMNS.map((c) => `'${c}'`).join(',')})`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  bundleCache = { at: Date.now(), has: Number(result.rows?.[0]?.N ?? 0) === BUNDLE_COLUMNS.length };
  return bundleCache.has;
}

// scripts/add_datapump_history_external.sql 컬럼이 있는지 (없으면 외부 작업은 이력에 남기지 않음)
async function hasExternalColumns(connection: oracledb.Connection): Promise<boolean> {
  if (externalCache && Date.now() - externalCache.at < 10 * 60 * 1000) return externalCache.has;
  const result = await connection.execute<Record<string, any>>(
    `SELECT COUNT(*) AS n FROM all_tab_columns
      WHERE owner = 'SYSTEM' AND table_name = 'DATAPUMP_JOB_HISTORY' AND column_name IN (${EXTERNAL_COLUMNS.map((c) => `'${c}'`).join(',')})`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  externalCache = { at: Date.now(), has: Number(result.rows?.[0]?.N ?? 0) === EXTERNAL_COLUMNS.length };
  return externalCache.has;
}

const EXTERNAL_SELECT = `, source, run_db_user, run_os_user, run_machine, run_program, TO_CHAR(first_seen_at, 'YYYY-MM-DD HH24:MI:SS') AS first_seen_at, cancelled_by`;

async function extraSelect(connection: oracledb.Connection): Promise<string> {
  return `${(await hasExtraColumns(connection)) ? EXTRA_SELECT : ''}${(await hasExternalColumns(connection)) ? EXTERNAL_SELECT : ''}${(await hasBundleColumns(connection)) ? ', bundle_id, bundle_job_no' : ''}`;
}

async function hasExtraColumns(connection: oracledb.Connection): Promise<boolean> {
  if (extraCache && Date.now() - extraCache.at < 10 * 60 * 1000) return extraCache.has;
  const result = await connection.execute<Record<string, any>>(
    `SELECT COUNT(*) AS n FROM all_tab_columns
      WHERE owner = 'SYSTEM' AND table_name = 'DATAPUMP_JOB_HISTORY' AND column_name IN (${EXTRA_COLUMNS.map((c) => `'${c}'`).join(',')})`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  extraCache = { at: Date.now(), has: Number(result.rows?.[0]?.N ?? 0) === EXTRA_COLUMNS.length };
  return extraCache.has;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

const EXTRA_SELECT = `, acknowledged_excluded, expected_items, verify_status, verify_detail, error_summary`;
const EXTRA_FETCH = {
  ACKNOWLEDGED_EXCLUDED: { type: oracledb.STRING },
  EXPECTED_ITEMS: { type: oracledb.STRING },
  VERIFY_DETAIL: { type: oracledb.STRING },
};

async function saveExtras(connection: oracledb.Connection, id: number, extras: HistoryExtras): Promise<void> {
  await saveBundleExtras(connection, id, extras);
  if (!(await hasExtraColumns(connection))) return;
  const sets: string[] = [];
  const binds: Record<string, oracledb.BindParameter | string | number | null> = { id };
  const json = (name: string, column: string, value: unknown) => {
    if (value === undefined) return;
    sets.push(`${column} = :${name}`);
    binds[name] = { val: value === null ? null : JSON.stringify(value), type: oracledb.CLOB };
  };
  json('ack', 'acknowledged_excluded', extras.acknowledged);
  json('expected', 'expected_items', extras.expectedItems);
  json('logItems', 'log_items', extras.logItems);
  json('detail', 'verify_detail', extras.verifyDetail);
  if (extras.verifyStatus !== undefined) {
    sets.push('verify_status = :verifyStatus');
    binds.verifyStatus = extras.verifyStatus ?? null;
  }
  if (extras.errorSummary !== undefined) {
    sets.push('error_summary = SUBSTR(:errorSummary, 1, 4000)');
    binds.errorSummary = extras.errorSummary ?? null;
  }
  if (sets.length === 0) return;
  await connection.execute(`UPDATE system.datapump_job_history SET ${sets.join(', ')} WHERE id = :id`, binds as oracledb.BindParameters, { autoCommit: true });
}

async function saveBundleExtras(connection: oracledb.Connection, id: number, extras: HistoryExtras): Promise<void> {
  if (extras.bundleId === undefined && extras.request === undefined && extras.dumpFiles === undefined) return;
  if (!(await hasBundleColumns(connection))) return;
  const sets: string[] = [];
  const binds: Record<string, oracledb.BindParameter | string | number | null> = { id };
  if (extras.bundleId !== undefined) {
    sets.push('bundle_id = :bundleId', 'bundle_job_no = :bundleJobNo');
    binds.bundleId = extras.bundleId;
    binds.bundleJobNo = extras.bundleJobNo ?? null;
  }
  if (extras.request !== undefined) {
    sets.push('request_json = :request');
    binds.request = { val: extras.request === null ? null : JSON.stringify(extras.request), type: oracledb.CLOB };
  }
  if (extras.dumpFiles !== undefined) {
    sets.push('dump_files = :dumpFiles');
    binds.dumpFiles = { val: extras.dumpFiles === null ? null : JSON.stringify(extras.dumpFiles), type: oracledb.CLOB };
  }
  await connection.execute(`UPDATE system.datapump_job_history SET ${sets.join(', ')} WHERE id = :id`, binds as oracledb.BindParameters, { autoCommit: true });
}

async function withPool<T>(work: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    return await work(connection);
  } finally {
    if (connection) await connection.close();
  }
}

function mapRow(row: Record<string, any>): DataPumpHistoryRow {
  return {
    id: row.ID,
    dbmsId: row.DBMS_ID,
    dbname: row.DBNAME,
    jobOwner: row.JOB_OWNER,
    jobName: row.JOB_NAME,
    operation: row.OPERATION,
    jobMode: row.JOB_MODE,
    targetDesc: row.TARGET_DESC,
    directory: row.DIRECTORY_NAME,
    dumpfile: row.DUMPFILE,
    logfile: row.LOGFILE,
    parallel: row.PARALLEL_DEGREE,
    tableExistsAction: row.TABLE_EXISTS_ACTION,
    estimatedBytes: row.ESTIMATED_BYTES,
    dumpBytes: row.DUMP_BYTES,
    startedBy: row.STARTED_BY,
    startedAt: row.STARTED_AT,
    status: row.STATUS,
    finishedAt: row.FINISHED_AT,
    elapsedSec: row.ELAPSED_SEC,
    errorCount: row.ERROR_COUNT,
    resultMessage: row.RESULT_MESSAGE,
    expectedItems: parseJson<ExpectedSpec>(row.EXPECTED_ITEMS),
    acknowledged: parseJson(row.ACKNOWLEDGED_EXCLUDED),
    verifyStatus: row.VERIFY_STATUS ?? null,
    verifyDetail: parseJson(row.VERIFY_DETAIL),
    errorSummary: row.ERROR_SUMMARY ?? null,
    source: row.SOURCE === 'EXTERNAL' ? 'EXTERNAL' : 'APP',
    runner:
      row.RUN_DB_USER || row.RUN_OS_USER || row.RUN_MACHINE || row.RUN_PROGRAM
        ? { username: row.RUN_DB_USER ?? null, osuser: row.RUN_OS_USER ?? null, machine: row.RUN_MACHINE ?? null, program: row.RUN_PROGRAM ?? null }
        : null,
    firstSeenAt: row.FIRST_SEEN_AT ?? null,
    cancelledBy: row.CANCELLED_BY ?? null,
    bundleId: row.BUNDLE_ID ?? null,
    bundleJobNo: row.BUNDLE_JOB_NO ?? null,
  };
}

const SELECT_COLUMNS = `id, dbms_id, dbname, job_owner, job_name, operation, job_mode, target_desc, directory_name, dumpfile, logfile,
       parallel_degree, table_exists_action, estimated_bytes, dump_bytes, started_by,
       TO_CHAR(started_at, '${TS}') AS started_at, status, TO_CHAR(finished_at, '${TS}') AS finished_at,
       elapsed_sec, error_count, result_message`;

// 외부 작업인데 이력 컬럼이 없으면 false (기록하지 않음)
async function insertHistory(row: NewHistory, extras: HistoryExtras = {}, external: ExternalExtras | null = null): Promise<boolean> {
  return withPool(async (connection) => {
    if (external?.source === 'EXTERNAL' && !(await hasExternalColumns(connection))) return false;
    const result = await connection.execute<{ id: number[] }>(
      `INSERT INTO system.datapump_job_history
         (id, dbms_id, dbname, job_owner, job_name, operation, job_mode, target_desc, directory_name, dumpfile, logfile,
          parallel_degree, table_exists_action, estimated_bytes, started_by, started_at, status)
       VALUES
         (system.seq_datapump_job_history.NEXTVAL, :dbmsId, :dbname, :jobOwner, :jobName, :operation, :jobMode,
          SUBSTR(:targetDesc, 1, 4000), :directory, :dumpfile, :logfile, :parallel, :tableExistsAction, :estimatedBytes,
          :startedBy, SYSDATE, 'RUNNING')
       RETURNING id INTO :newId`,
      { ...row, dbmsId: Number(row.dbmsId), newId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } },
      { autoCommit: true }
    );
    const newId = (result.outBinds as unknown as { newId: number[] } | undefined)?.newId?.[0];
    if (newId !== undefined) await saveExtras(connection, newId, extras);
    if (newId !== undefined && external && (await hasExternalColumns(connection))) {
      await connection.execute(
        `UPDATE system.datapump_job_history
            SET source = :source, run_db_user = :dbUser, run_os_user = :osUser, run_machine = SUBSTR(:machine, 1, 200),
                run_program = SUBSTR(:program, 1, 200), first_seen_at = SYSDATE,
                started_at = NVL(TO_DATE(:startedAt, '${TS}'), started_at)
          WHERE id = :id`,
        {
          id: newId,
          source: external.source,
          dbUser: external.runner?.username ?? null,
          osUser: external.runner?.osuser ?? null,
          machine: external.runner?.machine ?? null,
          program: external.runner?.program ?? null,
          startedAt: external.startedAt,
        },
        { autoCommit: true }
      );
    }
    return true;
  });
}

async function listHistory(dbmsId: number | string | null, limit: number): Promise<DataPumpHistoryRow[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT ${SELECT_COLUMNS}${await extraSelect(connection)}
           FROM system.datapump_job_history
          WHERE (:dbmsId IS NULL OR dbms_id = :dbmsId)
          ORDER BY started_at DESC, id DESC
       ) WHERE ROWNUM <= :limit`,
      { dbmsId: dbmsId === null ? null : Number(dbmsId), limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: EXTRA_FETCH }
    );
    return (result.rows ?? []).map(mapRow);
  });
}

async function listRunning(dbmsId: number | string | null): Promise<DataPumpHistoryRow[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT ${SELECT_COLUMNS}${await extraSelect(connection)}
         FROM system.datapump_job_history
        WHERE status = 'RUNNING'
          AND (:dbmsId IS NULL OR dbms_id = :dbmsId)`,
      { dbmsId: dbmsId === null ? null : Number(dbmsId) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: EXTRA_FETCH }
    );
    return (result.rows ?? []).map(mapRow);
  });
}

// 끝난 작업을 마무리합니다. 끝난 시각은 시작 시각 + 로그의 수행 시간(없으면 지금).
async function finishHistory(id: number, finished: FinishedHistory, extras: HistoryExtras = {}): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `UPDATE system.datapump_job_history
          SET status = :status,
              elapsed_sec = :elapsedSec,
              error_count = :errorCount,
              result_message = SUBSTR(:resultMessage, 1, 1000),
              dump_bytes = :dumpBytes,
              finished_at = CASE WHEN :elapsedSec IS NOT NULL THEN started_at + :elapsedSec / 86400 ELSE SYSDATE END
        WHERE id = :id AND status = 'RUNNING'`,
      { id, ...finished },
      { autoCommit: true }
    );
    await saveExtras(connection, id, extras);
  });
}

// 화면에서 취소한 작업: 바로 CANCELLED로 표시 (로그를 기다리지 않음).
async function markCancelled(dbmsId: number | string, jobOwner: string, jobName: string, cancelledBy: string | null = null): Promise<void> {
  await withPool(async (connection) => {
    const by = (await hasExternalColumns(connection)) ? ', cancelled_by = :cancelledBy' : '';
    await connection.execute(
      `UPDATE system.datapump_job_history
          SET status = 'CANCELLED', finished_at = SYSDATE,
              elapsed_sec = ROUND((SYSDATE - started_at) * 86400), result_message = SUBSTR('화면에서 취소됨' || NVL2(:cancelledBy, ' (' || :cancelledBy || ')', ''), 1, 1000)${by}
        WHERE dbms_id = :dbmsId AND job_owner = :jobOwner AND job_name = :jobName AND status = 'RUNNING'`,
      { dbmsId: Number(dbmsId), jobOwner, jobName, cancelledBy },
      { autoCommit: true }
    );
  });
}

// 그 DB에서 최근에 성공한 export들의 평균 처리 속도 (바이트/초). 분할 계획의 예상 크기(세그먼트 크기)에 곱해 쓰므로
// 같은 기준인 시작 때 예상 크기 ÷ 수행 시간으로 계산한다 (예상 크기가 없던 작업만 실제 덤프 크기).
// 합 ÷ 합이라 작은 작업 하나가 평균을 크게 흔들지 않고, 30초 미만 작업은 시작/마무리 고정 비용 비중이 커서 뺀다.
// includeExternal: 직접 돌린 작업(source=EXTERNAL) 기록도 평균에 넣을지 (기본은 앱에서 시작한 작업만)
async function getExportThroughput(dbmsId: number | string, includeExternal = false): Promise<{ bytesPerSec: number | null; samples: number }> {
  return withPool(async (connection) => {
    const sourceFilter = !includeExternal && (await hasExternalColumns(connection)) ? "AND NVL(source, 'APP') = 'APP'" : '';
    const result = await connection.execute<Record<string, any>>(
      `SELECT SUM(bytes) AS bytes, SUM(elapsed_sec) AS secs, COUNT(*) AS samples
         FROM (SELECT NVL(estimated_bytes, dump_bytes) AS bytes, elapsed_sec
                 FROM system.datapump_job_history
                WHERE dbms_id = :dbmsId AND operation = 'EXPORT'
                  AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
                  AND NVL(estimated_bytes, dump_bytes) > 0 AND elapsed_sec >= 30 ${sourceFilter}
                ORDER BY started_at DESC)
        WHERE ROWNUM <= 20`,
      { dbmsId: Number(dbmsId) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    const samples = Number(row?.SAMPLES ?? 0);
    const secs = Number(row?.SECS ?? 0);
    return { bytesPerSec: samples > 0 && secs > 0 ? Number(row?.BYTES) / secs : null, samples };
  });
}

// 이 덤프 파일을 만든 가장 최근 export의 로그 줄(테이블별 행 수) — import 대조용. 어느 DB에서 export했든 덤프 이름으로 찾는다.
async function findExportLogItems(dumpfile: string): Promise<unknown[] | null> {
  return withPool(async (connection) => {
    if (!(await hasExtraColumns(connection))) return null;
    const result = await connection.execute<Record<string, any>>(
      `SELECT log_items FROM (
         SELECT log_items FROM system.datapump_job_history
          WHERE operation = 'EXPORT' AND dumpfile = :dumpfile AND log_items IS NOT NULL
          ORDER BY started_at DESC
       ) WHERE ROWNUM = 1`,
      { dumpfile },
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { LOG_ITEMS: { type: oracledb.STRING } } }
    );
    return parseJson<unknown[]>(result.rows?.[0]?.LOG_ITEMS);
  });
}

export interface CompletedExportRow {
  id: number;
  jobName: string;
  jobMode: string;
  status: string;
  directory: string;
  dumpfile: string | null;
  startedAt: string | null;
  targetDesc: string | null;
  request: Record<string, any> | null; // add_datapump_bundle.sql 이후 앱이 남긴 요청 (없으면 null)
  expected: string[] | null; // add_datapump_history_verify.sql의 대조용 대상 목록 (없으면 null)
  bundleId: string | null; // 분할 묶음 (add_datapump_bundle.sql 이후)
  bundleJobs: number; // 그 묶음의 Export 작업 수 (묶음이 없으면 1)
}

// Import 탭 "기존 Export에서 가져오기": 이 DB에서 끝난 Export (메타 DB만 — 대상 DB는 읽지 않음). 추가 컬럼은 있을 때만 읽는다.
async function listCompletedExports(dbmsId: number | string, historyId: number | null = null): Promise<CompletedExportRow[]> {
  return withPool(async (connection) => {
    const bundle = await hasBundleColumns(connection);
    const extra = await hasExtraColumns(connection);
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT id, job_name, job_mode, status, directory_name, dumpfile, TO_CHAR(started_at, '${TS}') AS started_at, target_desc
                ${bundle ? ", request_json, bundle_id, (SELECT COUNT(*) FROM system.datapump_job_history b WHERE b.bundle_id = h.bundle_id AND b.operation = 'EXPORT') AS bundle_jobs" : ''}${extra ? ', expected_items' : ''}
           FROM system.datapump_job_history h
          WHERE dbms_id = :dbmsId AND operation = 'EXPORT' AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
            AND (:historyId IS NULL OR id = :historyId)
          ORDER BY started_at DESC, id DESC
       ) WHERE ROWNUM <= 100`,
      { dbmsId: Number(dbmsId), historyId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { REQUEST_JSON: { type: oracledb.STRING }, EXPECTED_ITEMS: { type: oracledb.STRING } } }
    );
    return (result.rows ?? []).map((row) => ({
      id: row.ID,
      jobName: row.JOB_NAME,
      jobMode: row.JOB_MODE,
      status: row.STATUS,
      directory: row.DIRECTORY_NAME,
      dumpfile: row.DUMPFILE ?? null,
      startedAt: row.STARTED_AT,
      targetDesc: row.TARGET_DESC ?? null,
      request: parseJson(row.REQUEST_JSON),
      expected: parseJson<ExpectedSpec>(row.EXPECTED_ITEMS)?.items ?? null,
      bundleId: row.BUNDLE_ID ?? null,
      bundleJobs: row.BUNDLE_ID ? Number(row.BUNDLE_JOBS ?? 1) : 1,
    }));
  });
}

export { listCompletedExports };
export { insertHistory, listHistory, listRunning, finishHistory, markCancelled, getExportThroughput, findExportLogItems, hasBundleColumns, withPool, parseJson };
