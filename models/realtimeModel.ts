import oracledb from 'oracledb';
import * as db from '../db';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';

export interface SessionRow {
  sid: number;
  serial: number;
  username: string;
  status: string;
  waitClass: string;
  event: string | null;
  sqlId: string | null;
  program: string | null;
  machine: string | null;
  logonTime: string | null;
  lastCallEt: number | null;
  // 지금 실행 중인 SQL이 시작된 지 몇 초 지났는지 (V$SESSION.SQL_EXEC_START 기준, SQL 실행 중이 아니면 null)
  sqlElapsedSec: number | null;
  sqlExecId: number | null; // 같은 SQL_ID의 실행 하나하나를 구분하는 번호 — 산점도에서 "아직 실행 중"인지 판단할 때 씀
  // 조회 시점의 DB 서버 시각. 화면이 ASH를 시간 범위로 다시 조회할 때 브라우저/앱 서버 시계가 아니라
  // DB 시계를 기준으로 해야 어긋나지 않습니다.
  dbTime: string;
}

// 날짜/시각은 화면과 주고받기 쉽게 전부 이 형식의 문자열로 다룹니다 (DB 서버 시각 기준).
const TS_FORMAT = 'YYYY-MM-DD HH24:MI:SS';

// 대상 DBMS에 접속합니다 (모니터링 대상 접속과 동일한 방식).
async function connectTarget(dbmsid: DbmsIdParam): Promise<oracledb.Connection> {
  const dbconfig = await dbmsModel.getDbmsInfo(dbmsid);
  if (!dbconfig) {
    throw new Error('DBMS 정보를 찾을 수 없습니다.');
  }
  const config = {
    user: dbconfig[0],
    password: dbconfig[1],
    connectString: dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4],
  };
  return db.connectDB(config);
}

async function query(
  connection: oracledb.Connection,
  sql: string,
  binds: oracledb.BindParameters = {},
  options: oracledb.ExecuteOptions = {}
): Promise<Record<string, any>[]> {
  const result = await connection.execute<Record<string, any>>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, ...options });
  return result.rows ?? [];
}

// 현재 사용자 세션 스냅샷 한 장을 가져옵니다.
// v$session.wait_class는 세션이 "지금 대기 중"이 아니어도 마지막으로 겪은 대기의
// 클래스를 그대로 보여주는 특성이 있어서, state != 'WAITING'인 ACTIVE 세션은
// 실제로는 CPU를 쓰고 있는 것으로 보정합니다 (MaxGauge/OEM이 AAS를 집계하는 방식과 동일).
// 비활성 세션은 그래프 집계에서 빼기 쉽도록 별도로 'IDLE'로 표시합니다.
async function loadSessions(connection: oracledb.Connection): Promise<SessionRow[]> {
  const rows = await query(
    connection,
    `SELECT s.sid,
            s.serial# AS serial_num,
            s.username,
            s.status,
            CASE
              WHEN s.status != 'ACTIVE' THEN 'IDLE'
              WHEN s.wait_class IS NULL OR s.wait_class = 'Idle' OR s.state != 'WAITING' THEN 'CPU'
              ELSE s.wait_class
            END AS wait_class,
            s.event,
            s.sql_id,
            s.program,
            s.machine,
            TO_CHAR(s.logon_time, '${TS_FORMAT}') AS logon_time,
            s.last_call_et,
            CASE WHEN s.sql_exec_start IS NOT NULL
                 THEN ROUND((SYSDATE - s.sql_exec_start) * 86400)
            END AS sql_elapsed_sec,
            s.sql_exec_id,
            TO_CHAR(SYSDATE, '${TS_FORMAT}') AS db_time
       FROM v$session s
      WHERE s.type = 'USER'
        AND s.username IS NOT NULL
      ORDER BY s.sid`
  );
  return rows.map((row) => ({
    sid: row.SID,
    serial: row.SERIAL_NUM,
    username: row.USERNAME,
    status: row.STATUS,
    waitClass: row.WAIT_CLASS,
    event: row.EVENT,
    sqlId: row.SQL_ID,
    program: row.PROGRAM,
    machine: row.MACHINE,
    logonTime: row.LOGON_TIME,
    lastCallEt: row.LAST_CALL_ET,
    sqlElapsedSec: row.SQL_ELAPSED_SEC,
    sqlExecId: row.SQL_EXEC_ID,
    dbTime: row.DB_TIME,
  }));
}

