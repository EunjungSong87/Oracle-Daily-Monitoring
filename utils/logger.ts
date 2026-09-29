// 서버 로그 공통 포맷. 모든 로그를 한 줄 형식으로 맞춥니다:
//
//   2026-09-29 14:03:12 ERROR [DBMS] 점검 실행 오류 | 대상 DB 접속 실패 ← ORA-12514: TNS:listener ...
//
// 로그 원칙:
// - 에러는 한 번만 찍습니다. model/service는 로그 없이 던지기만 하고(필요하면 cause로 감싸서),
//   요청을 마무리하는 controller(또는 에러를 삼키고 계속 진행하는 지점)에서만 찍습니다.
// - 요청 파라미터/결과 건수 같은 디버그성 로그는 남기지 않습니다.
// - 비밀번호 등 자격 증명은 절대 로그에 넣지 않습니다.

type Level = 'INFO' | 'WARN' | 'ERROR';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function timestamp(now: Date = new Date()): string {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
  );
}

// Oracle 드라이버 에러(ORA-/NJS-/DPI-/TNS-)는 메시지만으로 충분하고 스택은 드라이버 내부라 쓸모가 없습니다.
const ORACLE_ERROR = /^(ORA|NJS|DPI|TNS)-\d+/;

// Error.cause 체인을 "바깥 ← 안쪽" 순으로 한 줄로 이어 붙입니다. 로그 메시지와 같은 문구는 중복이라 뺍니다.
// 가장 안쪽(근본 원인)이 Oracle 에러가 아니면 예상 못 한 버그일 가능성이 커서 그 스택을 함께 반환합니다.
function describeError(error: unknown, logMessage: string): { chain: string; stack?: string } {
  const messages: string[] = [];
  let current: unknown = error;
  let root: unknown = error;
  for (let depth = 0; current != null && depth < 10; depth++) {
    root = current;
    const message = current instanceof Error ? current.message : String(current);
    if (message && message !== logMessage && messages[messages.length - 1] !== message) {
      messages.push(message);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  const rootMessage = root instanceof Error ? root.message : '';
  const stack = root instanceof Error && !ORACLE_ERROR.test(rootMessage) ? root.stack : undefined;
  return { chain: messages.join(' ← '), stack };
}

function write(level: Level, scope: string, message: string, error?: unknown): void {
  let line = `${timestamp()} ${level.padEnd(5)} [${scope}] ${message}`;
  let stack: string | undefined;
  if (error !== undefined) {
    const described = describeError(error, message);
    if (described.chain) line += ` | ${described.chain}`;
    stack = described.stack;
  }
  const out = level === 'INFO' ? console.log : console.error;
  out(line);
  if (stack) out(stack);
}

const logger = {
  info: (scope: string, message: string): void => write('INFO', scope, message),
  warn: (scope: string, message: string, error?: unknown): void => write('WARN', scope, message, error),
  error: (scope: string, message: string, error?: unknown): void => write('ERROR', scope, message, error),
};

export { logger, describeError };
