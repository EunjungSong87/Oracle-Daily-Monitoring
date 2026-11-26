// 이슈 티켓 종류. 임계치 위반 티켓은 column_name에 실제 결과 컬럼 이름이 들어가고,
// 점검 자체가 실패한 경우는 아래 예약된 column_name으로 구분한다 (uq_monitoring_issues_key = dbms_id, task_id, column_name).
// 클라이언트(client/src/pages/issues/issuesFormat.ts)에도 같은 값이 있다 — 바꾸면 양쪽을 같이 바꿀 것.

// 스크립트(SQL) 실행 실패 — ORA 에러, 시간 초과, 실행 중 연결 끊김. 키: (dbms, task_id, '__EXEC_ERROR__')
export const EXEC_ERROR_COLUMN = '__EXEC_ERROR__';
// 대상 DB 접속 실패 — DB당 한 장. 키: (dbms, 0, '__CONNECT__')
export const CONNECT_COLUMN = '__CONNECT__';
export const CONNECT_TASK_ID = 0;

// 실패한 태스크 결과의 failureKind. CONNECT는 접속(최초/재접속) 실패라 개별 스크립트 문제가 아니다.
export type TaskFailureKind = 'TIMEOUT' | 'DISCONNECTED' | 'ERROR' | 'CONNECT';

export function isFailureColumn(column: string): boolean {
  return column === EXEC_ERROR_COLUMN || column === CONNECT_COLUMN;
}

const KIND_LABELS: Record<TaskFailureKind, string> = {
  TIMEOUT: '실행 시간 초과',
  DISCONNECTED: '실행 중 연결 끊김',
  ERROR: 'SQL 실행 오류',
  CONNECT: '대상 DB 접속 실패',
};

export function failureKindLabel(kind: string | undefined): string {
  return KIND_LABELS[(kind ?? 'ERROR') as TaskFailureKind] ?? KIND_LABELS.ERROR;
}

// 에러 문자열에서 대표 코드 (ORA-00942, NJS-500, DPI-1080 ...) — 카드에 칩으로 보여 준다. 없으면 null.
export function errorCode(error: string | undefined | null): string | null {
  const match = /\b(ORA|NJS|DPI|TNS|PLS)-\d{3,5}\b/.exec(error ?? '');
  return match ? match[0] : null;
}
