import type { Request, Response } from 'express';
import * as notifyConfigService from '../services/notifyConfigService';
import { NotifyValidationError } from '../services/notifyRules';
import { logger } from '../utils/logger';

// 계정 > 알림 설정 (최고관리자 전용). 입력 검증 실패는 400, 나머지는 500.
function fail(res: Response, error: unknown, what: string): void {
  if (error instanceof NotifyValidationError) {
    res.status(400).json({ message: error.message });
    return;
  }
  logger.error('Notify', `${what} 오류`, error);
  res.status(500).json({ message: '서버 오류 발생' });
}

async function getConfig(req: Request, res: Response): Promise<void> {
  try {
    res.json(await notifyConfigService.getView());
  } catch (error) {
    fail(res, error, '알림 설정 조회');
  }
}

async function saveConfig(req: Request, res: Response): Promise<void> {
  try {
    await notifyConfigService.save(req.body, req.session.username ?? null);
    logger.info('Notify', `알림 설정 변경 (by ${req.session.username})`);
    res.json({ message: '알림 설정을 저장했습니다.' });
  } catch (error) {
    fail(res, error, '알림 설정 저장');
  }
}

async function sendTest(req: Request, res: Response): Promise<void> {
  try {
    res.json(await notifyConfigService.sendTest(req.body, req.session.username ?? null));
  } catch (error) {
    fail(res, error, '알림 테스트 발송');
  }
}

async function telegramChats(req: Request, res: Response): Promise<void> {
  try {
    res.json(await notifyConfigService.findTelegramChats(req.body));
  } catch (error) {
    fail(res, error, 'Telegram 대화방 조회');
  }
}

export { getConfig, saveConfig, sendTest, telegramChats };