// ── ASH / AWR ────────────────────────────────────────────────────────────────
// ASH(V$ACTIVE_SESSION_HISTORY)와 AWR(DBA_HIST_*)은 Oracle Diagnostics Pack 라이선스가 필요한 뷰입니다.
// 권한/라이선스 문제로 못 읽는 DB도 있으므로, 각 부분은 실패해도 나머지 정보는 보여줄 수 있게 따로 조회합니다.

export interface TimeRange {
  from: string; // TS_FORMAT, DB 서버 시각
  to: string;
}

// ASH에서 본 SQL 실행 하나 (한 세션의 한 번의 실행, SQL_EXEC_ID 단위) — 산점도의 점 하나.
export interface AshExecution {
  sid: number;
  serial: number;
  username: string | null;
  sqlId: string | null;
  sqlExecId: number | null;
  sqlExecStart: string | null;
  samples: number; // ASH 샘플 수 ≈ 그 기간 동안 활성 상태였던 초 수
  firstSample: string;
  lastSample: string;
  maxElapsedSec: number | null; // 마지막 샘플 시점까지 SQL이 돈 시간
  topEvent: string; // 가장 많이 샘플된 이벤트 (CPU는 'ON CPU')
  topWaitClass: string; // 그 이벤트의 wait class (CPU는 'CPU') — 산점도 점 색
  program: string | null;
  module: string | null;
  machine: string | null;
}

export interface AshEventCount {
  event: string;
  waitClass: string;
  samples: number;
}

export interface AshSummary {
  range: TimeRange;
  samples: number;
  firstSample: string | null;
  lastSample: string | null;
  username: string | null;
  program: string | null;
  module: string | null;
  machine: string | null;
  events: AshEventCount[];
  blockingSessions: number[];
  sqlIds: string[]; // 그 기간에 이 세션이 실행한 SQL들
  source: 'V$ACTIVE_SESSION_HISTORY' | 'DBA_HIST_ACTIVE_SESS_HISTORY';
}

export interface SessionDetail {
  sid: number;
  serial: number;
  username: string | null;
  status: string;
  osuser: string | null;
  machine: string | null;
  terminal: string | null;
  program: string | null;
  module: string | null;
  action: string | null;
  clientInfo: string | null;
  serviceName: string | null;
  spid: string | null; // 서버 프로세스의 OS PID
  logonTime: string | null;
  lastCallEt: number | null;
  state: string | null;
  event: string | null;
  waitClass: string | null;
  waitSec: number | null; // 지금 대기 중이면 그 대기의 경과(초)
  blockingSession: number | null;
  sqlId: string | null;
  sqlChildNumber: number | null;
  sqlExecStart: string | null;
  sqlElapsedSec: number | null;
  prevSqlId: string | null;
}

export interface SqlDetail {
  sqlId: string;
  source: 'V$SQL' | 'AWR'; // V$SQL(공유 풀)에서 이미 밀려났으면 AWR에서 가져옴
  planHashValue: number | null;
  parsingSchema: string | null;
  module: string | null;
  executions: number | null;
  elapsedSec: number | null; // 누적 (모든 실행 합)
  cpuSec: number | null;
  bufferGets: number | null;
  diskReads: number | null;
  rowsProcessed: number | null;
  firstSeen: string | null; // V$SQL이면 최초 적재 시각, AWR이면 첫 스냅샷 시각
  lastSeen: string | null;
  sqlText: string;
}

export interface Unavailable {
  unavailable: string; // 조회하지 못한 이유 (권한/라이선스/기타 에러 메시지)
}

