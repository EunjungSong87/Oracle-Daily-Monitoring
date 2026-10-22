// 매일 지정된 시각에 자동 실행 대상 DB들을 점검하고, 결과를 서버 디스크의
// reports/YYYY-MM-DD/ 밑에 DB별 HTML 파일로 저장합니다.
// 별도 스케줄링 라이브러리 없이, 1분 간격으로 현재 시각과 설정 시각을 비교하는
// 방식으로 동작합니다 (당일 이미 실행했으면 다시 실행하지 않음).

import fs from 'fs/promises';
import path from 'path';
import * as dbmsList from '../models/dbmsModel';
import * as dbmsService from './dbmsService';
import { renderReportHtml } from './reportService';
import { logger } from '../utils/logger';
import { syncRunning as syncDataPumpHistory } from './dataPumpHistoryService';

const REPORTS_DIR = path.join(process.cwd(), 'reports');
const CHECK_INTERVAL_MS = 60 * 1000;

let lastRunDate: string | null = null;
// 예약 점검은 대상 DB가 많거나 느리면 1분을 넘기므로, 진행 중이면 다음 tick은 예약 실행 부분을 건너뜁니다.
let scheduledRunInProgress = false;
// /health용: 마지막 tick 시각, 이 프로세스가 마지막으로 돌린 예약 실행 결과
let lastTickAt: Date | null = null;
let lastResult: { at: Date; ok: number; total: number } | null = null;

export interface SchedulerState {
  lastTickAt: Date | null;
  lastRunDate: string | null; // 'YYYYMMDD' — 이 프로세스가 오늘 예약 실행을 시작했는지
  running: boolean;
  lastResult: { at: Date; ok: number; total: number } | null;
}

function getSchedulerState(): SchedulerState {
  return { lastTickAt, lastRunDate: lastRunDate ? lastRunDate.replace(/-/g, '') : null, running: scheduledRunInProgress, lastResult };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function todayDirName(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

async function runScheduledReports(): Promise<{ dbname: string; ok: boolean }[]> {
  const now = new Date();
  const targets = await dbmsList.getAutoScheduleDbmses();
  const dayDir = path.join(REPORTS_DIR, todayDirName(now));
  await fs.mkdir(dayDir, { recursive: true });

  const outcomes: { dbname: string; ok: boolean }[] = [];
  // DB마다 차례로 돈다. 한 DB가 접속/쿼리 타임아웃 등으로 실패해도 그 DB만 실패로 남기고 다음 DB로 넘어간다
  // (접속은 TARGET_DB_CONNECT_TIMEOUT_SEC, 태스크는 TARGET_DB_CALL_TIMEOUT_MS로 끊긴다).
  for (const row of targets.rows) {
    const dbmsid = row.ID;
    const dbname = row.DBNAME;
    try {
      const results = await dbmsService.getMonResult({ dbmsid }, 'SCHEDULED');
      const html = renderReportHtml(dbname, results as any, now);
      await fs.writeFile(path.join(dayDir, `${dbname}.html`), html, 'utf-8');
      outcomes.push({ dbname, ok: true });
    } catch (err) {
      logger.error('Scheduler', `[${dbname}] 리포트 생성 실패`, err);
      outcomes.push({ dbname, ok: false });
    }
  }
  return outcomes;
}

async function tick(): Promise<void> {
  lastTickAt = new Date();
  // 화면을 아무도 안 보고 있어도 끝난 Data Pump 작업의 이력(결과/수행 시간)을 채운다. 실패는 그 안에서 흡수한다.
  void syncDataPumpHistory(null);
  if (scheduledRunInProgress) return;
  scheduledRunInProgress = true;
  try {
    const config = await dbmsList.getScheduleConfig();
    if (config.enabled !== 'Y' || !config.runTime) return;

    const now = new Date();
    const nowHHMM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const today = todayDirName(now);

    if (nowHHMM === config.runTime && lastRunDate !== today) {
      lastRunDate = today;
      logger.info('Scheduler', `예약 일일점검 시작 (설정 시각 ${config.runTime})`);
      const outcomes = await runScheduledReports();
      const okCount = outcomes.filter((o) => o.ok).length;
      lastResult = { at: now, ok: okCount, total: outcomes.length };
      logger.info('Scheduler', `예약 일일점검 완료: ${okCount}/${outcomes.length} 성공, 저장 위치 ${path.join(REPORTS_DIR, today)}`);
    }
  } catch (err) {
    logger.error('Scheduler', '예약 실행 확인 중 오류', err);
  } finally {
    scheduledRunInProgress = false;
  }
}

function startScheduler(): void {
  setInterval(tick, CHECK_INTERVAL_MS);
  logger.info('Scheduler', '시작됨 (1분 간격으로 예약 시각 확인)');
}

export { startScheduler, runScheduledReports, getSchedulerState, REPORTS_DIR };
