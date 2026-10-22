import fs from 'fs';
import path from 'path';
import * as healthModel from '../models/healthModel';
import type { ScheduleSummary } from '../models/healthModel';
import { getSchedulerState, type SchedulerState } from './scheduler';

// GET /health — 로그인 없이 외부 감시가 부르는 앱 자체 상태. 대상 DB에는 접속하지 않고, 메타 DB만 가볍게 본다.
// DB 목록·계정·접속 정보·에러 원문은 내보내지 않는다.

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthReport {
  status: HealthStatus;
  metaDb: 'ok' | 'fail';
  scheduler: {
    lastTickAt: string | null;
    lastScheduledRun: { at: string; ok: number; total: number } | null;
    todayMissed: boolean;
  };
  uptimeSec: number;
  version?: string;
}

const TICK_STALE_MS = 3 * 60 * 1000;
// 예약 시각이 지나고 이만큼 지나도 오늘 예약 실행 흔적이 없으면 누락으로 본다 (실행이 막 시작돼 첫 DB를 도는 중일 수 있음)
const MISSED_GRACE_MS = 10 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

// 'YYYYMMDDHH24MISS' → 'YYYY-MM-DD HH:MM:SS'
function formatRunAt(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : value;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// 판정: 메타 DB 실패 = down, tick이 3분 넘게 없음(기동 직후 3분은 봐줌) 또는 오늘 예약 실행 누락 = degraded
function evaluate(input: {
  now: Date;
  startedAt: Date;
  metaDbOk: boolean;
  scheduler: SchedulerState;
  schedule: ScheduleSummary | null; // 메타 DB 실패면 null
}): Omit<HealthReport, 'uptimeSec' | 'version'> {
  const { now, startedAt, metaDbOk, scheduler, schedule } = input;
  const tickBase = scheduler.lastTickAt ?? startedAt;
  const tickStale = now.getTime() - tickBase.getTime() >= TICK_STALE_MS;

  const today = dayKey(now);
  let todayMissed = false;
  if (schedule && schedule.enabled && schedule.runTime && schedule.expected > 0) {
    const [h, m] = schedule.runTime.split(':').map(Number);
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const ranToday = scheduler.lastRunDate === today || (schedule.lastRunAt?.startsWith(today) ?? false);
    todayMissed = now.getTime() - due.getTime() >= MISSED_GRACE_MS && !ranToday && !scheduler.running;
  }

  // 마지막 예약 실행 결과: 이 프로세스가 직접 돌린 결과가 있으면 그것(접속 실패 DB까지 정확), 없으면(재시작 후) 메타 DB 이력
  const lastScheduledRun = scheduler.lastResult
    ? { at: formatDate(scheduler.lastResult.at), ok: scheduler.lastResult.ok, total: scheduler.lastResult.total }
    : schedule?.lastRunAt
      ? { at: formatRunAt(schedule.lastRunAt), ok: schedule.lastRunOk, total: Math.max(schedule.expected, schedule.lastRunTotal) }
      : null;

  const status: HealthStatus = !metaDbOk ? 'down' : tickStale || todayMissed ? 'degraded' : 'ok';
  return {
    status,
    metaDb: metaDbOk ? 'ok' : 'fail',
    scheduler: { lastTickAt: scheduler.lastTickAt ? formatDate(scheduler.lastTickAt) : null, lastScheduledRun, todayMissed },
  };
}

// 앱 버전: 기동 시 한 번 .git에서 커밋 해시를 읽는다 (git 실행 파일 없이). 못 읽으면 생략.
function readGitCommit(root: string = process.cwd()): string | undefined {
  try {
    const gitDir = path.join(root, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 12);
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    if (!ref) return undefined;
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim().slice(0, 12);
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.trim().endsWith(` ${ref}`));
    return line ? line.slice(0, 12) : undefined;
  } catch {
    return undefined;
  }
}

const STARTED_AT = new Date();
const VERSION = readGitCommit();

async function getHealth(): Promise<HealthReport> {
  const result = await healthModel.check();
  const report = evaluate({ now: new Date(), startedAt: STARTED_AT, metaDbOk: result.ok, scheduler: getSchedulerState(), schedule: result.schedule });
  return { ...report, uptimeSec: Math.round(process.uptime()), ...(VERSION ? { version: VERSION } : {}) };
}

export { evaluate, readGitCommit, getHealth };
