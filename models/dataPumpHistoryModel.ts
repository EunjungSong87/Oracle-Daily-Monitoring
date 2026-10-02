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
  dumpfile: string;
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
  dumpfile: string;
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
  };
}

const SELECT_COLUMNS = `id, dbms_id, dbname, job_owner, job_name, operation, job_mode, target_desc, directory_name, dumpfile, logfile,
       parallel_degree, table_exists_action, estimated_bytes, dump_bytes, started_by,
       TO_CHAR(started_at, '${TS}') AS started_at, status, TO_CHAR(finished_at, '${TS}') AS finished_at,
       elapsed_sec, error_count, result_message`;

async function insertHistory(row: NewHistory): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `INSERT INTO system.datapump_job_history
         (id, dbms_id, dbname, job_owner, job_name, operation, job_mode, target_desc, directory_name, dumpfile, logfile,
          parallel_degree, table_exists_action, estimated_bytes, started_by, started_at, status)
       VALUES
         (system.seq_datapump_job_history.NEXTVAL, :dbmsId, :dbname, :jobOwner, :jobName, :operation, :jobMode,
          SUBSTR(:targetDesc, 1, 4000), :directory, :dumpfile, :logfile, :parallel, :tableExistsAction, :estimatedBytes,
          :startedBy, SYSDATE, 'RUNNING')`,
      { ...row, dbmsId: Number(row.dbmsId) },
      { autoCommit: true }
    );
  });
}

async function listHistory(dbmsId: number | string | null, limit: number): Promise<DataPumpHistoryRow[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT ${SELECT_COLUMNS}
           FROM system.datapump_job_history
          WHERE (:dbmsId IS NULL OR dbms_id = :dbmsId)
          ORDER BY started_at DESC, id DESC
       ) WHERE ROWNUM <= :limit`,
      { dbmsId: dbmsId === null ? null : Number(dbmsId), limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map(mapRow);
  });
}

async function listRunning(dbmsId: number | string | null): Promise<DataPumpHistoryRow[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT ${SELECT_COLUMNS}
         FROM system.datapump_job_history
        WHERE status = 'RUNNING'
          AND (:dbmsId IS NULL OR dbms_id = :dbmsId)`,
      { dbmsId: dbmsId === null ? null : Number(dbmsId) },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map(mapRow);
  });
}

// 끝난 작업을 마무리합니다. 끝난 시각은 시작 시각 + 로그의 수행 시간(없으면 지금).
async function finishHistory(id: number, finished: FinishedHistory): Promise<void> {
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
  });
}

// 화면에서 취소한 작업: 바로 CANCELLED로 표시 (로그를 기다리지 않음).
async function markCancelled(dbmsId: number | string, jobOwner: string, jobName: string): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `UPDATE system.datapump_job_history
          SET status = 'CANCELLED', finished_at = SYSDATE,
              elapsed_sec = ROUND((SYSDATE - started_at) * 86400), result_message = '화면에서 취소됨'
        WHERE dbms_id = :dbmsId AND job_owner = :jobOwner AND job_name = :jobName AND status = 'RUNNING'`,
      { dbmsId: Number(dbmsId), jobOwner, jobName },
      { autoCommit: true }
    );
  });
}

// 그 DB에서 최근에 성공한 export들의 평균 처리 속도 (바이트/초). 분할 계획의 예상 크기(세그먼트 크기)에 곱해 쓰므로
// 같은 기준인 시작 때 예상 크기 ÷ 수행 시간으로 계산한다 (예상 크기가 없던 작업만 실제 덤프 크기).
// 합 ÷ 합이라 작은 작업 하나가 평균을 크게 흔들지 않고, 30초 미만 작업은 시작/마무리 고정 비용 비중이 커서 뺀다.
async function getExportThroughput(dbmsId: number | string): Promise<{ bytesPerSec: number | null; samples: number }> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT SUM(bytes) AS bytes, SUM(elapsed_sec) AS secs, COUNT(*) AS samples
         FROM (SELECT NVL(estimated_bytes, dump_bytes) AS bytes, elapsed_sec
                 FROM system.datapump_job_history
                WHERE dbms_id = :dbmsId AND operation = 'EXPORT'
                  AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
                  AND NVL(estimated_bytes, dump_bytes) > 0 AND elapsed_sec >= 30
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

export { insertHistory, listHistory, listRunning, finishHistory, markCancelled, getExportThroughput };
