import oracledb from 'oracledb';
import * as db from '../db';
import type { AlertLogSearchParams } from '../services/alertLogRules';
import { escapeLike } from '../services/alertLogRules';

// Alert Log(ORA-/FAIL) 수집 이력 (scripts/add_alert_log_history.sql).

export interface AlertLogEntry {
  logTime: string; // YYYY-MM-DD HH24:MI:SS (+9시간 보정)
  oraCode: string | null;
  messageType: string | null;
  messageLevel: number | null;
  messageText: string;
  filename: string | null;
}

// 저장 단위: 중복 방지 해시 포함 (서비스가 계산)
export interface AlertLogSample extends AlertLogEntry {
  msgHash: string;
}

export interface AlertLogConfig {
  retentionDays: number;
}

export const DEFAULT_CONFIG: AlertLogConfig = { retentionDays: 365 };

// ── 대상 DB (예약 점검의 커넥션 재사용) ──
// 기존 'alertLog' 모니터링 태스크(queries/dailyChecks.ts)와 같은 조건: 최근 2일, ORA- 또는 FAIL 포함.
// 파일을 읽지 않고 V$DIAG_ALERT_EXT 딕셔너리 뷰만 조회한다.
const COLLECT_MAX_ROWS = 10000;

async function collectFromTarget(connection: oracledb.Connection): Promise<AlertLogEntry[]> {
  const result = await connection.execute<Record<string, any>>(
    `SELECT TO_CHAR(CAST(originating_timestamp + INTERVAL '9' HOUR AS DATE), 'YYYY-MM-DD HH24:MI:SS') AS log_time,
            REGEXP_SUBSTR(message_text, 'ORA-[0-9]+') AS ora_code,
            DECODE(message_type, 1, 'UNKNOWN', 2, 'INCIDENT_ERROR', 3, 'ERROR', 4, 'WARNING', 5, 'NOTIFICATION', 6, 'TRACE',
                   TO_CHAR(message_type)) AS message_type,
            message_level, message_text, filename
       FROM v$diag_alert_ext
      WHERE originating_timestamp > SYSDATE - 2
        AND (message_text LIKE '%ORA-%' OR message_text LIKE '%FAIL%')`,
    {},
    { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: COLLECT_MAX_ROWS }
  );
  return (result.rows ?? []).map((row) => ({
    logTime: row.LOG_TIME,
    oraCode: row.ORA_CODE ?? null,
    messageType: row.MESSAGE_TYPE ?? null,
    messageLevel: row.MESSAGE_LEVEL === null || row.MESSAGE_LEVEL === undefined ? null : Number(row.MESSAGE_LEVEL),
    messageText: String(row.MESSAGE_TEXT ?? ''),
    filename: row.FILENAME ?? null,
  }));
}

// ── 메타데이터 DB ──

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

function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && /ORA-00942/.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function getConfig(): Promise<AlertLogConfig> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(`SELECT retention_days FROM system.alert_log_config WHERE id = 1`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const row = result.rows?.[0];
    return row ? { retentionDays: Number(row.RETENTION_DAYS) } : DEFAULT_CONFIG;
  });
}

async function saveConfig(config: AlertLogConfig): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `MERGE INTO system.alert_log_config c USING (SELECT 1 AS id FROM dual) s ON (c.id = s.id)
        WHEN MATCHED THEN UPDATE SET retention_days = :retentionDays, updatetime = TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS')
        WHEN NOT MATCHED THEN INSERT (id, retention_days, updatetime) VALUES (1, :retentionDays, TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'))`,
      { retentionDays: config.retentionDays },
      { autoCommit: true }
    );
  });
}

// 이미 있는 (DB, 시각, 메시지 해시)는 collected_at만 갱신 + 보관 기간 지난 행 정리
async function saveSamples(dbmsId: number | string, samples: AlertLogSample[], retentionDays: number): Promise<void> {
  await withPool(async (connection) => {
    if (samples.length > 0) {
      await connection.executeMany(
        `MERGE INTO system.alert_log_history h
         USING (SELECT :dbmsId AS dbms_id, TO_DATE(:logTime, 'YYYY-MM-DD HH24:MI:SS') AS log_time, :msgHash AS msg_hash FROM dual) s
            ON (h.dbms_id = s.dbms_id AND h.log_time = s.log_time AND h.msg_hash = s.msg_hash)
          WHEN MATCHED THEN UPDATE SET collected_at = SYSDATE
          WHEN NOT MATCHED THEN INSERT (id, dbms_id, log_time, ora_code, message_type, message_level, message_text, filename, msg_hash, collected_at)
                                VALUES (system.alert_log_history_seq.NEXTVAL, s.dbms_id, s.log_time, :oraCode, :messageType, :messageLevel,
                                        :messageText, :filename, s.msg_hash, SYSDATE)`,
        samples.map((sample) => ({
          dbmsId: Number(dbmsId),
          logTime: sample.logTime,
          msgHash: sample.msgHash,
          oraCode: sample.oraCode,
          messageType: sample.messageType,
          messageLevel: sample.messageLevel,
          messageText: sample.messageText,
          filename: sample.filename,
        })),
        {
          autoCommit: false,
          bindDefs: {
            dbmsId: { type: oracledb.NUMBER },
            logTime: { type: oracledb.STRING, maxSize: 19 },
            msgHash: { type: oracledb.STRING, maxSize: 40 },
            oraCode: { type: oracledb.STRING, maxSize: 12 },
            messageType: { type: oracledb.STRING, maxSize: 30 },
            messageLevel: { type: oracledb.NUMBER },
            messageText: { type: oracledb.STRING, maxSize: 4000 },
            filename: { type: oracledb.STRING, maxSize: 512 },
          },
        }
      );
    }
    await connection.execute(`DELETE FROM system.alert_log_history WHERE dbms_id = :dbmsId AND log_time < SYSDATE - :days`, {
      dbmsId: Number(dbmsId),
      days: retentionDays,
    });
    await connection.commit();
  });
}

