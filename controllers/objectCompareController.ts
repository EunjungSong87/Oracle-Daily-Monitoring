import type { Request, Response } from 'express';
import * as objectCompareService from '../services/objectCompareService';
import type { CompareSide } from '../services/objectCompareService';
import * as securityCompareService from '../services/securityCompareService';
import { SecurityCompareValidationError } from '../services/securityCompareService';
import type { SecuritySide } from '../services/securityCompareService';
import { logger } from '../utils/logger';

// 요청 본문의 { dbmsid, schema } 한 쌍을 검증합니다. 스키마명은 바인드 변수로만 쓰이므로 형식 검사는 하지 않습니다.
function parseSide(value: unknown): CompareSide | null {
  if (!value || typeof value !== 'object') return null;
  const { dbmsid, schema } = value as Record<string, unknown>;
  if ((typeof dbmsid !== 'number' && typeof dbmsid !== 'string') || dbmsid === '') return null;
  if (typeof schema !== 'string' || schema === '') return null;
  return { dbmsid, schema };
}

function describeSides(source: CompareSide, target: CompareSide): string {
  return `${source.dbmsid}:${source.schema} ↔ ${target.dbmsid}:${target.schema}`;
}

async function getSchemas(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbmsid } = req.body;
    if (!dbmsid) {
      return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    }
    const schemas = await objectCompareService.getSchemas({ dbmsid });
    res.status(200).json(schemas);
  } catch (error) {
    logger.error('ObjectCompare', `스키마 목록 조회 오류 (dbmsid=${req.body?.dbmsid})`, error);
    res.status(500).json({ message: '스키마 목록을 조회하지 못했습니다. 대상 DB 접속 정보와 권한을 확인하세요.' });
  }
}

async function compare(req: Request, res: Response): Promise<Response | void> {
  const source = parseSide(req.body?.source);
  const target = parseSide(req.body?.target);
  if (!source || !target) {
    return res.status(400).json({ message: '기준/대상 각각의 dbmsid, schema 정보가 필요합니다.' });
  }
  try {
    const result = await objectCompareService.compareSchemas(source, target, req.body.types, {
      ignoreTablespace: req.body.ignoreTablespace === true,
    });
    res.status(200).json(result);
  } catch (error) {
    logger.error('ObjectCompare', `오브젝트 비교 오류 (${describeSides(source, target)})`, error);
    res.status(500).json({ message: '오브젝트 비교 중 오류가 발생했습니다. 대상 DB 접속 정보와 딕셔너리 조회 권한을 확인하세요.' });
  }
}

async function getSourceDiff(req: Request, res: Response): Promise<Response | void> {
  const source = parseSide(req.body?.source);
  const target = parseSide(req.body?.target);
  const { type, name } = req.body ?? {};
  if (!source || !target || typeof type !== 'string' || typeof name !== 'string' || !type || !name) {
    return res.status(400).json({ message: '기준/대상 정보와 type, name 정보가 필요합니다.' });
  }
  try {
    const lines = await objectCompareService.getSourceDiff(source, target, type, name);
    res.status(200).json(lines);
  } catch (error) {
    logger.error('ObjectCompare', `소스 비교 오류 (${describeSides(source, target)}, ${type} ${name})`, error);
    res.status(500).json({ message: '소스 비교 중 오류가 발생했습니다.' });
  }
}


// ── 계정·권한 비교 ──

function parseDbmsSide(value: unknown): SecuritySide | null {
  if (!value || typeof value !== 'object') return null;
  const { dbmsid } = value as Record<string, unknown>;
  if ((typeof dbmsid !== 'number' && typeof dbmsid !== 'string') || dbmsid === '') return null;
  return { dbmsid };
}

async function getSecurityLists(req: Request, res: Response): Promise<Response | void> {
  const source = parseDbmsSide(req.body?.source);
  const target = parseDbmsSide(req.body?.target);
  if (!source || !target) {
    return res.status(400).json({ message: '기준/대상 dbmsid 정보가 필요합니다.' });
  }
  try {
    res.status(200).json(await securityCompareService.getLists(source, target));
  } catch (error) {
    logger.error('ObjectCompare', `계정/Role/Profile 목록 조회 오류 (${source.dbmsid} ↔ ${target.dbmsid})`, error);
    res.status(500).json({ message: '계정/Role/Profile 목록을 조회하지 못했습니다. 대상 DB 접속 정보와 DBA_USERS/DBA_ROLES 조회 권한을 확인하세요.' });
  }
}

async function compareSecurity(req: Request, res: Response): Promise<Response | void> {
  const source = parseDbmsSide(req.body?.source);
  const target = parseDbmsSide(req.body?.target);
  if (!source || !target) {
    return res.status(400).json({ message: '기준/대상 dbmsid 정보가 필요합니다.' });
  }
  try {
    res.status(200).json(await securityCompareService.compare(source, target, req.body?.selection));
  } catch (error) {
    if (error instanceof SecurityCompareValidationError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('ObjectCompare', `계정/권한 비교 오류 (${source.dbmsid} ↔ ${target.dbmsid})`, error);
    res.status(500).json({ message: '계정/권한 비교 중 오류가 발생했습니다. 대상 DB 접속 정보와 DBA_* 권한 뷰 조회 권한을 확인하세요.' });
  }
}

export { getSchemas, compare, getSourceDiff, getSecurityLists, compareSecurity };
