import type { Request, Response } from 'express';
import { DataPumpValidationError } from '../services/dataPumpErrors';
import * as migrationVerifyService from '../services/migrationVerifyService';
import { logger } from '../utils/logger';

// Maintenance > 이관 검증

function detailMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(' ← ');
}

function handleError(res: Response, error: unknown, logMessage: string): void {
  if (error instanceof DataPumpValidationError) {
    res.status(400).json({ message: error.message, ...(error.items.length > 0 ? { items: error.items } : {}) });
    return;
  }
  logger.error('MigrationVerify', logMessage, error);
  res.status(500).json({ message: detailMessage(error) });
}

async function plans(_req: Request, res: Response): Promise<void> {
  try {
    res.json({ rows: await migrationVerifyService.listPlans() });
  } catch (error) {
    handleError(res, error, '이관 Import 목록 조회 오류');
  }
}

async function run(req: Request, res: Response): Promise<void> {
  try {
    res.json(await migrationVerifyService.run(req.body?.scope ?? {}));
  } catch (error) {
    handleError(res, error, '이관 검증 오류');
  }
}

async function count(req: Request, res: Response): Promise<void> {
  try {
    res.json({ rows: await migrationVerifyService.count(req.body?.scope ?? {}, req.body?.targetKeys) });
  } catch (error) {
    handleError(res, error, '이관 검증 COUNT 오류');
  }
}

async function compile(req: Request, res: Response): Promise<void> {
  const who = req.session.username ?? 'unknown';
  try {
    const results = await migrationVerifyService.compile(req.body?.scope ?? {}, req.body?.objects, req.body?.confirmDbname, who);
    logger.info('MigrationVerify', `${who} 재컴파일 ${results.length}개 (성공 ${results.filter((r) => r.ok).length})`);
    res.json({ results });
  } catch (error) {
    handleError(res, error, `이관 검증 재컴파일 오류 (${who})`);
  }
}

async function excel(req: Request, res: Response): Promise<void> {
  try {
    const buffer = await migrationVerifyService.excel(req.body?.result);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="migration_verify_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    handleError(res, error, '이관 검증 엑셀 오류');
  }
}

export { plans, run, count, compile, excel };
