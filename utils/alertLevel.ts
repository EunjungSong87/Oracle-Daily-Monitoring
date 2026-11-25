// 임계치 알림 레벨(monitoring_thresholds.clevel) 심각도 순위.
// 한 컬럼에 여러 임계치가 동시에 걸리면 가장 심각한 레벨을 남긴다.
const LEVEL_RANK: Record<string, number> = { INFO: 0, WARN: 1, ERROR: 2, CRITICAL: 3 };

export function levelRank(level: string | null | undefined): number {
  return LEVEL_RANK[String(level ?? '').toUpperCase()] ?? -1;
}

// a가 b보다 심각하면 true
export function isMoreSevere(a: string | null | undefined, b: string | null | undefined): boolean {
  return levelRank(a) > levelRank(b);
}
