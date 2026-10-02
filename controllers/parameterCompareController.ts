import type { Request, Response } from 'express';
import * as parameterCompareService from '../services/parameterCompareService';
import { logger } from '../utils/logger';

function isDbmsId(value: unknown): value is number | string {
  return (typeof value === 'number' || typeof value === 'string') && value !== '';
}

async function compare(req: Request, res: Response): Promise<Response | void> {
  const { sourceDbmsId, targetDbmsId } = req.body ?? {};
  if (!isDbmsId(sourceDbmsId) || !isDbmsId(targetDbmsId)) {
    return res.status(400).json({ message: 'sourceDbmsId, targetDbmsId 정보가 필요합니다.' });
  }
  try {
    const result = await parameterCompareService.compareParameters(sourceDbmsId, targetDbmsId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('ParameterCompare', `파라미터 비교 오류 (dbmsid ${sourceDbmsId} ↔ ${targetDbmsId})`, error);
    res.status(500).json({ message: '파라미터 비교 중 오류가 발생했습니다. 대상 DB 접속 정보와 V$PARAMETER 조회 권한을 확인하세요.' });
  }
}

export { compare };