export interface SessionDetailResult {
  session: SessionDetail | null; // 이미 끝난 세션이면 null
  ash: AshSummary | Unavailable | null;
  sql: SqlDetail | Unavailable | null; // 볼 SQL이 없거나 V$SQL/AWR 어디에도 없으면 null
  sqlSource: 'CURRENT' | 'REQUESTED' | 'PREVIOUS' | null; // 어떤 SQL을 보여주는지
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ASH에서 "since 이후에 샘플이 찍힌" SQL 실행들을 실행(SQL_EXEC_ID) 단위로 가져옵니다.
// 실행 하나의 경과시간 = 마지막 샘플 시각 - SQL_EXEC_START. 샘플 수/주요 이벤트는 since 이전 샘플까지 포함해
// 그 실행 전체로 집계합니다 (since는 "새로 갱신된 실행"을 고르는 데만 씀).
// ASH는 1초마다 활성 세션을 샘플링하므로 1초보다 짧게 끝난 실행은 잡히지 않을 수 있습니다.
const MAX_EXECUTIONS_PER_POLL = 2000;

async function loadAshExecutionsSince(connection: oracledb.Connection, since: string): Promise<AshExecution[]> {
  const rows = await query(
    connection,
    `WITH touched AS (
       SELECT DISTINCT session_id, session_serial#, sql_id, sql_exec_id, sql_exec_start
         FROM v$active_session_history
        WHERE sample_time > TO_TIMESTAMP(:since, '${TS_FORMAT}')
          AND sql_exec_id IS NOT NULL
          AND session_type = 'FOREGROUND'
     )
     SELECT * FROM (
       SELECT h.session_id AS sid, h.session_serial# AS serial_num, MAX(u.username) AS username,
              h.sql_id, h.sql_exec_id,
              TO_CHAR(h.sql_exec_start, '${TS_FORMAT}') AS sql_exec_start,
              COUNT(*) AS samples,
              TO_CHAR(MIN(h.sample_time), '${TS_FORMAT}') AS first_sample,
              TO_CHAR(MAX(h.sample_time), '${TS_FORMAT}') AS last_sample,
              ROUND((CAST(MAX(h.sample_time) AS DATE) - h.sql_exec_start) * 86400) AS max_elapsed_sec,
              STATS_MODE(NVL(h.event, 'ON CPU')) AS top_event,
              STATS_MODE(NVL(h.wait_class, 'CPU')) AS top_wait_class,
              MAX(h.program) AS program, MAX(h.module) AS module, MAX(h.machine) AS machine
         FROM v$active_session_history h
         JOIN touched t
           ON t.session_id = h.session_id AND t.session_serial# = h.session_serial#
          AND t.sql_id = h.sql_id AND t.sql_exec_id = h.sql_exec_id AND t.sql_exec_start = h.sql_exec_start
         LEFT JOIN dba_users u ON u.user_id = h.user_id
        GROUP BY h.session_id, h.session_serial#, h.sql_id, h.sql_exec_id, h.sql_exec_start
        ORDER BY MAX(h.sample_time) DESC
     ) WHERE ROWNUM <= ${MAX_EXECUTIONS_PER_POLL}`,
    { since }
  );
  return rows.map((row) => ({
    sid: row.SID,
    serial: row.SERIAL_NUM,
    username: row.USERNAME,
    sqlId: row.SQL_ID,
    sqlExecId: row.SQL_EXEC_ID,
    sqlExecStart: row.SQL_EXEC_START,
    samples: row.SAMPLES,
    firstSample: row.FIRST_SAMPLE,
    lastSample: row.LAST_SAMPLE,
    maxElapsedSec: row.MAX_ELAPSED_SEC,
    topEvent: row.TOP_EVENT,
    topWaitClass: row.TOP_WAIT_CLASS,
    program: row.PROGRAM,
    module: row.MODULE,
    machine: row.MACHINE,
  }));
}

export interface RealtimeSnapshot {
  dbNow: string; // DB 서버 현재 시각 — 화면은 다음 조회 때 이 값을 since로 넘긴다
  sessions: SessionRow[];
  // ASH 권한/라이선스가 없으면 { unavailable } — 세션 목록과 다른 그래프는 그대로 동작한다.
  executions: AshExecution[] | Unavailable;
}

// 실시간 화면의 2초 폴링 한 번: 세션 목록 + ASH의 최근 SQL 실행 목록을 한 커넥션으로 가져옵니다.
// since를 안 주면(화면을 처음 열었을 때) 최근 10분을 가져와 산점도를 바로 채웁니다.
async function getSnapshot(dbmsid: DbmsIdParam, since: string | null): Promise<RealtimeSnapshot> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const sessions = await loadSessions(connection);
    const dbNow = sessions[0]?.dbTime ?? (await query(connection, `SELECT TO_CHAR(SYSDATE, '${TS_FORMAT}') AS t FROM dual`))[0].T;
    let executions: RealtimeSnapshot['executions'];
    try {
      const effectiveSince =
        since ?? (await query(connection, `SELECT TO_CHAR(SYSDATE - 10/1440, '${TS_FORMAT}') AS t FROM dual`))[0].T;
      executions = await loadAshExecutionsSince(connection, effectiveSince);
    } catch (error) {
      executions = { unavailable: errorText(error) };
    }
    return { dbNow, sessions, executions };
  } finally {
    if (connection) await connection.close();
  }
}

