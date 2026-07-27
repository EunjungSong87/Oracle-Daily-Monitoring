import oracledb from 'oracledb';
import * as db from '../db';

export interface RunHistorySummary {
  id: number;
  dbmsId: number;
  dbname: string;
  runAt: string;
  triggerType: string;
  successCount: number;
  failCount: number;
}

export interface RunHistoryDetail extends RunHistorySummary {
  results: Record<string, any>[];
}

export interface Issue {
  dbmsId: number;
  dbname: string;
  runAt: string;
  taskName: string;
  column: string;
  value: unknown;
  level: string;
  message: string;
}

// 모니터링 실행 결과 한 건을 이력으로 저장합니다. 저장 실패가 실제 점검 응답을
// 막으면 안 되므로, 호출하는 쪽(dbmsService)에서 실패를 흡수합니다.
async function saveRunHistory(
  dbmsId: number | string,
  dbname: string,
  triggerType: 'MANUAL' | 'SCHEDULED',
  results: Record<string, any>[]
): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    const maxRes = await connection.execute<any[]>('select nvl(max(id),0)+1 as nextid from system.monitoring_run_history');
    const nextId = maxRes.rows?.[0][0];

    const sql = `insert into system.monitoring_run_history
                    (id, dbms_id, dbname, run_at, trigger_type, success_count, fail_count, results)
                 values
                    (:id, :dbmsId, :dbname, TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'), :triggerType, :successCount, :failCount, :results)`;

    await connection.execute(
      sql,
      {
        id: nextId,
        dbmsId,
        dbname,
        triggerType,
        successCount,
        failCount,
        results: JSON.stringify(results),
      },
      { autoCommit: true }
    );
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

// fromDate/toDate는 'YYYYMMDD' 형식(8자리)이며, 하루 전체 범위를 포함하도록
// 시분초를 각각 000000/235959로 채워서 run_at('YYYYMMDDHH24MISS')과 비교합니다.
async function listRunHistory(
  dbmsId: number | string,
  fromDate?: string,
  toDate?: string
): Promise<RunHistorySummary[]> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const conditions = ['dbms_id = :dbmsId'];
    const binds: Record<string, any> = { dbmsId };
    if (fromDate) {
      conditions.push('run_at >= :fromAt');
      binds.fromAt = `${fromDate}000000`;
    }
    if (toDate) {
      conditions.push('run_at <= :toAt');
      binds.toAt = `${toDate}235959`;
    }

    const query = `select id, dbms_id, dbname, run_at, trigger_type, success_count, fail_count
                     from system.monitoring_run_history
                    where ${conditions.join(' and ')}
                    order by run_at desc`;
    const result = await connection.execute<Record<string, any>>(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (result.rows ?? []).map((row) => ({
      id: row.ID,
      dbmsId: row.DBMS_ID,
      dbname: row.DBNAME,
      runAt: row.RUN_AT,
      triggerType: row.TRIGGER_TYPE,
      successCount: row.SUCCESS_COUNT,
      failCount: row.FAIL_COUNT,
    }));
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function getRunHistoryDetail(id: number | string): Promise<RunHistoryDetail | null> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const query = `select id, dbms_id, dbname, run_at, trigger_type, success_count, fail_count, results
                     from system.monitoring_run_history
                    where id = :id`;
    const result = await connection.execute<Record<string, any>>(
      query,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { RESULTS: { type: oracledb.STRING } } }
    );
    const row = result.rows?.[0];
    if (!row) return null;

    return {
      id: row.ID,
      dbmsId: row.DBMS_ID,
      dbname: row.DBNAME,
      runAt: row.RUN_AT,
      triggerType: row.TRIGGER_TYPE,
      successCount: row.SUCCESS_COUNT,
      failCount: row.FAIL_COUNT,
      results: JSON.parse(row.RESULTS),
    };
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

// DB별 가장 최근 실행 결과에서, 임계치를 위반한(=_alerts가 붙은) 항목만 뽑아 카드용으로 펼칩니다.
async function getLatestIssues(): Promise<Issue[]> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const query = `select dbms_id, dbname, run_at, results
                      from (
                        select dbms_id, dbname, run_at, results,
                               row_number() over (partition by dbms_id order by run_at desc) rn
                          from system.monitoring_run_history
                      )
                     where rn = 1
                     order by dbname`;
    const result = await connection.execute<Record<string, any>>(
      query,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { RESULTS: { type: oracledb.STRING } } }
    );

    const issues: Issue[] = [];
    for (const row of result.rows ?? []) {
      let tasks: Record<string, any>[];
      try {
        tasks = JSON.parse(row.RESULTS);
      } catch {
        continue;
      }
      for (const task of tasks) {
        for (const dataRow of task.rows ?? []) {
          const alerts = dataRow._alerts;
          if (!alerts) continue;
          for (const column of Object.keys(alerts)) {
            if (alerts[column].level === 'INFO') continue;
            issues.push({
              dbmsId: row.DBMS_ID,
              dbname: row.DBNAME,
              runAt: row.RUN_AT,
              taskName: task.task_name,
              column,
              value: dataRow[column],
              level: alerts[column].level,
              message: alerts[column].message,
            });
          }
        }
      }
    }

    // ERROR가 위, 그 안에서는 최신순.
    issues.sort((a, b) => {
      if (a.level !== b.level) return a.level === 'ERROR' ? -1 : 1;
      return b.runAt.localeCompare(a.runAt);
    });
    return issues;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

export { saveRunHistory, listRunHistory, getRunHistoryDetail, getLatestIssues };