// 검색/추이 공통 조건 — ix_alert_log_history_search(dbms_id, ora_code, log_time) 순서대로 붙인다.
function whereClause(params: AlertLogSearchParams): { sql: string; binds: Record<string, string | number> } {
  const conditions: string[] = [];
  const binds: Record<string, string | number> = {};
  if (params.dbmsId !== null) {
    conditions.push('h.dbms_id = :dbmsId');
    binds.dbmsId = params.dbmsId;
  }
  if (params.oraCode) {
    conditions.push(`h.ora_code LIKE :oraCode ESCAPE '\\'`);
    binds.oraCode = `${escapeLike(params.oraCode)}%`;
  }
  conditions.push(`h.log_time >= TO_DATE(:fromDate, 'YYYY-MM-DD')`, `h.log_time < TO_DATE(:toDate, 'YYYY-MM-DD') + 1`);
  binds.fromDate = params.fromDate;
  binds.toDate = params.toDate;
  if (params.keyword) {
    conditions.push(`UPPER(h.message_text) LIKE :keyword ESCAPE '\\'`);
    binds.keyword = `%${escapeLike(params.keyword.toUpperCase())}%`;
  }
  return { sql: conditions.join(' AND '), binds };
}

export interface AlertLogRow {
  id: number;
  dbmsId: number;
  dbname: string | null;
  logTime: string;
  oraCode: string | null;
  messageType: string | null;
  messageLevel: number | null;
  messageText: string;
  filename: string | null;
}

// 최신순 페이지 + 전체 건수. 메타데이터 DB 버전과 무관하게 ROWNUM으로 자른다.
async function search(params: AlertLogSearchParams): Promise<{ rows: AlertLogRow[]; total: number }> {
  const { sql, binds } = whereClause(params);
  return withPool(async (connection) => {
    const count = await connection.execute<Record<string, any>>(`SELECT COUNT(*) AS cnt FROM system.alert_log_history h WHERE ${sql}`, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const total = Number(count.rows?.[0]?.CNT ?? 0);
    if (total === 0 || params.offset >= total) return { rows: [], total };
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT p.*, ROWNUM AS rn FROM (
           SELECT h.id, h.dbms_id, d.dbname, TO_CHAR(h.log_time, 'YYYY-MM-DD HH24:MI:SS') AS log_time, h.ora_code,
                  h.message_type, h.message_level, h.message_text, h.filename
             FROM system.alert_log_history h
             LEFT JOIN system.monitoring_dbms_list d ON d.id = h.dbms_id
            WHERE ${sql}
            ORDER BY h.log_time DESC, h.id DESC
         ) p WHERE ROWNUM <= :maxRow
       ) WHERE rn > :minRow`,
      { ...binds, maxRow: params.offset + params.limit, minRow: params.offset },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return {
      total,
      rows: (result.rows ?? []).map((row) => ({
        id: Number(row.ID),
        dbmsId: Number(row.DBMS_ID),
        dbname: row.DBNAME ?? null,
        logTime: row.LOG_TIME,
        oraCode: row.ORA_CODE ?? null,
        messageType: row.MESSAGE_TYPE ?? null,
        messageLevel: row.MESSAGE_LEVEL === null || row.MESSAGE_LEVEL === undefined ? null : Number(row.MESSAGE_LEVEL),
        messageText: row.MESSAGE_TEXT ?? '',
        filename: row.FILENAME ?? null,
      })),
    };
  });
}

export interface AlertLogTrendPoint {
  day: string;
  oraCode: string | null; // NULL = ORA 코드 없는 메시지 (FAIL 등)
  count: number;
}

// 일자별 + ORA 코드별 건수 (limit/offset 무시)
async function trend(params: AlertLogSearchParams): Promise<AlertLogTrendPoint[]> {
  const { sql, binds } = whereClause(params);
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT TO_CHAR(TRUNC(h.log_time), 'YYYY-MM-DD') AS day, h.ora_code, COUNT(*) AS cnt
         FROM system.alert_log_history h
        WHERE ${sql}
        GROUP BY TRUNC(h.log_time), h.ora_code
        ORDER BY 1, 2`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 50000 }
    );
    return (result.rows ?? []).map((row) => ({ day: row.DAY, oraCode: row.ORA_CODE ?? null, count: Number(row.CNT) }));
  });
}

export { collectFromTarget, getConfig, saveConfig, saveSamples, search, trend, isMissingTable };