async function loadSession(connection: oracledb.Connection, sid: number, serial: number | null): Promise<SessionDetail | null> {
  const rows = await query(
    connection,
    `SELECT s.sid, s.serial# AS serial_num, s.username, s.status, s.osuser, s.machine, s.terminal, s.program,
            s.module, s.action, s.client_info, s.service_name, p.spid,
            TO_CHAR(s.logon_time, '${TS_FORMAT}') AS logon_time, s.last_call_et,
            s.state, s.event, s.wait_class,
            CASE WHEN s.state = 'WAITING' THEN ROUND(s.wait_time_micro / 1000000, 1) END AS wait_sec,
            s.blocking_session, s.sql_id, s.sql_child_number,
            TO_CHAR(s.sql_exec_start, '${TS_FORMAT}') AS sql_exec_start,
            CASE WHEN s.sql_exec_start IS NOT NULL THEN ROUND((SYSDATE - s.sql_exec_start) * 86400) END AS sql_elapsed_sec,
            s.prev_sql_id
       FROM v$session s
       LEFT JOIN v$process p ON p.addr = s.paddr
      WHERE s.sid = :sid
        AND (:serial IS NULL OR s.serial# = :serial)`,
    { sid, serial }
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sid: row.SID,
    serial: row.SERIAL_NUM,
    username: row.USERNAME,
    status: row.STATUS,
    osuser: row.OSUSER,
    machine: row.MACHINE,
    terminal: row.TERMINAL,
    program: row.PROGRAM,
    module: row.MODULE,
    action: row.ACTION,
    clientInfo: row.CLIENT_INFO,
    serviceName: row.SERVICE_NAME,
    spid: row.SPID,
    logonTime: row.LOGON_TIME,
    lastCallEt: row.LAST_CALL_ET,
    state: row.STATE,
    event: row.EVENT,
    waitClass: row.WAIT_CLASS,
    waitSec: row.WAIT_SEC,
    blockingSession: row.BLOCKING_SESSION,
    sqlId: row.SQL_ID,
    sqlChildNumber: row.SQL_CHILD_NUMBER,
    sqlExecStart: row.SQL_EXEC_START,
    sqlElapsedSec: row.SQL_ELAPSED_SEC,
    prevSqlId: row.PREV_SQL_ID,
  };
}

