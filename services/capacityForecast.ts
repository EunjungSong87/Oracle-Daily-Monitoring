// 용량 소진 예측 (DB 접근 없는 순수 함수). 최근 30일 사용량의 선형회귀로 임계치(기본 100%) 도달 예상일을 낸다.

export interface CapacityPoint {
  day: string; // 'YYYY-MM-DD'
  used: number;
  max: number;
}

export type ForecastStatus = 'OK' | 'REACHED' | 'NO_GROWTH' | 'INSUFFICIENT';

export interface Forecast {
  status: ForecastStatus;
  usedPct: number | null; // 마지막 수집 기준
  date: string | null; // 임계치 도달 예상일 (OK / REACHED)
  daysLeft: number | null;
  slopePerDay: number | null; // 하루 증가량 (바이트)
  samples: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_SAMPLES = 7;
export const WINDOW_DAYS = 30;

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function dayString(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function forecast(points: CapacityPoint[], thresholdPct: number, today: string): Forecast {
  const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
  const last = sorted[sorted.length - 1];
  const usedPct = last && last.max > 0 ? Math.round((last.used / last.max) * 1000) / 10 : null;
  const todayN = dayNumber(today);
  const recent = sorted.filter((point) => todayN - dayNumber(point.day) < WINDOW_DAYS);
  const base = { usedPct, samples: recent.length };
  if (!last || last.max <= 0) return { ...base, status: 'INSUFFICIENT', date: null, daysLeft: null, slopePerDay: null };
  const target = (last.max * thresholdPct) / 100;
  if (last.used >= target) return { ...base, status: 'REACHED', date: last.day, daysLeft: 0, slopePerDay: null };
  if (recent.length < MIN_SAMPLES) return { ...base, status: 'INSUFFICIENT', date: null, daysLeft: null, slopePerDay: null };

  // 최소제곱 직선 used = a + b·x (x = 날짜 일수)
  const xs = recent.map((point) => dayNumber(point.day));
  const ys = recent.map((point) => point.used);
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = sxx === 0 ? 0 : xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
  if (!(slope > 0)) return { ...base, status: 'NO_GROWTH', date: null, daysLeft: null, slopePerDay: slope };
  const intercept = my - slope * mx;
  const reachN = Math.ceil((target - intercept) / slope);
  const daysLeft = Math.max(0, reachN - todayN);
  return { ...base, status: 'OK', date: dayString(todayN + daysLeft), daysLeft, slopePerDay: slope };
}

export { forecast };
