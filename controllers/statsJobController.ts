import { logger } from '../utils/logger';
import type { Request, Response } from 'express';
import * as statsJobService from '../services/statsJobService';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getJobStatus(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbmsid } = req.body;
    if (!dbmsid) {
      return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    }
    const jobs = await statsJobService.getJobStatus({ dbmsid });
    res.status(200).json(jobs);
  } catch (error) {
    logger.error('StatsJob', '통계 잡 현황 조회 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function getStaleStats(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbmsid, thresholdDays } = req.body;
    if (!dbmsid) {
      return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    }
    const days = Number(thresholdDays);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ message: 'thresholdDays는 양수여야 합니다.' });
    }
    const rows = await statsJobService.getStaleStats({ dbmsid }, days);
    res.status(200).json(rows);
  } catch (error) {
    logger.error('StatsJob', '통계 미수집 테이블 조회 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

// 접속 테스트와 동일한 이유로 200 + {success,message}로 응답합니다 — 잡 실행 실패(예: 이미 실행중)는
// 서버 오류가 아니라 정상적으로 발생할 수 있는 결과이기 때문입니다.
async function runJob(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbmsid, jobName } = req.body;
    if (!dbmsid || !jobName) {
      return res.status(400).json({ message: 'dbmsid, jobName 정보가 필요합니다.' });
    }
    await statsJobService.runJob({ dbmsid }, jobName);
    return res.status(200).json({ success: true, message: '잡을 실행했습니다.' });
  } catch (error) {
    logger.error('StatsJob', '통계 잡 수동 실행 오류', error);
    return res.status(200).json({ success: false, message: errMsg(error) });
  }
}

export { getJobStatus, getStaleStats, runJob };
