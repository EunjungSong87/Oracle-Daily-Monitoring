import * as dbmsList from '../models/dbmsModel'; // 데이터 모델 가져오기
import type {
  DbmsIdParam,
  DbmsInfo,
  ScriptInfo,
  ThresholdInfo,
  QueryResult,
  ScheduleConfig,
  TestConnectionInput,
} from '../models/dbmsModel';
import type oracledb from 'oracledb';
import { CALL_TIMEOUT_MS, classifyTargetError } from '../models/targetDbTimeouts';
import * as historyModel from '../models/historyModel';
import * as capacityService from './capacityService';
import * as issuesModel from '../models/issuesModel';
import { logger } from '../utils/logger';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// DBMS 목록 가져오기
async function getAllDbmses(): Promise<QueryResult> {
  try {
    return await dbmsList.getAllDbmses();
  } catch (error) {
    throw new Error('DBMS 목록 조회 실패', { cause: error });
  }
}

// <-- 모니터링 스크립트 정보 가져오기
async function getScripts(): Promise<QueryResult> {
  try {
    return await dbmsList.getScripts();
  } catch (error) {
    throw new Error('스크립트 목록 조회 실패', { cause: error });
  }
}

async function getDbmsInfo(dbmsid: DbmsIdParam): Promise<any[] | null> {
  try {
    return await dbmsList.getDbmsInfo(dbmsid);
  } catch (error) {
    throw new Error('DBMS 정보 가져오기 실패', { cause: error });
  }
}

async function getSqlText(scriptid: { id: number | string }): Promise<string | null> {
  try {
    const sql = await dbmsList.getSqlText(scriptid);
    return sql;
  } catch (error) {
    throw new Error('script 정보 가져오기 실패', { cause: error });
  }
}