async function loadAshSummary(
  connection: oracledb.Connection,
  sid: number,
  serial: number | null,
  range: TimeRange,
  sqlId: string | null
): Promise<AshSummary | null> {
  const binds = { sid, serial, sqlId, fromTs: range.from, toTs: range.to };
  const where = `h.session_id = :sid
         AND (:serial IS NULL OR h.session_serial# = :serial)
         AND (:sqlId IS NULL OR h.sql_id = :sqlId)
         AND h.sample_time BETWEEN TO_TIMESTAMP(:fromTs, '${TS_FORMAT}') AND TO_TIMESTAMP(:toTs, '${TS_FORMAT}')`;

  for (const view of ['v$active_session_history', 'dba_hist_active_sess_history'] as const) {
    const header = (
      await query(
        connection,
        `SELECT COUNT(*) AS samples,
                TO_CHAR(MIN(h.sample_time), '${TS_FORMAT}') AS first_sample,
                TO_CHAR(MAX(h.sample_time), '${TS_FORMAT}') AS last_sample,
                MAX(u.username) AS username, MAX(h.program) AS program, MAX(h.module) AS module, MAX(h.machine) AS machine
           FROM ${view} h
           LEFT JOIN dba_users u ON u.user_id = h.user_id
          WHERE ${where}`,
        binds
      )
    )[0];
    if (!header || header.SAMPLES === 0) continue;

    const events = await query(
      connection,
      `SELECT NVL(h.event, 'ON CPU') AS event, NVL(h.wait_class, 'CPU') AS wait_class, COUNT(*) AS samples
         FROM ${view} h
        WHERE ${where}
        GROUP BY NVL(h.event, 'ON CPU'), NVL(h.wait_class, 'CPU')
        ORDER BY samples DESC`,
      binds
    );
    const blockers = await query(
      connection,
      `SELECT DISTINCT h.blocking_session FROM ${view} h WHERE ${where} AND h.blocking_session IS NOT NULL`,
      binds
    );
    const sqlIds = await query(
      connection,
      `SELECT h.sql_id, COUNT(*) AS samples FROM ${view} h WHERE ${where} AND h.sql_id IS NOT NULL
        GROUP BY h.sql_id ORDER BY samples DESC`,
      binds
    );
    return {
      range,
      samples: header.SAMPLES,
      firstSample: header.FIRST_SAMPLE,
      lastSample: header.LAST_SAMPLE,
      username: header.USERNAME,
      program: header.PROGRAM,
      module: header.MODULE,
      machine: header.MACHINE,
      events: events.map((row) => ({ event: row.EVENT, waitClass: row.WAIT_CLASS, samples: row.SAMPLES })),
      blockingSessions: blockers.map((row) => row.BLOCKING_SESSION),
      sqlIds: sqlIds.map((row) => row.SQL_ID),
      source: view === 'v$active_session_history' ? 'V$ACTIVE_SESSION_HISTORY' : 'DBA_HIST_ACTIVE_SESS_HISTORY',
    };
  }
  return null;
}

// V$SQL에 있으면 거기서(현재 child 우선), 공유 풀에서 밀려났으면 AWR(DBA_HIST_SQLTEXT/SQLSTAT)에서 가져옵니다.
async function loadSql(connection: oracledb.Connection, sqlId: string, childNumber: number | null): Promise<SqlDetail | null> {
  // FETCH FIRST는 12c부터라 11g 대상도 고려해 ROWNUM으로 자릅니다.
  const live = (
    await query(
      connection,
      `SELECT * FROM (
         SELECT sql_id, plan_hash_value, parsing_schema_name, module, executions,
                ROUND(elapsed_time / 1000000, 3) AS elapsed_sec, ROUND(cpu_time / 1000000, 3) AS cpu_sec,
                buffer_gets, disk_reads, rows_processed,
                REPLACE(first_load_time, '/', ' ') AS first_seen,
                TO_CHAR(last_active_time, '${TS_FORMAT}') AS last_seen, sql_fulltext
           FROM v$sql
          WHERE sql_id = :sqlId
          ORDER BY CASE WHEN child_number = :childNumber THEN 0 ELSE 1 END, last_active_time DESC
       ) WHERE ROWNUM = 1`,
      { sqlId, childNumber },
      { fetchInfo: { SQL_FULLTEXT: { type: oracledb.STRING } } }
    )
  )[0];
  if (live) {
    return {
      sqlId,
      source: 'V$SQL',
      planHashValue: live.PLAN_HASH_VALUE,
      parsingSchema: live.PARSING_SCHEMA_NAME,
      module: live.MODULE,
      executions: live.EXECUTIONS,
      elapsedSec: live.ELAPSED_SEC,
      cpuSec: live.CPU_SEC,
      bufferGets: live.BUFFER_GETS,
      diskReads: live.DISK_READS,
      rowsProcessed: live.ROWS_PROCESSED,
      firstSeen: live.FIRST_SEEN,
      lastSeen: live.LAST_SEEN,
      sqlText: live.SQL_FULLTEXT ?? '',
    };
  }

  const text = (
    await query(
      connection,
      `SELECT sql_text FROM dba_hist_sqltext WHERE sql_id = :sqlId AND dbid = (SELECT dbid FROM v$database) AND ROWNUM = 1`,
      { sqlId },
      { fetchInfo: { SQL_TEXT: { type: oracledb.STRING } } }
    )
  )[0];
  if (!text) return null;
  const stats = (
    await query(
      connection,
      `SELECT SUM(st.executions_delta) AS executions,
              ROUND(SUM(st.elapsed_time_delta) / 1000000, 3) AS elapsed_sec,
              ROUND(SUM(st.cpu_time_delta) / 1000000, 3) AS cpu_sec,
              SUM(st.buffer_gets_delta) AS buffer_gets, SUM(st.disk_reads_delta) AS disk_reads,
              SUM(st.rows_processed_delta) AS rows_processed,
              MAX(st.plan_hash_value) AS plan_hash_value, MAX(st.parsing_schema_name) AS parsing_schema_name,
              MAX(st.module) AS module,
              TO_CHAR(MIN(sn.begin_interval_time), '${TS_FORMAT}') AS first_seen,
              TO_CHAR(MAX(sn.end_interval_time), '${TS_FORMAT}') AS last_seen
         FROM dba_hist_sqlstat st
         JOIN dba_hist_snapshot sn
           ON sn.snap_id = st.snap_id AND sn.dbid = st.dbid AND sn.instance_number = st.instance_number
        WHERE st.sql_id = :sqlId
          AND st.dbid = (SELECT dbid FROM v$database)`,
      { sqlId }
    )
  )[0];
  return {
    sqlId,
    source: 'AWR',
    planHashValue: stats?.PLAN_HASH_VALUE ?? null,
    parsingSchema: stats?.PARSING_SCHEMA_NAME ?? null,
    module: stats?.MODULE ?? null,
    executions: stats?.EXECUTIONS ?? null,
    elapsedSec: stats?.ELAPSED_SEC ?? null,
    cpuSec: stats?.CPU_SEC ?? null,
    bufferGets: stats?.BUFFER_GETS ?? null,
    diskReads: stats?.DISK_READS ?? null,
    rowsProcessed: stats?.ROWS_PROCESSED ?? null,
    firstSeen: stats?.FIRST_SEEN ?? null,
    lastSeen: stats?.LAST_SEEN ?? null,
    sqlText: text.SQL_TEXT ?? '',
  };
}

