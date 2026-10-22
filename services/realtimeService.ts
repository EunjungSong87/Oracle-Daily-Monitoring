import * as realtimeModel from '../models/realtimeModel';
import { SessionKillFailed, SessionKillRefused, type RealtimeSnapshot, type SessionDetailResult, type TimeRange } from '../models/realtimeModel';
import * as dbmsModel from '../models/dbmsModel';
import type { DbmsIdParam } from '../models/dbmsModel';
import * as sessionKillLogModel from '../models/sessionKillLogModel';
import { logger } from '../utils/logger';

async function getSnapshot(dbmsid: DbmsIdParam, since: string | null): Promise<RealtimeSnapshot> {
  try {
    return await realtimeModel.getSnapshot(dbmsid, since);
  } catch (error) {
    throw new Error('실시간 세션 조회 실패', { cause: error });
  }
}

async function getSessionDetail(
  dbmsid: DbmsIdParam,
  sid: number,
  serial: number | null,
  sqlId: string | null,
  range: TimeRange | null
): Promise<SessionDetailResult> {
  try {
    return await realtimeModel.getSessionDetail(dbmsid, sid, serial, sqlId, range);
  } catch (error) {
    throw new Error('세션 상세 조회 실패', { cause: error });
  }
}


// Blocking 체인의 세션 Kill. 대상 DB명 확인 → 기록 테이블 확인 → Kill(모델이 세션을 다시 확인) → 성공/실패 모두 기록.
// 기록 테이블이 없으면 Kill하지 않는다. 기록 자체가 실패하면(Kill은 이미 됨) 서버 로그에 남긴다.
async function killSession(
  dbmsid: DbmsIdParam,
  target: { instId: number; sid: number; serial: number },
  confirmDbname: unknown,
  killedBy: string
): Promise<realtimeModel.KilledSession> {
  const dbconfig = await dbmsModel.getDbmsInfo(dbmsid);
  if (!dbconfig) throw new SessionKillRefused('DBMS 정보를 찾을 수 없습니다.');
  const dbname = String(dbconfig[6] ?? '');
  const typed = typeof confirmDbname === 'string' ? confirmDbname.trim().toUpperCase() : '';
  if (!dbname || typed !== dbname.trim().toUpperCase()) throw new SessionKillRefused(`확인을 위해 대상 DB명(${dbname})을 정확히 입력해주세요.`);
  if (!(await sessionKillLogModel.isAvailable())) {
    throw new SessionKillRefused('Kill 기록 테이블이 없습니다. 메타데이터 DB에 scripts/add_session_kill_log.sql을 실행하세요.');
  }
  const base = { dbmsId: Number(dbmsid.dbmsid), dbname, killedBy, ...target };
  const record = async (log: sessionKillLogModel.SessionKillLog) => {
    try {
      await sessionKillLogModel.insertLog(log);
    } catch (error) {
      logger.error('Realtime', `세션 Kill 기록 실패 (${killedBy}, dbms=${dbname}, ${target.sid},${target.serial},@${target.instId}, ${log.result})`, error);
    }
  };
  try {
    const killed = await realtimeModel.killSession(dbmsid, target.instId, target.sid, target.serial);
    await record({ ...base, ...killed, result: 'OK', message: null });
    return killed;
  } catch (error) {
    if (error instanceof SessionKillRefused) throw error;
    const session = error instanceof SessionKillFailed ? error.session : null;
    await record({
      ...base,
      username: session?.username ?? null,
      machine: session?.machine ?? null,
      program: session?.program ?? null,
      sqlId: session?.sqlId ?? null,
      result: 'FAILED',
      message: error instanceof Error ? error.message : String(error),
    });
    throw new Error('세션 Kill 실패', { cause: error });
  }
}

export { getSnapshot, getSessionDetail, killSession };
