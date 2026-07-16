import * as dbmsList from '../models/dbmsModel'; // 데이터 모델 가져오기
import type { DbmsIdParam, DbmsInfo, ScriptInfo, ThresholdInfo, QueryResult } from '../models/dbmsModel';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 사용자 목록 가져오기
async function getAllDbmses(): Promise<QueryResult> {
  try {
    console.log('getAllDbmses Services ');
    return await dbmsList.getAllDbmses();
  } catch (error) {
    console.error('Service : 사용자 목록 조회 실패:', error);
    throw new Error('사용자 목록 조회 실패', { cause: error });
  }
}

// <-- 모니터링 스크립트 정보 가져오기
async function getScripts(): Promise<QueryResult> {
  try {
    console.log('getScripts Service!! ');
    return await dbmsList.getScripts();
  } catch (error) {
    console.error('Service : 스크립트 목록 조회 실패:', error);
    throw new Error('스크립트 목록 조회 실패', { cause: error });
  }
}

async function getDbmsInfo(dbmsid: DbmsIdParam): Promise<any[] | null> {
  try {
    return await dbmsList.getDbmsInfo(dbmsid);
  } catch (error) {
    console.error('Service : DBMS 정보 가져오기 실패:', error);
    throw new Error('DBMS 정보 가져오기 실패', { cause: error });
  }
}

async function getSqlText(scriptid: { id: number | string }): Promise<string | null> {
  try {
    const sql = await dbmsList.getSqlText(scriptid);
    console.log('Get SQL TEXT', sql);
    return sql;
  } catch (error) {
    console.error('Service : script 정보 가져오기 실패:', error);
    throw new Error('script 정보 가져오기 실패', { cause: error });
  }
}

async function listTasks(): Promise<any> {
  try {
    console.log('system.listTasks 서비스 함수');
    return await dbmsList.listTasks();
  } catch (error) {
    console.error('Service : Tasks 가져오기 실패:', error);
    throw new Error('Tasks 가져오기 실패', { cause: error });
  }
}

interface ThresholdAlert {
  level: string;
  message?: string;
}

// 값 하나가 임계치 규칙을 위반하는지 판단합니다.
function evaluateThreshold(
  rawValue: unknown,
  conditionType: string,
  operator: string,
  thresholdValue: string
): boolean {
  if (rawValue === null || rawValue === undefined) return false;

  if (conditionType === 'NUMERIC') {
    const value = parseFloat(String(rawValue).replace(/[^0-9.-]/g, ''));
    const limit = parseFloat(thresholdValue);
    if (Number.isNaN(value) || Number.isNaN(limit)) return false;
    switch (operator) {
      case '>':
        return value > limit;
      case '>=':
        return value >= limit;
      case '<':
        return value < limit;
      case '<=':
        return value <= limit;
      case '=':
        return value === limit;
      case '!=':
        return value !== limit;
      default:
        return false;
    }
  }

  const strValue = String(rawValue);
  const strLimit = String(thresholdValue);

  if (conditionType === 'STRING') {
    if (operator === '=') return strValue === strLimit;
    if (operator === '!=') return strValue !== strLimit;
    return false;
  }

  if (conditionType === 'PATTERN') {
    return strValue.includes(strLimit);
  }

  return false;
}

// task에 걸린 임계치 규칙들을 각 row에 적용해 위반한 컬럼에 _alerts를 붙입니다.
function applyThresholds(
  rows: Record<string, any>[],
  thresholdsForTask: Record<string, any>[] | undefined
): Record<string, any>[] {
  if (!thresholdsForTask || thresholdsForTask.length === 0) return rows;

  return rows.map((row) => {
    const alerts: Record<string, ThresholdAlert> = {};
    for (const th of thresholdsForTask) {
      const column = th.COLUMN_NAME;
      if (evaluateThreshold(row[column], th.CONDITION_TYPE, th.OPERATOR, th.THRESHOLD)) {
        alerts[column] = { level: th.CLEVEL, message: th.MESSAGE };
      }
    }
    return Object.keys(alerts).length > 0 ? { ...row, _alerts: alerts } : row;
  });
}

