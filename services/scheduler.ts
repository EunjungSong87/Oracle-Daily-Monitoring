// 매일 지정된 시각에 자동 실행 대상 DB들을 점검하고, 결과를 서버 디스크의
// reports/YYYY-MM-DD/ 밑에 DB별 HTML 파일로 저장합니다.
// 별도 스케줄링 라이브러리 없이, 1분 간격으로 현재 시각과 설정 시각을 비교하는
// 방식으로 동작합니다 (당일 이미 실행했으면 다시 실행하지 않음).

import fs from 'fs/promises';
import path from 'path';
import * as dbmsList from '../models/dbmsModel';
import * as dbmsService from './dbmsService';
import { renderReportHtml } from './reportService';

const REPORTS_DIR = path.join(process.cwd(), 'reports');
const CHECK_INTERVAL_MS = 60 * 1000;

let lastRunDate: string | null = null;

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
  for (const row of targets.rows) {
    const dbmsid = row.ID;
    const dbname = row.DBNAME;
    try {
      const results = await dbmsService.getMonResult({ dbmsid });
      const html = renderReportHtml(dbname, results as any, now);
      await fs.writeFile(path.join(dayDir, `${dbname}.html`), html, 'utf-8');
      outcomes.push({ dbname, ok: true });
    } catch (err) {
      console.error(`[Scheduler] 리포트 생성 실패 (${dbname}):`, err);
      outcomes.push({ dbname, ok: false });
    }
  }
  return outcomes;
}

async function tick(): Promise<void> {
  try {
    const config = await dbmsList.getScheduleConfig();
    if (config.enabled !== 'Y' || !config.runTime) return;

    const now = new Date();
    const nowHHMM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const today = todayDirName(now);

    if (nowHHMM === config.runTime && lastRunDate !== today) {
      lastRunDate = today;
      console.log(`[Scheduler] 예약된 일일점검 실행 시작 (${config.runTime})`);
      const outcomes = await runScheduledReports();
      const okCount = outcomes.filter((o) => o.ok).length;
      console.log(`[Scheduler] 완료: ${okCount}/${outcomes.length} 성공, 저장 위치: ${path.join(REPORTS_DIR, today)}`);
    }
  } catch (err) {
    console.error('[Scheduler] 오류:', err);
  }
}

function startScheduler(): void {
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log('[Scheduler] 시작됨 (1분 간격으로 예약 시각 확인)');
}

export { startScheduler, runScheduledReports, REPORTS_DIR };
