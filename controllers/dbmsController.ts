import type { Request, Response } from 'express';
import * as dbmsService from '../services/dbmsService';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 모든 dbms 가져오기
async function getAllDbmses(req: Request, res: Response): Promise<void> {
  try {
    const dbmses = await dbmsService.getAllDbmses(); // 서비스 호출
    res.status(200).json(dbmses); // JSON 형식으로 응답
  } catch (error) {
    console.error('Controller : DBMS 목록 조회 오류:', error);
    res.status(500).json({ error: errMsg(error) });
  }
}

// <--! 모니터링 스크립트 가져오기 -->
async function getScripts(req: Request, res: Response): Promise<void> {
  try {
    console.log('getScripts Controller !!!!!');
    const scripts = await dbmsService.getScripts(); // 서비스 호출
    res.status(200).json(scripts); // JSON 형식으로 응답
  } catch (error) {
    console.error('Controller : 스크립트 목록 조회 오류:', error);
    res.status(500).json({ error: errMsg(error) });
  }
}

async function getMonResult(req: Request, res: Response): Promise<Response | void> {
  try {
    const dbmsid = req.body;

    // 필수 데이터 유효성 검사
    if (!dbmsid) {
      return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    }

    const queryResults = await dbmsService.getMonResult(dbmsid);

    res.json(queryResults);
  } catch (error) {
    console.error('DBMS 조회 중 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function addDbms(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbname, username, password, sid, ip, port, memo } = req.body;

    const dbmsInfo = { dbname, username, password, sid, ip, port, memo }; // JSON 변수로 서비스에 전달
    console.log('Controller :dbmsInfo:', { ...dbmsInfo, password: '***' });
    const queryResults = await dbmsService.addDbms(dbmsInfo);
    console.log('Controller : result  ', queryResults);

    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : DB등록 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function modifyDbms(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, dbname, username, password, sid, ip, port, memo } = req.body;
    const dbmsInfo = { id, dbname, username, password, sid, ip, port, memo };
    console.log('Controller :dbmsInfo:', { ...dbmsInfo, password: '***' });
    const queryResults = await dbmsService.modifyDbms(dbmsInfo);
    console.log('Controller : result  ', queryResults);

    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : DB등록 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function deleteDbms(req: Request, res: Response): Promise<Response | void> {
  try {
    const dbmsId = req.body;

    console.error('Controller :dbmsInfo:', dbmsId);
    const queryResults = await dbmsService.deleteDbms(dbmsId);
    console.log('Controller : result  ', queryResults);

    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : DB등록 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function modifyScript(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, name, category, description, sql_text, schedule, is_active } = req.body;
    const scriptInfo = { id, name, category, description, sql_text, schedule, is_active };

    console.log('Controller : ScriptInfo:', scriptInfo);
    const queryResults = await dbmsService.modifyScript(scriptInfo);
    console.log('Controller : Script result  ', queryResults);

    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : 스크립트 수정 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function getSqlText(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, name } = req.body;
    console.log(name);
    // 필수 데이터 유효성 검사
    if (!id || !name) {
      return res.status(400).json({ message: 'Script 정보가 필요합니다.' });
    }
    // JSON 형태로 서비스 호출
    const queryData = { id, name }; // JSON 변수로 서비스에 전달
    const scriptconfig = await dbmsService.getSqlText(queryData);
    // 사용자 정보가 없을 경우
    if (!scriptconfig) {
      return res.status(404).json({ message: 'Script 찾을 수 없습니다.' });
    }
    // 조회된 사용자 정보를 클라이언트로 응답
    res.status(200).json({ message: 'Script 조회 성공', scriptconfig });
  } catch (error) {
    console.error('Script 조회 중 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function addScript(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, name, category, description, sql_text, schedule, is_active } = req.body;

    const scriptInfo = { id, name, category, description, sql_text, schedule, is_active }; // JSON 변수로 서비스에 전달
    console.error('Controller :dbmsInfo:', scriptInfo);
    const queryResults = await dbmsService.addScript(scriptInfo);
    console.log('Controller : result  ', queryResults);

    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : 스크립트 등록 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function deleteScript(req: Request, res: Response): Promise<Response | void> {
  try {
    const scriptId = req.body;

    console.error('Controller :scriptId :', scriptId);
    const queryResults = await dbmsService.deleteScript(scriptId);
    console.log('Controller : result  ', queryResults);

    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : 스크립트 삭제 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function getThresholds(req: Request, res: Response): Promise<void> {
  try {
    const thresholds = await dbmsService.getThresholds();
    res.status(200).json(thresholds);
  } catch (error) {
    console.error('Controller : 임계치 목록 조회 오류:', error);
    res.status(500).json({ error: errMsg(error) });
  }
}

async function addThreshold(req: Request, res: Response): Promise<Response | void> {
  try {
    const { task_id, column_name, condition_type, operator, threshold, clevel, message, is_active } = req.body;
    const thresholdInfo = { task_id, column_name, condition_type, operator, threshold, clevel, message, is_active };
    console.log('Controller : thresholdInfo:', thresholdInfo);
    const queryResults = await dbmsService.addThreshold(thresholdInfo);
    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : 임계치 등록 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function modifyThreshold(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active } = req.body;
    const thresholdInfo = { id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active };
    console.log('Controller : thresholdInfo:', thresholdInfo);
    const queryResults = await dbmsService.modifyThreshold(thresholdInfo);
    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : 임계치 수정 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

async function deleteThreshold(req: Request, res: Response): Promise<Response | void> {
  try {
    const thresholdId = req.body;
    console.log('Controller : thresholdId:', thresholdId);
    const queryResults = await dbmsService.deleteThreshold(thresholdId);
    return res.json(queryResults);
  } catch (error) {
    console.error('Controller : 임계치 삭제 오류:', error);
    res.status(500).json({ message: 'Controller : 서버 오류 발생' });
  }
}

export {
  getAllDbmses,
  getMonResult,
  addDbms,
  modifyDbms,
  deleteDbms,
  getScripts,
  modifyScript,
  getSqlText,
  addScript,
  deleteScript,
  getThresholds,
  addThreshold,
  modifyThreshold,
  deleteThreshold,
};
