import type { Request, Response } from 'express';
import * as dashboardService from '../services/dashboardService';
import * as capacityService from '../services/capacityService';
import { logger } from '../utils/logger';

// 첫 화면(전체 DB 현황) — 메타데이터 DB만 읽음
async function getDashboard(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await dashboardService.getDashboard());
  } catch (error) {
    logger.error('Dashboard', '대시보드 조회 오류', error);
    res.status(500).json({ message: '대시보드를 불러오지 못했습니다.' });
  }
}

function dbmsIdOf(req: Request, res: Response): number | null {
  const id = Number(req.body?.dbmsid);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: 'dbmsid가 필요합니다.' });
    return null;
  }
  return id;
}

async function getCapacity(req: Request, res: Response): Promise<void> {
  const dbmsid = dbmsIdOf(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await capacityService.getCapacity(dbmsid));
  } catch (error) {
    logger.error('Capacity', `용량 현황 조회 오류 (dbmsid=${dbmsid})`, error);
    res.status(500).json({ message: '용량 현황을 불러오지 못했습니다.' });
  }
}

async function getCapacityTrend(req: Request, res: Response): Promise<void> {
  const dbmsid = dbmsIdOf(req, res);
  if (dbmsid === null) return;
  const { kind, name } = req.body;
  const days = Math.min(Math.max(Number(req.body.days) || 365, 7), 3650);
  if (!['TABLESPACE', 'ASM'].includes(kind) || typeof name !== 'string' || !name) {
    res.status(400).json({ message: '항목이 올바르지 않습니다.' });
    return;
  }
  try {
    res.json({ points: await capacityService.getTrend(dbmsid, kind, name, days) });
  } catch (error) {
    logger.error('Capacity', `용량 추이 조회 오류 (dbmsid=${dbmsid}, ${kind} ${name})`, error);
    res.status(500).json({ message: '추이를 불러오지 못했습니다.' });
  }
}

async function saveCapacityConfig(req: Request, res: Response): Promise<void> {
  const num = (value: unknown, min: number, max: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const retentionDays = num(req.body.retentionDays, 30, 3650);
  const alertDays = num(req.body.alertDays, 1, 365);
  const thresholdPct = num(req.body.thresholdPct, 50, 100);
  if (retentionDays === null || alertDays === null || thresholdPct === null) {
    res.status(400).json({ message: '보관 기간 30~3650일, 알림 1~365일, 임계치 50~100%로 입력해주세요.' });
    return;
  }
  try {
    await capacityService.saveConfig({ retentionDays, alertDays, thresholdPct });
    logger.info('Capacity', `${req.session.username} 설정 변경: 보관 ${retentionDays}일, 알림 ${alertDays}일, 임계치 ${thresholdPct}%`);
    res.json({ message: '저장했습니다.' });
  } catch (error) {
    logger.error('Capacity', '용량 설정 저장 오류', error);
    res.status(500).json({ message: '설정을 저장하지 못했습니다 (scripts/add_capacity_history.sql 실행 여부 확인).' });
  }
}

export { getDashboard, getCapacity, getCapacityTrend, saveCapacityConfig };
