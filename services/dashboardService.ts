import * as dashboardModel from '../models/dashboardModel';
import type { DashboardRaw } from '../models/dashboardModel';

// 첫 화면(전체 DB 현황). 메타데이터 DB의 점검 이력/이슈/Data Pump 이력만 읽는다 — 대상 DB에는 접속하지 않는다.

export type Signal = 'RED' | 'YELLOW' | 'GREEN' | 'GRAY';

export interface DbCard {
  dbmsId: number;
  dbname: string;
  memo: string | null;
  autoSchedule: boolean;
  signal: Signal;
  signalReason: string;
  lastRun: { id: number; at: string; trigger: string; errors: number; warns: number; failedTasks: number } | null;
  issues: { ERROR: number; WARN: number; other: number; acknowledged: number };
  dataPump: { running: { jobName: string; operation: string; startedAt: string | null }[]; latest: { jobName: string; operation: string; status: string; finishedAt: string | null } | null };
  lastScheduled: { at: string; ok: boolean } | null;
}

export interface Dashboard {
  generatedAt: string;
  cards: DbCard[];
  summary: { total: number; problem: number; scheduledToday: { ok: number; expected: number; runTime: string | null; enabled: boolean }; openIssues: number };
  dataPumpAvailable: boolean;
}

const STALE_MS = 24 * 60 * 60 * 1000;

// 'YYYYMMDDHH24MISS' → Date (서버 시각 기준)
function parseRunAt(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}

function formatRunAt(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(value ?? '');
}

// 점검 결과 JSON의 위반(_alerts level)과 실패한 태스크 수
function summarizeResults(json: string | null): { errors: number; warns: number; failedTasks: number } {
  let tasks: { success?: boolean; rows?: { _alerts?: Record<string, { level?: string }> }[] }[];
  try {
    tasks = json ? JSON.parse(json) : [];
  } catch {
    tasks = [];
  }
  let errors = 0;
  let warns = 0;
  let failedTasks = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task.success === false) failedTasks++;
    for (const row of task.rows ?? []) {
      for (const alert of Object.values(row._alerts ?? {})) {
        if (alert.level === 'ERROR') errors++;
        else if (alert.level === 'WARN') warns++;
      }
    }
  }
  return { errors, warns, failedTasks };
}

// 신호등: 최근 점검이 24시간 넘게 없으면 회색, ERROR 위반이면 빨강, WARN 위반이나 실패한 태스크가 있으면 노랑, 아니면 초록
function signalOf(lastRunAt: Date | null, summary: { errors: number; warns: number; failedTasks: number } | null, now: Date): { signal: Signal; reason: string } {
  if (!lastRunAt || !summary) return { signal: 'GRAY', reason: '점검 기록 없음' };
  if (now.getTime() - lastRunAt.getTime() > STALE_MS) return { signal: 'GRAY', reason: '24시간 넘게 점검 없음' };
  if (summary.errors > 0) return { signal: 'RED', reason: `ERROR 위반 ${summary.errors}건` };
  if (summary.warns > 0 || summary.failedTasks > 0) {
    return { signal: 'YELLOW', reason: [summary.warns > 0 ? `WARN 위반 ${summary.warns}건` : '', summary.failedTasks > 0 ? `실패한 점검 ${summary.failedTasks}개` : ''].filter(Boolean).join(', ') };
  }
  return { signal: 'GREEN', reason: '위반 없음' };
}

function buildDashboard(raw: DashboardRaw, now: Date = new Date()): Dashboard {
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const cards = raw.dbmses.map((dbms): DbCard => {
    const id = Number(dbms.ID);
    const run = raw.latestRuns.find((row) => Number(row.DBMS_ID) === id) ?? null;
    const summary = run ? summarizeResults(run.RESULTS) : null;
    const { signal, reason } = signalOf(run ? parseRunAt(run.RUN_AT) : null, summary, now);
    const issueRows = raw.issues.filter((row) => Number(row.DBMS_ID) === id);
    const count = (pick: (row: Record<string, any>) => boolean) => issueRows.filter(pick).reduce((sum, row) => sum + Number(row.N), 0);
    const jobs = (raw.dataPump ?? []).filter((row) => Number(row.DBMS_ID) === id);
    const latestJob = jobs.filter((row) => row.STATUS !== 'RUNNING').sort((a, b) => String(b.STARTED_AT).localeCompare(String(a.STARTED_AT)))[0];
    const scheduled = raw.latestScheduled.find((row) => Number(row.DBMS_ID) === id);
    return {
      dbmsId: id,
      dbname: dbms.DBNAME,
      memo: dbms.MEMO ?? null,
      autoSchedule: dbms.AUTO_SCHEDULE === 'Y',
      signal,
      signalReason: reason,
      lastRun: run && summary ? { id: Number(run.ID), at: formatRunAt(run.RUN_AT), trigger: run.TRIGGER_TYPE, ...summary } : null,
      issues: {
        ERROR: count((row) => row.STATUS === 'OPEN' && row.CLEVEL === 'ERROR'),
        WARN: count((row) => row.STATUS === 'OPEN' && row.CLEVEL === 'WARN'),
        other: count((row) => row.STATUS === 'OPEN' && row.CLEVEL !== 'ERROR' && row.CLEVEL !== 'WARN'),
        acknowledged: count((row) => row.STATUS === 'ACKNOWLEDGED'),
      },
      dataPump: {
        running: jobs.filter((row) => row.STATUS === 'RUNNING').map((row) => ({ jobName: row.JOB_NAME, operation: row.OPERATION, startedAt: row.STARTED_AT ?? null })),
        latest: latestJob ? { jobName: latestJob.JOB_NAME, operation: latestJob.OPERATION, status: latestJob.STATUS, finishedAt: latestJob.FINISHED_AT ?? null } : null,
      },
      lastScheduled: scheduled ? { at: formatRunAt(scheduled.RUN_AT), ok: Number(scheduled.FAIL_COUNT) === 0 } : null,
    };
  });
  const order: Record<Signal, number> = { RED: 0, YELLOW: 1, GRAY: 2, GREEN: 3 };
  cards.sort((a, b) => order[a.signal] - order[b.signal] || a.dbname.localeCompare(b.dbname));
  const expected = cards.filter((card) => card.autoSchedule);
  return {
    generatedAt: now.toISOString(),
    cards,
    summary: {
      total: cards.length,
      problem: cards.filter((card) => card.signal === 'RED' || card.signal === 'YELLOW').length,
      scheduledToday: {
        ok: expected.filter((card) => {
          const row = raw.latestScheduled.find((item) => Number(item.DBMS_ID) === card.dbmsId);
          return row && String(row.RUN_AT).startsWith(today) && Number(row.FAIL_COUNT) === 0;
        }).length,
        expected: expected.length,
        runTime: raw.schedule?.RUN_TIME ?? null,
        enabled: raw.schedule?.ENABLED === 'Y',
      },
      openIssues: cards.reduce((sum, card) => sum + card.issues.ERROR + card.issues.WARN + card.issues.other, 0),
    },
    dataPumpAvailable: raw.dataPump !== null,
  };
}

async function getDashboard(): Promise<Dashboard> {
  try {
    return buildDashboard(await dashboardModel.loadDashboard());
  } catch (error) {
    throw new Error('대시보드 조회 실패', { cause: error });
  }
}

export { summarizeResults, signalOf, buildDashboard, getDashboard };
