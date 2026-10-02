// Data Pump 화면 공용 헬퍼: 크기/시간 표시, 파일 저장.

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// 오늘 날짜 기반 기본 파일 접두어 (예: exp_20261002)
export function todayPrefix(kind: 'exp' | 'imp'): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${kind}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 초 → "1시간 5분", "12분 30초", "40초"
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '-';
  const s = Math.round(seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${s % 60}초`;
  return `${s}초`;
}

// 지난 작업들의 평균 처리 속도로 어림한 수행 시간(초). 속도 이력이 없으면 null.
export function estimateSeconds(bytes: number, bytesPerSec: number | null): number | null {
  if (!bytesPerSec || bytesPerSec <= 0 || bytes <= 0) return null;
  return bytes / bytesPerSec;
}
