import oracledb from 'oracledb';
import * as db from '../db';

// 첫 화면(전체 DB 현황) — 메타데이터 DB만 읽는다 (대상 DB 접속 없음).

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

async function rows(connection: oracledb.Connection, sql: string, binds: oracledb.BindParameters = {}, options: oracledb.ExecuteOptions = {}): Promise<Record<string, any>[]> {
  const result = await connection.execute<Record<string, any>>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, ...options });
  return result.rows ?? [];
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /ORA-00942/.test(error.message);
}

export interface DashboardRaw {
  dbmses: Record<string, any>[]; // ID, DBNAME, MEMO, AUTO_SCHEDULE
  latestRuns: Record<string, any>[]; // DB별 최근 점검 1건 (결과 JSON 포함)
  latestScheduled: Record<string, any>[]; // DB별 최근 예약 점검 1건
  issues: Record<string, any>[]; // DBMS_ID, CLEVEL, STATUS, N (해결 안 된 것)
  dataPump: Record<string, any>[] | null; // DB별 진행 중 + 최근 작업 (이력 테이블 없으면 null)
  schedule: Record<string, any> | null; // 예약 실행 설정
}

async function loadDashboard(): Promise<DashboardRaw> {
  return withPool(async (connection) => {
    const dbmses = await rows(connection, `SELECT id, dbname, memo, auto_schedule FROM system.monitoring_dbms_list ORDER BY dbname`);
    // DB별 최근 점검 — (dbms_id, run_at) 인덱스로 DB마다 가장 늦은 한 건만
    const latestRuns = await rows(
      connection,
      `SELECT h.id, h.dbms_id, h.run_at, h.trigger_type, h.success_count, h.fail_count, h.results
         FROM system.monitoring_run_history h
        WHERE h.id IN (SELECT MAX(id) KEEP (DENSE_RANK LAST ORDER BY run_at) FROM system.monitoring_run_history GROUP BY dbms_id)`,
      {},
      { fetchInfo: { RESULTS: { type: oracledb.STRING } } }
    );
    const latestScheduled = await rows(
      connection,
      `SELECT dbms_id, MAX(run_at) KEEP (DENSE_RANK LAST ORDER BY run_at) AS run_at,
              MAX(fail_count) KEEP (DENSE_RANK LAST ORDER BY run_at) AS fail_count
         FROM system.monitoring_run_history
        WHERE trigger_type = 'SCHEDULED'
        GROUP BY dbms_id`
    );
    const issues = await rows(
      connection,
      `SELECT dbms_id, clevel, status, COUNT(*) AS n FROM system.monitoring_issues WHERE status <> 'RESOLVED' GROUP BY dbms_id, clevel, status`
    );
    let dataPump: Record<string, any>[] | null = null;
    try {
      // DB마다 진행 중인 작업 전부 + 최근 7일 중 마지막 작업 1건
      dataPump = await rows(
        connection,
        `SELECT dbms_id, job_name, operation, status, TO_CHAR(started_at, 'YYYY-MM-DD HH24:MI:SS') AS started_at,
                TO_CHAR(finished_at, 'YYYY-MM-DD HH24:MI:SS') AS finished_at
           FROM (SELECT d.*, ROW_NUMBER() OVER (PARTITION BY dbms_id ORDER BY started_at DESC) AS rn
                   FROM system.datapump_job_history d
                  WHERE status = 'RUNNING' OR started_at > SYSDATE - 7)
          WHERE status = 'RUNNING' OR rn = 1`
      );
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    let schedule: Record<string, any> | null = null;
    try {
      schedule = (await rows(connection, `SELECT enabled, run_time FROM system.monitoring_schedule_config WHERE ROWNUM = 1`))[0] ?? null;
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    return { dbmses, latestRuns, latestScheduled, issues, dataPump, schedule };
  });
}

export { loadDashboard };
