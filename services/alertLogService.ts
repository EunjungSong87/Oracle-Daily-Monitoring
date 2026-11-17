import type oracledb from 'oracledb';
import * as alertLogModel from '../models/alertLogModel';
import type { AlertLogConfig, AlertLogRow, AlertLogTrendPoint } from '../models/alertLogModel';
import { toSamples } from './alertLogRules';
import type { AlertLogSearchParams } from './alertLogRules';
import { logger } from '../utils/logger';

// Monitoring > Alert Log: 대상 DB의 Alert Log(ORA-/FAIL) 발생 내역을 쌓아 DB/기간/ORA 코드로 검색한다.
// 수집은 예약 일일점검이 같은 대상 DB 커넥션으로 (dbmsService.getMonResult), 화면은 메타데이터 DB만 읽는다.
// Capacity와 달리 이슈 티켓(_alerts)/가상 태스크는 만들지 않는다 — 순수 조회/검색용.

// 이력 테이블이 없는 환경이면 매일 에러를 쌓지 않게 한 번만 알리고 건너뛴다 (10분 뒤 다시 확인).
let missingUntil = 0;

// 예약 점검에서 호출: 같은 커넥션으로 수집 → 저장. 실패해도 점검 자체에는 영향 없음 (항상 null).
async function collectForScheduled(connection: oracledb.Connection, dbmsId: number | string, dbname: string): Promise<null> {
  if (Date.now() < missingUntil) return null;
  try {
    const config = await alertLogModel.getConfig();
    let entries: alertLogModel.AlertLogEntry[];
    try {
      entries = await alertLogModel.collectFromTarget(connection);
    } catch (error) {
      // 대상 DB 쪽 실패(V$DIAG_ALERT_EXT 권한 없음 등)는 그 DB만 건너뛴다 — 메타 테이블 부재로 취급하지 않음.
      logger.warn('AlertLog', `[${dbname}] V$DIAG_ALERT_EXT 조회 실패 — Alert Log 수집 건너뜀 (점검 결과는 정상)`, error);
      return null;
    }
    await alertLogModel.saveSamples(dbmsId, toSamples(entries), config.retentionDays);
    return null;
  } catch (error) {
    if (alertLogModel.isMissingTable(error)) {
      if (missingUntil === 0) logger.warn('AlertLog', 'Alert Log 이력 테이블이 없어 수집을 건너뜁니다 (scripts/add_alert_log_history.sql 실행 필요)');
      missingUntil = Date.now() + 10 * 60 * 1000;
      return null;
    }
    logger.warn('AlertLog', `[${dbname}] Alert Log 수집 실패 (점검 결과는 정상)`, error);
    return null;
  }
}

export interface AlertLogConfigView {
  available: boolean; // 테이블이 없으면 false (설치 필요)
  config: AlertLogConfig;
}

async function getConfig(): Promise<AlertLogConfigView> {
  try {
    return { available: true, config: await alertLogModel.getConfig() };
  } catch (error) {
    if (alertLogModel.isMissingTable(error)) return { available: false, config: alertLogModel.DEFAULT_CONFIG };
    throw new Error('Alert Log 설정 조회 실패', { cause: error });
  }
}

async function saveConfig(config: AlertLogConfig): Promise<void> {
  try {
    await alertLogModel.saveConfig(config);
  } catch (error) {
    throw new Error('Alert Log 설정 저장 실패', { cause: error });
  }
}

async function search(params: AlertLogSearchParams): Promise<{ rows: AlertLogRow[]; total: number }> {
  try {
    return await alertLogModel.search(params);
  } catch (error) {
    throw new Error('Alert Log 검색 실패', { cause: error });
  }
}

async function trend(params: AlertLogSearchParams): Promise<AlertLogTrendPoint[]> {
  try {
    return await alertLogModel.trend(params);
  } catch (error) {
    throw new Error('Alert Log 추이 조회 실패', { cause: error });
  }
}

export { collectForScheduled, getConfig, saveConfig, search, trend };
