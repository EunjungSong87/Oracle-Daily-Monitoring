import type oracledb from 'oracledb';
import * as capacityModel from '../models/capacityModel';
import type { CapacityConfig, HistoryPoint } from '../models/capacityModel';
import { forecast, WINDOW_DAYS } from './capacityForecast';
import type { Forecast } from './capacityForecast';
import { logger } from '../utils/logger';

// Monitoring > Capacity: 테이블스페이스 / ASM 사용량 일별 이력과 소진 예상일.
// 수집은 예약 일일점검이 같은 대상 DB 커넥션으로 하루 한 번 (dbmsService.getMonResult), 화면은 메타데이터 DB만 읽는다.

// 점검 결과에 "용량 소진 예측" 가상 태스크로 붙여, 실행 이력·리포트·이슈 티켓 흐름을 그대로 쓴다.
export const CAPACITY_TASK_ID = -100;
export const CAPACITY_TASK_NAME = '용량 소진 예측';

export interface CapacityItem extends Forecast {
  kind: 'TABLESPACE' | 'ASM';
  name: string;
  used: number;
  max: number;
  lastDay: string;
}

function itemKey(kind: string, name: string): string {
  return `${kind === 'ASM' ? 'ASM' : 'TS'}:${name}`;
}

// 임박한 순: 이미 도달 → 남은 일수 적은 순 → 증가 없음 → 데이터 부족
function sortItems(items: CapacityItem[]): CapacityItem[] {
  const rank = (item: CapacityItem) => (item.status === 'REACHED' ? 0 : item.status === 'OK' ? 1 : item.status === 'NO_GROWTH' ? 2 : 3);
  return [...items].sort((a, b) => rank(a) - rank(b) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || (b.usedPct ?? 0) - (a.usedPct ?? 0) || a.name.localeCompare(b.name));
}

function buildItems(history: HistoryPoint[], config: CapacityConfig, today: string): CapacityItem[] {
  const byItem = new Map<string, HistoryPoint[]>();
  for (const point of history) byItem.set(`${point.kind}\u0001${point.name}`, [...(byItem.get(`${point.kind}\u0001${point.name}`) ?? []), point]);
  return sortItems(
    [...byItem.values()].map((points) => {
      const last = points[points.length - 1];
      return {
        kind: last.kind as CapacityItem['kind'],
        name: last.name,
        used: last.used,
        max: last.max,
        lastDay: last.day,
        ...forecast(points, config.thresholdPct, today),
      };
    })
  );
}

// 가상 태스크: 예상일이 alertDays 안이면(또는 이미 도달) 그 항목 칸에 _alerts → 기존 이슈 동기화가 항목마다 티켓을 만든다.
function buildCapacityTask(items: CapacityItem[], config: CapacityConfig): Record<string, any> {
  const label = (item: CapacityItem) =>
    item.status === 'OK' ? `${item.date} (${item.daysLeft}일 남음)` : item.status === 'REACHED' ? '이미 도달' : item.status === 'NO_GROWTH' ? '증가 없음' : '데이터 부족(7일 미만)';
  return {
    task_id: CAPACITY_TASK_ID,
    task_name: CAPACITY_TASK_NAME,
    columns: ['KIND', 'NAME', 'USED_PCT', 'ESTIMATE'],
    success: true,
    rows: items.map((item) => {
      const imminent = item.status === 'REACHED' || (item.status === 'OK' && (item.daysLeft ?? Infinity) <= config.alertDays);
      const key = itemKey(item.kind, item.name);
      const row: Record<string, any> = { KIND: item.kind, NAME: item.name, USED_PCT: item.usedPct, ESTIMATE: label(item), [key]: label(item) };
      if (imminent) {
        const level = item.status === 'REACHED' || (item.daysLeft ?? 0) <= 7 ? 'ERROR' : 'WARN';
        row._alerts = { [key]: { level, message: `${item.kind === 'ASM' ? 'ASM 디스크그룹' : '테이블스페이스'} ${item.name} ${config.thresholdPct}% 도달 예상: ${label(item)}` } };
      }
      return row;
    }),
  };
}

function todayString(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 이력 테이블이 없는 환경이면 매일 에러를 쌓지 않게 한 번만 알리고 건너뛴다 (10분 뒤 다시 확인).
let missingUntil = 0;

function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && /ORA-00942/.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

// 예약 점검에서 호출: 같은 커넥션으로 수집 → 저장 → 예측 태스크. 실패해도 점검 자체에는 영향 없음 (null).
async function collectForScheduled(connection: oracledb.Connection, dbmsId: number | string, dbname: string): Promise<Record<string, any> | null> {
  if (Date.now() < missingUntil) return null;
  try {
    const config = await capacityModel.getConfig();
    const { samples, skipped } = await capacityModel.collectFromTarget(connection);
    if (skipped.length > 0) logger.info('Capacity', `[${dbname}] 일부 항목 건너뜀 — ${skipped.join(' / ')}`);
    await capacityModel.saveSamples(dbmsId, samples, config.retentionDays);
    const history = await capacityModel.loadHistory(dbmsId, WINDOW_DAYS);
    return buildCapacityTask(buildItems(history, config, todayString()), config);
  } catch (error) {
    if (isMissingTable(error)) {
      if (missingUntil === 0) logger.warn('Capacity', '용량 이력 테이블이 없어 수집을 건너뜁니다 (scripts/add_capacity_history.sql 실행 필요)');
      missingUntil = Date.now() + 10 * 60 * 1000;
      return null;
    }
    logger.warn('Capacity', `[${dbname}] 용량 수집 실패 (점검 결과는 정상)`, error);
    return null;
  }
}

export interface CapacityView {
  available: boolean; // 테이블이 없으면 false (설치 필요)
  config: CapacityConfig;
  items: CapacityItem[];
}

async function getCapacity(dbmsId: number | string): Promise<CapacityView> {
  try {
    const config = await capacityModel.getConfig();
    const history = await capacityModel.loadHistory(dbmsId, WINDOW_DAYS);
    return { available: true, config, items: buildItems(history, config, todayString()) };
  } catch (error) {
    if (isMissingTable(error)) return { available: false, config: capacityModel.DEFAULT_CONFIG, items: [] };
    throw new Error('용량 현황 조회 실패', { cause: error });
  }
}

async function getTrend(dbmsId: number | string, kind: string, name: string, days: number): Promise<HistoryPoint[]> {
  try {
    return await capacityModel.loadHistory(dbmsId, days, { kind, name });
  } catch (error) {
    throw new Error('용량 추이 조회 실패', { cause: error });
  }
}

async function saveConfig(config: CapacityConfig): Promise<void> {
  try {
    await capacityModel.saveConfig(config);
  } catch (error) {
    throw new Error('용량 설정 저장 실패', { cause: error });
  }
}

export { buildItems, buildCapacityTask, collectForScheduled, getCapacity, getTrend, saveConfig };
