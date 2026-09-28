export const STATUS_LABELS: Record<string, string> = { OPEN: '미확인', ACKNOWLEDGED: '확인함', RESOLVED: '해결됨' };

export function formatDate(s: string | null | undefined): string {
  if (!s || s.length < 14) return s || '-';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}
