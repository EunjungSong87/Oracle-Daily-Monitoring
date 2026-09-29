import { logger } from '../utils/logger';
import type { Request, Response } from 'express';
import * as realtimeService from '../services/realtimeService';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getSessions(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbmsid } = req.body;
    if (!dbmsid) {
      return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    }
    const sessions = await realtimeService.getSessions({ dbmsid });
    res.json({ timestamp: new Date().toISOString(), sessions });
  } catch (error) {
    logger.error('Realtime', `실시간 세션 조회 오류 (dbmsid=${req.body?.dbmsid})`, error);
    res.status(500).json({ message: '서버 오류 발생', error: errMsg(error) });
  }
}

export { getSessions };
