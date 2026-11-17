import type { Request, Response } from 'express';
import * as alertLogService from '../services/alertLogService';
import { parseSearchParams } from '../services/alertLogRules';
import { logger } from '../utils/logger';

// Monitoring > Alert Log — 메타데이터 DB만 읽는다 (수집은 예약 일일점검)

async function search(req: Request, res: Response): Promise<void> {
  const parsed = parseSearchParams(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }
  try {
    res.json(await alertLogService.search(parsed.params));
  } catch (error) {
    logger.error('AlertLog', `Alert Log 검색 오류 (dbmsId=${parsed.params.dbmsId ?? '전체'}, ${parsed.params.fromDate}~${parsed.params.toDate})`, error);
    res.status(500).json({ message: 'Alert Log를 검색하지 못했습니다 (scripts/add_alert_log_history.sql 실행 여부 확인).' });
  }
}

async function trend(req: Request, res: Response): Promise<void> {
  const parsed = parseSearchParams(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }
  try {
    res.json({ points: await alertLogService.trend(parsed.params) });
  } catch (error) {
    logger.error('AlertLog', `Alert Log 추이 조회 오류 (dbmsId=${parsed.params.dbmsId ?? '전체'}, ${parsed.params.fromDate}~${parsed.params.toDate})`, error);
    res.status(500).json({ message: '발생 추이를 불러오지 못했습니다.' });
  }
}

async function getConfig(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await alertLogService.getConfig());
  } catch (error) {
    logger.error('AlertLog', 'Alert Log 설정 조회 오류', error);
    res.status(500).json({ message: '설정을 불러오지 못했습니다.' });
  }
}

async function saveConfig(req: Request, res: Response): Promise<void> {
  const retentionDays = Number(req.body?.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) {
    res.status(400).json({ message: '보관 기간은 30~3650일로 입력해주세요.' });
    return;
  }
  try {
    await alertLogService.saveConfig({ retentionDays });
    logger.info('AlertLog', `${req.session.username} 설정 변경: 보관 ${retentionDays}일`);
    res.json({ message: '저장했습니다.' });
  } catch (error) {
    logger.error('AlertLog', 'Alert Log 설정 저장 오류', error);
    res.status(500).json({ message: '설정을 저장하지 못했습니다 (scripts/add_alert_log_history.sql 실행 여부 확인).' });
  }
}

export { search, trend, getConfig, saveConfig };
