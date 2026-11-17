// Maintenance > 로그 업로드 검토 — 로그 종류별 패턴 규칙 (DB 접근 없음).
// 한 줄에 여러 규칙이 걸리면 심각도 높은 것 하나, 같으면 배열에서 먼저 나온 것 (그래서 fallback 규칙은 항상 맨 뒤).
// label의 $1은 pattern의 첫 캡처 그룹으로 바뀐다 (예: 리스너 리턴코드).

export type LogType = 'ALERT' | 'LISTENER' | 'CRS';
export type Severity = 'CRITICAL' | 'WARN' | 'INFO';

export interface LogRule {
  pattern: RegExp;
  severity: Severity;
  category: string; // 'SECURITY'는 화면의 "보안만 보기" 필터 대상
  label: string;
}

export const LOG_TYPES: readonly LogType[] = ['ALERT', 'LISTENER', 'CRS'];

export const ALERT_RULES: LogRule[] = [
  { pattern: /ORA-00600/, severity: 'CRITICAL', category: 'INTERNAL', label: '내부 오류' },
  { pattern: /ORA-07445/, severity: 'CRITICAL', category: 'INTERNAL', label: '세그먼트 폴트' },
  { pattern: /ORA-0403[01]/, severity: 'CRITICAL', category: 'MEMORY', label: '메모리/프로세스 부족' },
  { pattern: /ORA-0165[2-4]|ORA-01688/, severity: 'CRITICAL', category: 'SPACE', label: '테이블스페이스 공간 부족으로 확장 실패' },
  { pattern: /Instance terminated|ORA-00603/, severity: 'CRITICAL', category: 'INSTANCE', label: '인스턴스 비정상 종료' },
  // 보안: ORA-01017/ORA-01031은 unified audit을 안 켠 환경에선 alert 로그에 아예 안 남는 경우가 많다 — 안 보인다고 시도가 없었다는 뜻은 아님.
  { pattern: /ORA-28000/, severity: 'CRITICAL', category: 'SECURITY', label: '계정 잠김 (연속 로그인 실패로 추정)' },
  { pattern: /ORA-01017/, severity: 'WARN', category: 'SECURITY', label: '잘못된 사용자명/비밀번호 시도' },
  { pattern: /ORA-01031/, severity: 'WARN', category: 'SECURITY', label: '권한 부족 접근 시도' },
  { pattern: /LOGON (?:denied|failed)|logon denied/, severity: 'WARN', category: 'SECURITY', label: '로그온 거부' },
  { pattern: /ORA-01555/, severity: 'WARN', category: 'UNDO', label: '읽기 일관성 오류(snapshot too old)' },
  { pattern: /ORA-00060/, severity: 'WARN', category: 'LOCK', label: '데드락 감지' },
  { pattern: /ORA-0311[35]/, severity: 'WARN', category: 'CONNECTION', label: '세션/프로세스 연결 끊김' },
  { pattern: /Thread \d+ cannot allocate new log/, severity: 'WARN', category: 'REDO', label: '온라인 리두로그 전환 지연' },
  { pattern: /Checkpoint not complete/, severity: 'WARN', category: 'REDO', label: '체크포인트 지연' },
  { pattern: /Errors in file/, severity: 'INFO', category: 'TRACE', label: '트레이스 파일 생성' },
  { pattern: /Starting ORACLE instance|Shutting down instance/, severity: 'INFO', category: 'INSTANCE', label: '인스턴스 시작/종료' },
  { pattern: /(ORA-\d{5})/, severity: 'INFO', category: 'OTHER', label: '기타 ORA 오류 ($1)' },
];

export const LISTENER_RULES: LogRule[] = [
  { pattern: /TNS-00525|TNS-01189/, severity: 'CRITICAL', category: 'SECURITY', label: '리스너 권한 부족/인증 실패' },
  { pattern: /TNS-12535|TNS-12170/, severity: 'WARN', category: 'CONNECTION', label: '연결 타임아웃' },
  { pattern: /TNS-12541|TNS-12560|TNS-12500/, severity: 'WARN', category: 'CONNECTION', label: '리스너 응답 없음/프로토콜 오류' },
  // 표준 포맷 "... * establish * SERVICE * 12514" — 맨 끝 리턴코드가 0이 아니면 실패
  { pattern: /\*\s*([1-9]\d*)\s*$/, severity: 'WARN', category: 'CONNECTION', label: '연결 실패(코드 $1)' },
  { pattern: /(TNS-\d{5})/, severity: 'INFO', category: 'OTHER', label: '기타 TNS 오류 ($1)' },
];

// CRS 로그에도 가끔 ORA- 메시지가 섞이므로 ALERT 규칙 중 ORA 코드 규칙을 뒤에 붙인다.
const ORA_RULES = ALERT_RULES.filter((rule) => rule.pattern.source.includes('ORA-'));

export const CRS_RULES: LogRule[] = [
  { pattern: /CRS-1607|CRS-1612|CRS-1614|CRS-1652/, severity: 'CRITICAL', category: 'CLUSTER', label: '노드 하트비트/Eviction 문제' },
  { pattern: /CRS-0215/, severity: 'CRITICAL', category: 'CLUSTER', label: '리소스 시작 실패' },
  { pattern: /Eviction|Fencing|Reboot Advisory/, severity: 'CRITICAL', category: 'CLUSTER', label: '노드 강제 재부팅/격리' },
  { pattern: /CRS-8011/, severity: 'WARN', category: 'CLUSTER', label: '재부팅 권고(reboot advisory) 메시지 수신' },
  { pattern: /(CRS-\d{4})/, severity: 'INFO', category: 'OTHER', label: '기타 CRS 오류 ($1)' },
  ...ORA_RULES,
];

export const RULES: Record<LogType, LogRule[]> = { ALERT: ALERT_RULES, LISTENER: LISTENER_RULES, CRS: CRS_RULES };
