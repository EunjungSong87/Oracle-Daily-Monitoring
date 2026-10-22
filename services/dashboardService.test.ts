import { describe, expect, it } from 'vitest';
import { buildDashboard, signalOf, summarizeResults } from './dashboardService';

const NOW = new Date(2026, 9, 22, 12, 0, 0);
const results = (levels: string[], failed = 0) =>
  JSON.stringify([
    { success: true, rows: levels.map((level) => ({ _alerts: { USED: { level } } })) },
    ...Array.from({ length: failed }, () => ({ success: false, rows: [] })),
  ]);

describe('summarizeResults / signalOf', () => {
  it('ERROR → 빨강, WARN·실패 → 노랑, 없으면 초록', () => {
    const recent = new Date(2026, 9, 22, 7, 0, 0);
    expect(signalOf(recent, summarizeResults(results(['ERROR', 'WARN'])), NOW).signal).toBe('RED');
    expect(signalOf(recent, summarizeResults(results(['WARN'])), NOW).signal).toBe('YELLOW');
    expect(signalOf(recent, summarizeResults(results([], 1)), NOW).signal).toBe('YELLOW');
    expect(signalOf(recent, summarizeResults(results(['INFO'])), NOW).signal).toBe('GREEN');
  });

  it('24시간 넘게 점검이 없거나 기록이 없으면 회색', () => {
    expect(signalOf(new Date(2026, 9, 21, 11, 0, 0), summarizeResults(results(['ERROR'])), NOW).signal).toBe('GRAY');
    expect(signalOf(null, null, NOW).signal).toBe('GRAY');
  });

  it('깨진 JSON은 위반 0', () => {
    expect(summarizeResults('{oops')).toEqual({ errors: 0, warns: 0, failedTasks: 0 });
  });
});

describe('buildDashboard', () => {
  const raw = {
    dbmses: [
      { ID: 1, DBNAME: 'A', MEMO: null, AUTO_SCHEDULE: 'Y' },
      { ID: 2, DBNAME: 'B', MEMO: 'x', AUTO_SCHEDULE: 'Y' },
      { ID: 3, DBNAME: 'C', MEMO: null, AUTO_SCHEDULE: 'N' },
    ],
    latestRuns: [
      { ID: 10, DBMS_ID: 1, RUN_AT: '20261022070000', TRIGGER_TYPE: 'SCHEDULED', RESULTS: results(['ERROR']) },
      { ID: 11, DBMS_ID: 2, RUN_AT: '20261022070100', TRIGGER_TYPE: 'SCHEDULED', RESULTS: results([]) },
    ],
    latestScheduled: [
      { DBMS_ID: 1, RUN_AT: '20261022070000', FAIL_COUNT: 0 },
      { DBMS_ID: 2, RUN_AT: '20261021070100', FAIL_COUNT: 0 },
    ],
    issues: [
      { DBMS_ID: 1, CLEVEL: 'ERROR', STATUS: 'OPEN', N: 2 },
      { DBMS_ID: 1, CLEVEL: 'WARN', STATUS: 'ACKNOWLEDGED', N: 1 },
    ],
    dataPump: [{ DBMS_ID: 2, JOB_NAME: 'J1', OPERATION: 'EXPORT', STATUS: 'RUNNING', STARTED_AT: '2026-10-22 11:00:00', FINISHED_AT: null }],
    schedule: { ENABLED: 'Y', RUN_TIME: '07:00' },
  };

  it('카드·요약: 문제 DB, 오늘 예약 성공 n/m, OPEN 이슈 총계 (ACK 제외)', () => {
    const dash = buildDashboard(raw, NOW);
    expect(dash.cards.map((card) => [card.dbname, card.signal])).toEqual([
      ['A', 'RED'],
      ['C', 'GRAY'],
      ['B', 'GREEN'],
    ]);
    expect(dash.summary).toMatchObject({ total: 3, problem: 1, openIssues: 2, scheduledToday: { ok: 1, expected: 2, runTime: '07:00', enabled: true } });
    expect(dash.cards[0].issues).toEqual({ ERROR: 2, WARN: 0, other: 0, acknowledged: 1 });
    expect(dash.cards.find((card) => card.dbname === 'B')?.dataPump.running).toEqual([{ jobName: 'J1', operation: 'EXPORT', startedAt: '2026-10-22 11:00:00' }]);
  });

  it('Data Pump 이력 테이블이 없으면 표시만 생략', () => {
    expect(buildDashboard({ ...raw, dataPump: null }, NOW).dataPumpAvailable).toBe(false);
  });
});
