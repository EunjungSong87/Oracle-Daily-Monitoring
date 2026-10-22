// 대상 DB(모니터링 대상) 접속/쿼리 타임아웃 설정과 타임아웃 에러 판별.
// oracledb를 불러오지 않는 순수 모듈이라 단위 테스트에서 Instant Client 없이 쓸 수 있습니다.
// 메타데이터 DB 풀(db.ts initializeDB)에는 적용하지 않습니다.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Thick 모드 + Instant Client 19에서는 getConnection의 connectTimeout/transportConnectTimeout(Thin 전용)이
// 먹지 않아 Easy Connect Plus 파라미터로 겁니다. 0이면 붙이지 않습니다(무제한).
const CONNECT_TIMEOUT_SEC = envInt('TARGET_DB_CONNECT_TIMEOUT_SEC', 10);
// TCP 연결 단계 타임아웃. 전체 접속 타임아웃보다 길 이유가 없어 그 안으로 맞춥니다.
const TRANSPORT_CONNECT_TIMEOUT_SEC = Math.min(5, CONNECT_TIMEOUT_SEC);

// 용도별 쿼리 타임아웃(connection.callTimeout, ms). 0 = 무제한.
// Thick 모드(Instant Client 19)에서는 실제로 설정값의 약 2배가 지나야 끊기므로 원하는 최대 대기의 절반으로 잡습니다.
// Data Pump / Object·Parameter Compare / Table Spec / Stats Job / ILM은 오래 걸리는 정상 작업이 있어
// 기본은 무제한이고, 바꾸려면 각 model의 connectTarget 호출부에서 callTimeoutMs를 명시합니다.
const CALL_TIMEOUT_MS = {
  monitoring: envInt('TARGET_DB_CALL_TIMEOUT_MS', 30000), // 일일점검 태스크 (getMonResult) — 실제 약 60초
  realtime: envInt('TARGET_DB_REALTIME_CALL_TIMEOUT_MS', 7000), // Real-Time 폴링/세션 상세 — 실제 약 15초
  connectionTest: envInt('TARGET_DB_TEST_CALL_TIMEOUT_MS', 5000), // 접속 테스트 버튼 — 실제 약 10초
};

// connectString 뒤에 Easy Connect Plus 타임아웃 파라미터를 붙입니다 (이미 ?가 있으면 &로 이어서).
function withConnectTimeouts(
  connectString: string,
  connectSec: number = CONNECT_TIMEOUT_SEC,
  transportSec: number = TRANSPORT_CONNECT_TIMEOUT_SEC
): string {
  const params: string[] = [];
  if (connectSec > 0) params.push(`connect_timeout=${connectSec}`);
  if (transportSec > 0) params.push(`transport_connect_timeout=${transportSec}`);
  if (params.length === 0) return connectString;
  return connectString + (connectString.includes('?') ? '&' : '?') + params.join('&');
}

// callTimeout에 걸렸거나 연결이 끊겨 그 커넥션을 더 쓸 수 없을 때 나오는 코드들.
// Thick 모드에서 callTimeout은 실제로 NJS-500(연결 끊김)으로 오고, 이후 같은 커넥션은 NJS-003이 됩니다.
// oracledb 6은 DPI-1067을 NJS-123으로 바꾸고 원래 메시지를 뒤에 붙이므로 메시지 안의 코드도 봅니다.
const CONNECTION_BREAK_CODES = ['NJS-500', 'NJS-003', 'NJS-123', 'DPI-1067', 'DPI-1080', 'ORA-03156', 'ORA-03113', 'ORA-03135'];

function isConnectionBreakError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return CONNECTION_BREAK_CODES.some((c) => code === c || message.includes(c));
}

export type TargetErrorKind = 'TIMEOUT' | 'DISCONNECTED' | 'ERROR';

// NJS-500은 진짜 연결 끊김에서도 똑같이 나오므로 경과 시간으로 가릅니다:
// 끊김 계열 에러가 callTimeout 이상 지나서 났으면 TIMEOUT, 그 전이면 DISCONNECTED. 둘 다 재접속이 필요합니다.
// 그 밖의 에러(ORA-00942 등)는 ERROR — 커넥션은 그대로 써도 됩니다.
function classifyTargetError(error: unknown, elapsedMs: number, callTimeoutMs: number): TargetErrorKind {
  if (!isConnectionBreakError(error)) return 'ERROR';
  return callTimeoutMs > 0 && elapsedMs >= callTimeoutMs ? 'TIMEOUT' : 'DISCONNECTED';
}

export { CONNECT_TIMEOUT_SEC, TRANSPORT_CONNECT_TIMEOUT_SEC, CALL_TIMEOUT_MS, withConnectTimeouts, isConnectionBreakError, classifyTargetError };
