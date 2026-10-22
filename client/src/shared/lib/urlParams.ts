// 다른 화면(대시보드 등)에서 넘겨준 조건: ?dbms=<DBMS ID>&run=<점검 이력 ID>
export function urlParam(name: string): string | null {
  const value = new URLSearchParams(window.location.search).get(name);
  return value && /^\d+$/.test(value) ? value : null;
}
