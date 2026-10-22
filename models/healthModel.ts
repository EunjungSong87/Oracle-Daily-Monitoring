import oracledb from 'oracledb';
import * as db from '../db';

// /health용 메타 DB 확인. 풀에서 커넥션을 얻는 것부터 쿼리까지 전부 3초 안에 끝나야 성공으로 본다.
// 에러 원문은 밖으로 내보내지 않는다 (ok/실패만).

const TIMEOUT_MS = 3000;

export interface ScheduleSummary {
  enabled: boolean;
  runTime: string | null;
  expected: number; // 예약 점검 대상 DB 수
  lastRunAt: string | null; // 가장 최근 예약 점검 시각 (YYYYMMDDHH24MISS)
  lastRunOk: number; // 그날 예약 점검이 실패 태스크 없이 끝난 DB 수
  lastRunTotal: number; // 그날 예약 점검 기록이 있는 DB 수
}

async function probe(): Promise<ScheduleSummary | null> {
  let connection: oracledb.Connection | undefined;
  let timedOut = false;
  let handle: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) =>
    (handle = setTimeout(() => {
      timedOut = true;
      reject(new Error('timeout'));
    }, TIMEOUT_MS))
  );
  const work = (async () => {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    if (timedOut) return null; // 늦게 얻은 커넥션은 finally에서 돌려준다
    connection.callTimeout = TIMEOUT_MS;
    await connection.execute('SELECT 1 FROM dual');
    return readSchedule(connection);
  })().finally(async () => {
    if (connection) await connection.close().catch(() => undefined);
  });
  work.catch(() => undefined); // 타임아웃 뒤에 실패해도 처리되지 않은 거부로 남지 않게
  try {
    return await Promise.race([work, timer]);
  } finally {
    clearTimeout(handle);
  }
}

// 예약 설정/최근 예약 실행 요약. 테이블이 없는 환경이면 null (메타 DB 자체는 정상)
async function readSchedule(connection: oracledb.Connection): Promise<ScheduleSummary | null> {
  try {
    const result = await connection.execute<Record<string, any>>(
      `SELECT c.enabled, c.run_time,
              (SELECT COUNT(*) FROM system.monitoring_dbms_list WHERE auto_schedule = 'Y') AS expected,
              r.last_run_at,
              (SELECT COUNT(DISTINCT h.dbms_id) FROM system.monitoring_run_history h
                WHERE h.trigger_type = 'SCHEDULED' AND h.run_at >= SUBSTR(r.last_run_at, 1, 8) || '000000') AS last_run_total,
              (SELECT COUNT(DISTINCT h.dbms_id) FROM system.monitoring_run_history h
                WHERE h.trigger_type = 'SCHEDULED' AND h.fail_count = 0
                  AND h.run_at >= SUBSTR(r.last_run_at, 1, 8) || '000000') AS last_run_ok
         FROM (SELECT MAX(run_at) AS last_run_at FROM system.monitoring_run_history WHERE trigger_type = 'SCHEDULED') r
         LEFT JOIN system.monitoring_schedule_config c ON c.id = 1`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      enabled: row.ENABLED === 'Y',
      runTime: row.RUN_TIME ?? null,
      expected: Number(row.EXPECTED ?? 0),
      lastRunAt: row.LAST_RUN_AT ?? null,
      lastRunOk: row.LAST_RUN_AT ? Number(row.LAST_RUN_OK ?? 0) : 0,
      lastRunTotal: row.LAST_RUN_AT ? Number(row.LAST_RUN_TOTAL ?? 0) : 0,
    };
  } catch {
    return null;
  }
}

async function check(): Promise<{ ok: boolean; schedule: ScheduleSummary | null }> {
  try {
    return { ok: true, schedule: await probe() };
  } catch {
    return { ok: false, schedule: null };
  }
}

export { check };