async function getMonResult(dbmsid: DbmsIdParam): Promise<Record<string, any>[]> {
  const results: Record<string, any>[] = [];
  let dbconfig: any[] | null;
  let tasks: any;
  let thresholds: Record<string, any>[];
  try {
    dbconfig = await getDbmsInfo(dbmsid);
    tasks = await listTasks();
    thresholds = await dbmsList.getActiveThresholds();
  } catch (error) {
    console.error('Service : Monitoring Result 가져오기 실패:', error);
    throw new Error('Monitoring Result 가져오기 실패', { cause: error });
  }

  if (!dbconfig) {
    throw new Error('DBMS 정보를 찾을 수 없습니다.');
  }

  const thresholdsByTask: Record<string, Record<string, any>[]> = {};
  for (const th of thresholds) {
    const key = th.TASK_ID;
    if (!thresholdsByTask[key]) thresholdsByTask[key] = [];
    thresholdsByTask[key].push(th);
  }

  // 태스크마다 새로 연결하지 않고, 대상 DB 커넥션 하나를 열어서 모든 체크에 재사용합니다.
  let targetConnection;
  try {
    targetConnection = await dbmsList.connectToTarget(dbconfig);
  } catch (error) {
    console.error('Service : 대상 DB 접속 실패:', error);
    throw new Error('대상 DB 접속 실패', { cause: error });
  }

  try {
    for (const row of tasks.rows) {
      const id = row[0];
      const checkName = row[1];
      const sql = row[2];

      // ogg_discard_log 체크는 VAN 계열 DBMS엔 대상 테이블이 없어 스킵합니다.
      if (sql.includes('ogg_discard_log') && dbconfig[5].includes('VAN')) {
        continue;
      }

      try {
        const result = await dbmsList.executeQuery(targetConnection, sql);
        results.push({
          task_id: id,
          task_name: checkName,
          columns: result.columns,
          rows: applyThresholds(result.rows, thresholdsByTask[id]),
          success: true,
        });
      } catch (error) {
        console.error(`Service : 태스크(${id}:${checkName}) 실행 실패:`, error);
        results.push({
          task_id: id,
          task_name: checkName,
          columns: [],
          rows: [],
          success: false,
          error: errMsg(error),
        });
      }
    }
  } finally {
    await targetConnection.close();
  }

  return results;
}

async function addDbms(dbmsInfo: DbmsInfo): Promise<number> {
  try {
    return await dbmsList.addDbms(dbmsInfo);
  } catch (error) {
    console.error('Service : DBMS 등록 실패:', error);
    throw new Error('Service : DBMS 등록 실패', { cause: error });
  }
}

async function modifyDbms(dbmsInfo: DbmsInfo): Promise<number> {
  try {
    return await dbmsList.modifyDbms(dbmsInfo);
  } catch (error) {
    console.error('Service : DBMS 수정 실패:', error);
    throw new Error('Service : DBMS 수정 실패', { cause: error });
  }
}

async function modifyScript(scriptInfo: ScriptInfo): Promise<number> {
  try {
    return await dbmsList.modifyScript(scriptInfo);
  } catch (error) {
    console.error('Service : 스크립트 수정 실패:', error);
    throw new Error('Service : 스크립트 수정 실패', { cause: error });
  }
}

async function deleteDbms(dbmsId: Record<string, any>): Promise<number> {
  try {
    return await dbmsList.deleteDbms(dbmsId);
  } catch (error) {
    console.error('Service : DBMS 삭제 실패:', error);
    throw new Error('Service : DBMS 삭제 실패', { cause: error });
  }
}

async function addScript(scriptInfo: ScriptInfo): Promise<number> {
  try {
    return await dbmsList.addScript(scriptInfo);
  } catch (error) {
    console.error('Service : 스크립트 등록 실패:', error);
    throw new Error('Service : 스크립트 등록 실패', { cause: error });
  }
}

async function deleteScript(scriptId: Record<string, any>): Promise<number> {
  try {
    return await dbmsList.deleteScript(scriptId);
  } catch (error) {
    console.error('Service : 스크립트 삭제 실패:', error);
    throw new Error('Service : 스크립트 삭제 실패', { cause: error });
  }
}

async function getThresholds(): Promise<QueryResult> {
  try {
    return await dbmsList.getThresholds();
  } catch (error) {
    console.error('Service : 임계치 목록 조회 실패:', error);
    throw new Error('임계치 목록 조회 실패', { cause: error });
  }
}

async function addThreshold(thresholdInfo: ThresholdInfo): Promise<number> {
  try {
    return await dbmsList.addThreshold(thresholdInfo);
  } catch (error) {
    console.error('Service : 임계치 등록 실패:', error);
    throw new Error('Service : 임계치 등록 실패', { cause: error });
  }
}

async function modifyThreshold(thresholdInfo: ThresholdInfo): Promise<number> {
  try {
    return await dbmsList.modifyThreshold(thresholdInfo);
  } catch (error) {
    console.error('Service : 임계치 수정 실패:', error);
    throw new Error('Service : 임계치 수정 실패', { cause: error });
  }
}

async function deleteThreshold(thresholdId: Record<string, any>): Promise<number> {
  try {
    return await dbmsList.deleteThreshold(thresholdId);
  } catch (error) {
    console.error('Service : 임계치 삭제 실패:', error);
    throw new Error('Service : 임계치 삭제 실패', { cause: error });
  }
}

export {
  getAllDbmses,
  getDbmsInfo,
  getMonResult,
  addDbms,
  modifyDbms,
  deleteDbms,
  listTasks,
  getScripts,
  getSqlText,
  modifyScript,
  addScript,
  deleteScript,
  getThresholds,
  addThreshold,
  modifyThreshold,
  deleteThreshold,
  // 순수 함수라 단위 테스트에서 직접 검증합니다.
  evaluateThreshold,
  applyThresholds,
};
