import oracledb from 'oracledb';
import * as db from '../db';

// 테이블스페이스 / ASM 디스크그룹 사용량 이력 (scripts/add_capacity_history.sql).

export interface CapacitySample {
  kind: 'TABLESPACE' | 'ASM';
  name: string;
  used: number;
  max: number;
}

// ── 대상 DB (예약 점검의 커넥션 재사용, 가벼운 뷰만) ──
// DBA_FREE_SPACE는 익스텐트를 훑어 무겁고, V$ASM_DISKGROUP은 조회 때 디스크를 다시 스캔하므로 쓰지 않는다.
// 권한이 없거나(ORA-00942/01031) ASM이 없는 DB면 그 항목만 비운다.
async function collectFromTarget(connection: oracledb.Connection): Promise<{ samples: CapacitySample[]; skipped: string[] }> {
  const samples: CapacitySample[] = [];
  const skipped: string[] = [];
  const read = async (label: string, sql: string, map: (row: Record<string, any>) => CapacitySample) => {
    try {
      const result = await connection.execute<Record<string, any>>(sql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 2000 });
      samples.push(...(result.rows ?? []).map(map));
    } catch (error) {
      skipped.push(`${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  };
  await read(
    'TABLESPACE',
    `SELECT m.tablespace_name AS name, m.used_space * t.block_size AS used_bytes, m.tablespace_size * t.block_size AS max_bytes
       FROM dba_tablespace_usage_metrics m
       JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name`,
    (row) => ({ kind: 'TABLESPACE', name: row.NAME, used: Number(row.USED_BYTES), max: Number(row.MAX_BYTES) })
  );
  await read(
    'ASM',
    `SELECT name, (total_mb - free_mb) * 1048576 AS used_bytes, total_mb * 1048576 AS max_bytes FROM v$asm_diskgroup_stat`,
    (row) => ({ kind: 'ASM', name: row.NAME, used: Number(row.USED_BYTES), max: Number(row.MAX_BYTES) })
  );
  return { samples, skipped };
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

export interface CapacityConfig {
  retentionDays: number;
  alertDays: number;
  thresholdPct: number;
}

const DEFAULT_CONFIG: CapacityConfig = { retentionDays: 730, alertDays: 30, thresholdPct: 100 };

async function getConfig(): Promise<CapacityConfig> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT retention_days, alert_days, threshold_pct FROM system.capacity_config WHERE id = 1`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    return row ? { retentionDays: Number(row.RETENTION_DAYS), alertDays: Number(row.ALERT_DAYS), thresholdPct: Number(row.THRESHOLD_PCT) } : DEFAULT_CONFIG;
  });
}

async function saveConfig(config: CapacityConfig): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `MERGE INTO system.capacity_config c USING (SELECT 1 AS id FROM dual) s ON (c.id = s.id)
        WHEN MATCHED THEN UPDATE SET retention_days = :retentionDays, alert_days = :alertDays, threshold_pct = :thresholdPct,
                                     updatetime = TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS')
        WHEN NOT MATCHED THEN INSERT (id, retention_days, alert_days, threshold_pct, updatetime)
                              VALUES (1, :retentionDays, :alertDays, :thresholdPct, TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'))`,
      { ...config },
      { autoCommit: true }
    );
  });
}

// 오늘 값으로 덮어쓰기(하루 1행) + 보관 기간 지난 행 정리
async function saveSamples(dbmsId: number | string, samples: CapacitySample[], retentionDays: number): Promise<void> {
  await withPool(async (connection) => {
    if (samples.length > 0) {
      await connection.executeMany(
        `MERGE INTO system.capacity_history h
         USING (SELECT :dbmsId AS dbms_id, TRUNC(SYSDATE) AS collected_on, :kind AS kind, :name AS name FROM dual) s
            ON (h.dbms_id = s.dbms_id AND h.kind = s.kind AND h.name = s.name AND h.collected_on = s.collected_on)
          WHEN MATCHED THEN UPDATE SET used_bytes = :used, max_bytes = :max, collected_at = SYSDATE
          WHEN NOT MATCHED THEN INSERT (dbms_id, collected_on, kind, name, used_bytes, max_bytes, collected_at)
                                VALUES (s.dbms_id, s.collected_on, s.kind, s.name, :used, :max, SYSDATE)`,
        samples.map((sample) => ({ dbmsId: Number(dbmsId), kind: sample.kind, name: sample.name, used: sample.used, max: sample.max })),
        { autoCommit: false }
      );
    }
    await connection.execute(`DELETE FROM system.capacity_history WHERE dbms_id = :dbmsId AND collected_on < TRUNC(SYSDATE) - :days`, {
      dbmsId: Number(dbmsId),
      days: retentionDays,
    });
    await connection.commit();
  });
}

export interface HistoryPoint {
  kind: string;
  name: string;
  day: string;
  used: number;
  max: number;
}

// DB 하나의 이력 (기간: 최근 days일). kind/name을 주면 그 항목만.
async function loadHistory(dbmsId: number | string, days: number, item: { kind: string; name: string } | null = null): Promise<HistoryPoint[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT kind, name, TO_CHAR(collected_on, 'YYYY-MM-DD') AS day, used_bytes, max_bytes
         FROM system.capacity_history
        WHERE dbms_id = :dbmsId AND collected_on >= TRUNC(SYSDATE) - :days
          AND (:kind IS NULL OR (kind = :kind AND name = :name))
        ORDER BY kind, name, collected_on`,
      { dbmsId: Number(dbmsId), days, kind: item?.kind ?? null, name: item?.name ?? null },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map((row) => ({ kind: row.KIND, name: row.NAME, day: row.DAY, used: Number(row.USED_BYTES), max: Number(row.MAX_BYTES) }));
  });
}

export { collectFromTarget, getConfig, saveConfig, saveSamples, loadHistory, DEFAULT_CONFIG };