async function listTasks(): Promise<any> {
  try {
    return await dbmsList.listTasks();
  } catch (error) {
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

async function getMonResult(
  dbmsid: DbmsIdParam,
  triggerType: 'MANUAL' | 'SCHEDULED' = 'MANUAL'
): Promise<Record<string, any>[]> {
  const results: Record<string, any>[] = [];
  let dbconfig: any[] | null;
  let tasks: any;
  let thresholds: Record<string, any>[];
  try {
    dbconfig = await getDbmsInfo(dbmsid);
    tasks = await listTasks();
    thresholds = await dbmsList.getActiveThresholds();
  } catch (error) {
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
  // 태스크 하나가 오래 물려 나머지(그리고 예약 점검의 다음 DB들)를 막지 않도록 쿼리 타임아웃을 겁니다.
  const callTimeoutMs = CALL_TIMEOUT_MS.monitoring;
  const connectOptions = { callTimeoutMs };
  let targetConnection: oracledb.Connection | null;
  try {
    targetConnection = await dbmsList.connectToTarget(dbconfig, connectOptions);
  } catch (error) {
    throw new Error('대상 DB 접속 실패', { cause: error });
  }

  // 타임아웃 뒤 재접속까지 실패하면 남은 태스크는 이 사유로 실패 처리합니다.
  let reconnectError: string | null = null;
  const failed = (id: unknown, checkName: unknown, error: string) => ({
    task_id: id,
    task_name: checkName,
    columns: [],
    rows: [],
    success: false,
    error,
  });

  try {
    for (const row of tasks.rows) {
      const id = row[0];
      const checkName = row[1];
      const sql = row[2];

      // ogg_discard_log 체크는 VAN 계열 DBMS엔 대상 테이블이 없어 스킵합니다.
      if (sql.includes('ogg_discard_log') && dbconfig[5].includes('VAN')) {
        continue;
      }

      if (!targetConnection) {
        results.push(failed(id, checkName, `대상 DB 접속 실패: ${reconnectError}`));
        continue;
      }

      const startedAt = Date.now();
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
        const elapsedMs = Date.now() - startedAt;
        const kind = classifyTargetError(error, elapsedMs, callTimeoutMs);
        const label = kind === 'TIMEOUT' ? '시간 초과' : kind === 'DISCONNECTED' ? '중 연결 끊김' : '실패';
        logger.warn('Monitor', `[${dbconfig[6]}] 태스크 ${id}(${checkName}) 실행 ${label}`, error);
        results.push(
          failed(
            id,
            checkName,
            kind === 'TIMEOUT'
              ? `실행 시간 초과 (${Math.round(elapsedMs / 1000)}초)`
              : kind === 'DISCONNECTED'
                ? `대상 DB 연결 끊김 (${errMsg(error).split('\n')[0]})`
                : errMsg(error)
          )
        );

        // 타임아웃(Thick 모드에선 NJS-500으로 옴)이나 연결 끊김 뒤의 커넥션은 NJS-003으로 다시 못 쓰므로
        // 닫고(실패는 무시) 새로 접속해 남은 태스크를 이어 갑니다.
        if (kind !== 'ERROR') {
          await targetConnection.close().catch(() => undefined);
          targetConnection = null;
          try {
            targetConnection = await dbmsList.connectToTarget(dbconfig, connectOptions);
          } catch (reconnectFailure) {
            reconnectError = errMsg(reconnectFailure);
            logger.warn('Monitor', `[${dbconfig[6]}] 재접속 실패 — 남은 태스크는 접속 실패로 처리`, reconnectFailure);
          }
        }
      }
    }
    // 예약 점검이면 같은 커넥션으로 용량(테이블스페이스/ASM)을 하루 한 번 수집하고, 소진 예측을 가상 태스크로 붙인다 (실패해도 점검은 그대로).
    if (triggerType === 'SCHEDULED' && targetConnection) {
      const capacityTask = await capacityService.collectForScheduled(targetConnection, dbmsid.dbmsid, dbconfig[6]);
      if (capacityTask) results.push(capacityTask);
    }
  } finally {
    if (targetConnection) await targetConnection.close();
  }

  // 이력 저장/이슈 동기화는 부가 기능이라, 실패해도 실제 점검 응답에는 영향을 주지 않습니다.
  try {
    const dbname = dbconfig[6];
    const runHistoryId = await historyModel.saveRunHistory(dbmsid.dbmsid, dbname, triggerType, results);
    try {
      await issuesModel.syncIssues(dbmsid.dbmsid, dbname, runHistoryId, results);
    } catch (error) {
      logger.warn('Monitor', `[${dbname}] 이슈 동기화 실패 (점검 결과는 정상 반환)`, error);
    }
  } catch (error) {
    logger.warn('Monitor', `[${dbconfig[6]}] 실행 이력 저장 실패 (점검 결과는 정상 반환)`, error);
  }

  return results;
}

// 다른 CRUD 함수들과 달리 원본 에러를 그대로 던집니다 — 이 기능의 목적 자체가
// 실제 Oracle 에러(예: ORA-12514)를 사용자에게 그대로 보여주는 것이기 때문입니다.
async function testConnection(input: TestConnectionInput): Promise<void> {
  await dbmsList.testConnection(input);
}

async function addDbms(dbmsInfo: DbmsInfo): Promise<number> {
  try {
    return await dbmsList.addDbms(dbmsInfo);
  } catch (error) {
    throw new Error('DBMS 등록 실패', { cause: error });
  }
}

async function modifyDbms(dbmsInfo: DbmsInfo): Promise<number> {
  try {
    return await dbmsList.modifyDbms(dbmsInfo);
  } catch (error) {
    throw new Error('DBMS 수정 실패', { cause: error });
  }
}

async function modifyScript(scriptInfo: ScriptInfo): Promise<number> {
  try {
    return await dbmsList.modifyScript(scriptInfo);
  } catch (error) {
    throw new Error('스크립트 수정 실패', { cause: error });
  }
}

async function deleteDbms(dbmsId: Record<string, any>): Promise<number> {
  try {
    return await dbmsList.deleteDbms(dbmsId);
  } catch (error) {
    throw new Error('DBMS 삭제 실패', { cause: error });
  }
}

async function addScript(scriptInfo: ScriptInfo): Promise<number> {
  try {
    return await dbmsList.addScript(scriptInfo);
  } catch (error) {
    throw new Error('스크립트 등록 실패', { cause: error });
  }
}

async function deleteScript(scriptId: Record<string, any>): Promise<number> {
  try {
    return await dbmsList.deleteScript(scriptId);
  } catch (error) {
    throw new Error('스크립트 삭제 실패', { cause: error });
  }
}

async function getThresholds(): Promise<QueryResult> {
  try {
    return await dbmsList.getThresholds();
  } catch (error) {
    throw new Error('임계치 목록 조회 실패', { cause: error });
  }
}

async function addThreshold(thresholdInfo: ThresholdInfo): Promise<number> {
  try {
    return await dbmsList.addThreshold(thresholdInfo);
  } catch (error) {
    throw new Error('임계치 등록 실패', { cause: error });
  }
}

async function modifyThreshold(thresholdInfo: ThresholdInfo): Promise<number> {
  try {
    return await dbmsList.modifyThreshold(thresholdInfo);
  } catch (error) {
    throw new Error('임계치 수정 실패', { cause: error });
  }
}

async function deleteThreshold(thresholdId: Record<string, any>): Promise<number> {
  try {
    return await dbmsList.deleteThreshold(thresholdId);
  } catch (error) {
    throw new Error('임계치 삭제 실패', { cause: error });
  }
}

async function getScheduleConfig(): Promise<ScheduleConfig> {
  try {
    return await dbmsList.getScheduleConfig();
  } catch (error) {
    throw new Error('예약 실행 설정 조회 실패', { cause: error });
  }
}

async function saveScheduleConfig(config: ScheduleConfig, dbmsIds: (number | string)[]): Promise<void> {
  try {
    await dbmsList.saveScheduleConfig(config);
    await dbmsList.setAutoScheduleTargets(dbmsIds);
  } catch (error) {
    throw new Error('예약 실행 설정 저장 실패', { cause: error });
  }
}

export {
  getAllDbmses,
  getDbmsInfo,
  getMonResult,
  testConnection,
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
  getScheduleConfig,
  saveScheduleConfig,
  // 순수 함수라 단위 테스트에서 직접 검증합니다.
  evaluateThreshold,
  applyThresholds,
};
