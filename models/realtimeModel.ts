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
}

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

// 현재 사용자 세션 스냅샷 한 장을 가져옵니다.
// v$session.wait_class는 세션이 "지금 대기 중"이 아니어도 마지막으로 겪은 대기의
// 클래스를 그대로 보여주는 특성이 있어서, state != 'WAITING'인 ACTIVE 세션은
// 실제로는 CPU를 쓰고 있는 것으로 보정합니다 (MaxGauge/OEM이 AAS를 집계하는 방식과 동일).
// 비활성 세션은 그래프 집계에서 빼기 쉽도록 별도로 'IDLE'로 표시합니다.
async function getSessions(dbmsid: DbmsIdParam): Promise<SessionRow[]> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const query = `
      SELECT s.sid,
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
             TO_CHAR(s.logon_time, 'YYYY-MM-DD HH24:MI:SS') AS logon_time,
             s.last_call_et
        FROM v$session s
       WHERE s.type = 'USER'
         AND s.username IS NOT NULL
       ORDER BY s.sid
    `;
    const result = await connection.execute<Record<string, any>>(query, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (result.rows ?? []).map((row) => ({
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
    }));
  } catch (err) {
    console.error('실시간 세션 조회 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

export { getSessions };
