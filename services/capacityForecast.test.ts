import { describe, expect, it } from 'vitest';
import { forecast } from './capacityForecast';
import type { CapacityPoint } from './capacityForecast';

const G = 1024 ** 3;
// 2026-10-01부터 days일 동안 하루 perDay씩 늘어난 기록
const series = (days: number, start: number, perDay: number, max = 100 * G): CapacityPoint[] =>
  Array.from({ length: days }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, used: start + perDay * i, max }));

describe('forecast — 최근 30일 선형회귀', () => {
  it('하루 1G씩 늘면 남은 공간 / 1G 뒤가 예상일', () => {
    // 10-20에 69G, 하루 1G → 100G는 31일 뒤 (11-20)
    const result = forecast(series(20, 50 * G, G), 100, '2026-10-20');
    expect(result).toMatchObject({ status: 'OK', daysLeft: 31, date: '2026-11-20', samples: 20, usedPct: 69 });
  });

  it('임계치 %를 바꾸면 그 지점까지', () => {
    expect(forecast(series(20, 50 * G, G), 80, '2026-10-20')).toMatchObject({ status: 'OK', daysLeft: 11 });
  });

  it('데이터가 7일 미만이면 예측하지 않음', () => {
    expect(forecast(series(6, 50 * G, G), 100, '2026-10-06').status).toBe('INSUFFICIENT');
  });

  it('늘지 않거나 줄면 "증가 없음"', () => {
    expect(forecast(series(10, 50 * G, 0), 100, '2026-10-10').status).toBe('NO_GROWTH');
    expect(forecast(series(10, 50 * G, -G), 100, '2026-10-10').status).toBe('NO_GROWTH');
  });

  it('이미 임계치를 넘었으면 REACHED', () => {
    expect(forecast(series(3, 90 * G, G), 90, '2026-10-03')).toMatchObject({ status: 'REACHED', daysLeft: 0 });
  });

  it('30일보다 오래된 기록은 회귀에 안 씀', () => {
    const old = series(10, 10 * G, 5 * G).map((p) => ({ ...p, day: p.day.replace('2026-10', '2026-08') }));
    const result = forecast([...old, ...series(10, 50 * G, 0)], 100, '2026-10-10');
    expect(result).toMatchObject({ status: 'NO_GROWTH', samples: 10 });
  });
});

describe('buildItems / buildCapacityTask', () => {
  it('임박한 순으로 정렬하고, alertDays 안이면 그 항목 칸에 경고 (이슈 티켓 키 = 항목)', async () => {
    const { buildItems, buildCapacityTask, CAPACITY_TASK_ID } = await import('./capacityService');
    const config = { retentionDays: 730, alertDays: 30, thresholdPct: 100 };
    const hist = (kind: string, name: string, start: number, perDay: number) =>
      series(20, start, perDay).map((p) => ({ kind, name, day: p.day, used: p.used, max: p.max }));
    const items = buildItems([...hist('TABLESPACE', 'SLOW', 10 * G, G / 10), ...hist('TABLESPACE', 'USERS', 70 * G, G), ...hist('ASM', 'DATA', 50 * G, 0)], config, '2026-10-20');
    expect(items.map((i) => [i.name, i.status, i.daysLeft])).toEqual([
      ['USERS', 'OK', 11],
      ['SLOW', 'OK', 881],
      ['DATA', 'NO_GROWTH', null],
    ]);
    const task = buildCapacityTask(items, config);
    expect(task.task_id).toBe(CAPACITY_TASK_ID);
    expect(task.rows[0]._alerts).toEqual({ 'TS:USERS': { level: 'WARN', message: expect.stringContaining('USERS 100% 도달 예상: 2026-10-31 (11일 남음)') } });
    expect(task.rows[1]._alerts).toBeUndefined();
  });
});
