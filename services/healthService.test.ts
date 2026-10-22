import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { evaluate, readGitCommit } from './healthService';
import type { SchedulerState } from './scheduler';

const now = new Date(2026, 9, 22, 9, 0, 0);
const startedAt = new Date(2026, 9, 22, 8, 0, 0);
const ticking: SchedulerState = { lastTickAt: new Date(2026, 9, 22, 8, 59, 30), lastRunDate: null, running: false, lastResult: null };
const schedule = { enabled: true, runTime: '07:00', expected: 3, lastRunAt: '20261022070512', lastRunOk: 2, lastRunTotal: 3 };

describe('evaluate', () => {
  it('정상: 메타 DB ok, tick 최근, 오늘 예약 실행 있음', () => {
    const r = evaluate({ now, startedAt, metaDbOk: true, scheduler: ticking, schedule });
    expect(r.status).toBe('ok');
    expect(r.scheduler.lastScheduledRun).toEqual({ at: '2026-10-22 07:05:12', ok: 2, total: 3 });
  });

  it('메타 DB 실패면 down', () => {
    expect(evaluate({ now, startedAt, metaDbOk: false, scheduler: ticking, schedule: null }).status).toBe('down');
  });

  it('tick이 3분 넘게 없으면 degraded, 기동 직후 3분은 봐줌', () => {
    const stale = { ...ticking, lastTickAt: new Date(2026, 9, 22, 8, 56, 59) };
    expect(evaluate({ now, startedAt, metaDbOk: true, scheduler: stale, schedule }).status).toBe('degraded');
    const fresh = { ...ticking, lastTickAt: null };
    expect(evaluate({ now, startedAt: new Date(2026, 9, 22, 8, 58), metaDbOk: true, scheduler: fresh, schedule }).status).toBe('ok');
    expect(evaluate({ now, startedAt, metaDbOk: true, scheduler: fresh, schedule }).status).toBe('degraded');
  });

  it('예약 시각 + 10분이 지나도 오늘 실행이 없으면 누락 (degraded)', () => {
    const yesterday = { ...schedule, lastRunAt: '20261021070000' };
    const r = evaluate({ now, startedAt, metaDbOk: true, scheduler: ticking, schedule: yesterday });
    expect(r).toMatchObject({ status: 'degraded', scheduler: { todayMissed: true } });
    // 아직 예약 시각 전, 실행 중, 이 프로세스가 오늘 시작함, 예약 꺼짐 → 누락 아님
    expect(evaluate({ now, startedAt, metaDbOk: true, scheduler: ticking, schedule: { ...yesterday, runTime: '08:55' } }).status).toBe('ok');
    expect(evaluate({ now, startedAt, metaDbOk: true, scheduler: { ...ticking, running: true }, schedule: yesterday }).status).toBe('ok');
    expect(evaluate({ now, startedAt, metaDbOk: true, scheduler: { ...ticking, lastRunDate: '20261022' }, schedule: yesterday }).status).toBe('ok');
    expect(evaluate({ now, startedAt, metaDbOk: true, scheduler: ticking, schedule: { ...yesterday, enabled: false } }).status).toBe('ok');
  });

  it('이 프로세스가 돌린 결과가 있으면 그것을 쓴다', () => {
    const r = evaluate({ now, startedAt, metaDbOk: true, scheduler: { ...ticking, lastResult: { at: new Date(2026, 9, 22, 7, 0, 1), ok: 1, total: 3 } }, schedule });
    expect(r.scheduler.lastScheduledRun).toEqual({ at: '2026-10-22 07:00:01', ok: 1, total: 3 });
  });
});

describe('readGitCommit', () => {
  it('ref / packed-refs / 없음', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
    expect(readGitCommit(root)).toBeUndefined();
    fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, '.git', 'packed-refs'), `# pack\n${'b'.repeat(40)} refs/heads/main\n`);
    expect(readGitCommit(root)).toBe('b'.repeat(12));
    fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);
    expect(readGitCommit(root)).toBe('a'.repeat(12));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
