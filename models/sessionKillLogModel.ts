import oracledb from 'oracledb';
import * as db from '../db';

// Real-Time Blocking 체인의 세션 Kill 기록 (scripts/add_session_kill_log.sql).

export interface SessionKillLog {
  dbmsId: number;
  dbname: string | null;
  instId: number;
  sid: number;
  serial: number;
  username: string | null;
  machine: string | null;
  program: string | null;
  sqlId: string | null;
  killedBy: string;
  result: 'OK' | 'FAILED';
  message: string | null;
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

// 테이블이 있는지 (없으면 Kill을 거절한다 — 기록 없이 세션을 죽이지 않기 위해)
async function isAvailable(): Promise<boolean> {
  try {
    await withPool((connection) => connection.execute('SELECT 1 FROM system.monitoring_session_kill_log WHERE 1 = 0'));
    return true;
  } catch (error) {
    if (error instanceof Error && /ORA-00942/.test(error.message)) return false;
    throw error;
  }
}

async function insertLog(log: SessionKillLog): Promise<void> {
  await withPool((connection) =>
    connection.execute(
      `INSERT INTO system.monitoring_session_kill_log
         (dbms_id, dbname, inst_id, sid, serial_num, username, machine, program, sql_id, killed_by, killed_at, result, message)
       VALUES (:dbmsId, :dbname, :instId, :sid, :serial, :username, :machine, :program, :sqlId, :killedBy, SYSDATE, :result, :message)`,
      {
        ...log,
        machine: log.machine?.slice(0, 256) ?? null,
        program: log.program?.slice(0, 256) ?? null,
        message: log.message?.slice(0, 1000) ?? null,
      } as unknown as oracledb.BindParameters,
      { autoCommit: true }
    )
  );
}

export { isAvailable, insertLog };