// 세션 하나의 상세: 현재 상태(V$SESSION) + 그 기간의 ASH 요약 + SQL 전문/통계(V$SQL → AWR).
// SID는 재사용되므로 SERIAL#까지 맞아야 같은 세션입니다. 세션이 이미 끝났으면 ASH와, 화면이 넘겨준
// SQL_ID로 찾은 SQL 정보만 보여줍니다.
async function getSessionDetail(
  dbmsid: DbmsIdParam,
  sid: number,
  serial: number | null,
  requestedSqlId: string | null,
  range: TimeRange | null
): Promise<SessionDetailResult> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const session = await loadSession(connection, sid, serial);

    // 기간을 안 넘기면(세션 목록 더블클릭) 최근 10분을 봅니다.
    let ashRange = range;
    if (!ashRange) {
      const now = (await query(connection, `SELECT TO_CHAR(SYSDATE - 10/1440, '${TS_FORMAT}') AS f, TO_CHAR(SYSDATE, '${TS_FORMAT}') AS t FROM dual`))[0];
      ashRange = { from: now.F, to: now.T };
    }
    let ash: SessionDetailResult['ash'];
    try {
      ash = await loadAshSummary(connection, sid, serial ?? session?.serial ?? null, ashRange, range ? requestedSqlId : null);
    } catch (error) {
      ash = { unavailable: errorText(error) };
    }

    let sqlId: string | null = null;
    let sqlSource: SessionDetailResult['sqlSource'] = null;
    if (requestedSqlId) {
      sqlId = requestedSqlId;
      sqlSource = requestedSqlId === session?.sqlId ? 'CURRENT' : 'REQUESTED';
    } else if (session?.sqlId) {
      sqlId = session.sqlId;
      sqlSource = 'CURRENT';
    } else if (session?.prevSqlId) {
      sqlId = session.prevSqlId;
      sqlSource = 'PREVIOUS';
    }

    let sql: SessionDetailResult['sql'] = null;
    if (sqlId) {
      try {
        sql = await loadSql(connection, sqlId, sqlSource === 'CURRENT' ? (session?.sqlChildNumber ?? null) : null);
      } catch (error) {
        sql = { unavailable: errorText(error) };
      }
    }
    return { session, ash, sql, sqlSource };
  } finally {
    if (connection) await connection.close();
  }
}

export { getSnapshot, getSessionDetail };
