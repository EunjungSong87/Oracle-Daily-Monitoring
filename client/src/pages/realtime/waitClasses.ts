// public/realtimeMonitoring.html의 WAIT_CLASS_ORDER/WAIT_CLASS_COLORS/colorFor 포팅.
// MaxGauge 계열 도구의 관례적인 wait class 색상 배치를 따른다.
export const WAIT_CLASS_ORDER = [
  'CPU',
  'User I/O',
  'System I/O',
  'Concurrency',
  'Application',
  'Commit',
  'Network',
  'Configuration',
  'Administrative',
  'Scheduler',
  'Other',
] as const;

const WAIT_CLASS_COLORS: Record<string, string> = {
  CPU: '#22c55e',
  'User I/O': '#f59e0b',
  'System I/O': '#a855f7',
  Concurrency: '#ef4444',
  Application: '#3b82f6',
  Commit: '#ec4899',
  Network: '#06b6d4',
  Configuration: '#64748b',
  Administrative: '#78716c',
  Scheduler: '#eab308',
  Other: '#9ca3af',
  IDLE: '#d1d5db',
};

export function colorFor(cls: string): string {
  return WAIT_CLASS_COLORS[cls] || WAIT_CLASS_COLORS.Other;
}
