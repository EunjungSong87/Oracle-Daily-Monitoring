import type { Request, Response } from 'express';
import * as realtimeService from '../services/realtimeService';
import { SessionKillRefused } from '../models/realtimeModel';
import type { TimeRange } from '../models/realtimeModel';
import { logger } from '../utils/logger';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TS_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const SQL_ID_PATTERN = /^[0-9a-z]{13}$/;

function parseRange(from: unknown, to: unknown): TimeRange | null {
  if (typeof from !== 'string' || typeof to !== 'string' || !TS_PATTERN.test(from) || !TS_PATTERN.test(to)) return null;
  return { from, to };
}

// 2초 폴링: 세션 목록 + ASH의 SQL 실행 목록(산점도용). since(DB 시각)를 주면 그 이후에 갱신된 실행만,
// 안 주면(화면을 처음 열었을 때) 최근 10분을 돌려줍니다.
async function getSessions(req: Request, res: Response): Promise<Response | void> {
  const { dbmsid, since } = req.body ?? {};
  if (!dbmsid) {
    return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
  }
  if (since !== undefined && since !== null && (typeof since !== 'string' || !TS_PATTERN.test(since))) {
    return res.status(400).json({ message: 'since 형식이 올바르지 않습니다 (YYYY-MM-DD HH24:MI:SS).' });
  }
  try {
    const snapshot = await realtimeService.getSnapshot({ dbmsid }, since ?? null);
    res.json({ timestamp: new Date().toISOString(), ...snapshot });
  } catch (error) {
    logger.error('Realtime', `실시간 세션 조회 오류 (dbmsid=${dbmsid})`, error);
    res.status(500).json({ message: '서버 오류 발생', error: errMsg(error) });
  }
}

// 세션 상세: 현재 상태 + ASH 요약 + SQL 전문/통계. SID/SERIAL#은 숫자로, SQL_ID는 형식을 확인한 뒤에만 바인드합니다.
async function getSessionDetail(req: Request, res: Response): Promise<Response | void> {
  const { dbmsid, sid, serial, sqlId, from, to } = req.body ?? {};
  const sidNumber = Number(sid);
  const serialNumber = serial === undefined || serial === null || serial === '' ? null : Number(serial);
  if (!dbmsid || !Number.isInteger(sidNumber) || (serialNumber !== null && !Number.isInteger(serialNumber))) {
    return res.status(400).json({ message: 'dbmsid, sid 정보가 필요합니다.' });
  }
  if (sqlId !== undefined && sqlId !== null && (typeof sqlId !== 'string' || !SQL_ID_PATTERN.test(sqlId))) {
    return res.status(400).json({ message: 'sqlId 형식이 올바르지 않습니다.' });
  }
  const range = from || to ? parseRange(from, to) : null;
  if ((from || to) && !range) {
    return res.status(400).json({ message: 'from/to 형식이 올바르지 않습니다 (YYYY-MM-DD HH24:MI:SS).' });
  }
  try {
    res.json(await realtimeService.getSessionDetail({ dbmsid }, sidNumber, serialNumber, sqlId ?? null, range));
  } catch (error) {
    logger.error('Realtime', `세션 상세 조회 오류 (dbmsid=${dbmsid}, sid=${sid})`, error);
    res.status(500).json({ message: '세션 상세 정보를 조회하지 못했습니다.', error: errMsg(error) });
  }
}


// Blocking 체인의 세션 Kill (SUPER_ADMIN). inst_id/sid/serial#은 정수로 확인한 뒤에만 넘긴다 (ALTER SYSTEM 문자열에 들어감).
async function killSession(req: Request, res: Response): Promise<Response | void> {
  const { dbmsid, instId, sid, serial, confirmDbname } = req.body ?? {};
  const target = { instId: Number(instId), sid: Number(sid), serial: Number(serial) };
  if (!dbmsid || !Object.values(target).every((value) => Number.isInteger(value) && value >= 0)) {
    return res.status(400).json({ message: 'dbmsid, instId, sid, serial 정보가 필요합니다.' });
  }
  const who = req.session.username ?? 'unknown';
  try {
    const killed = await realtimeService.killSession({ dbmsid }, target, confirmDbname, who);
    logger.info('Realtime', `${who} 세션 Kill: ${killed.sid},${killed.serial},@${killed.instId} (dbmsid=${dbmsid}, ${killed.username ?? '-'})`);
    res.json({ ok: true, session: killed });
  } catch (error) {
    if (error instanceof SessionKillRefused) return res.status(400).json({ message: error.message });
    logger.error('Realtime', `세션 Kill 오류 (dbmsid=${dbmsid}, ${target.sid},${target.serial},@${target.instId}, ${who})`, error);
    res.status(500).json({ message: '세션을 Kill하지 못했습니다.', error: errMsg(error instanceof Error && error.cause ? error.cause : error) });
  }
}

export { getSessions, getSessionDetail, killSession };
