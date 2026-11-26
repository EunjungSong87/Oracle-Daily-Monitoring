import type { IssueRow } from '../../shared/lib/types';

export const STATUS_LABELS: Record<string, string> = { OPEN: '미확인', ACKNOWLEDGED: '확인함', RESOLVED: '해결됨' };

export function formatDate(s: string | null | undefined): string {
  if (!s || s.length < 14) return s || '-';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

function parseStamp(s: string | null | undefined): Date | null {
  if (!s || s.length < 14) return null;
  const date = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
  return Number.isNaN(date.getTime()) ? null : date;
}

// 'YYYYMMDDHH24MISS' → "3분 전" / "2시간 전" / "4일 전" (카드에서 한눈에 얼마나 묵은 건지)
export function formatRelative(s: string | null | undefined, now = new Date()): string {
  const date = parseStamp(s);
  if (!date) return '-';
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

// ── 이슈 종류 ── 서버 utils/issueKinds.ts와 같은 값 (바꾸면 양쪽 같이)
export const EXEC_ERROR_COLUMN = '__EXEC_ERROR__';
export const CONNECT_COLUMN = '__CONNECT__';

export type IssueKind = 'THRESHOLD' | 'EXEC' | 'CONNECT';

export const KIND_LABELS: Record<IssueKind, string> = {
  THRESHOLD: '임계치 위반',
  EXEC: '스크립트 실행 실패',
  CONNECT: '대상 DB 접속 실패',
};

export function issueKind(issue: Pick<IssueRow, 'columnName'>): IssueKind {
  if (issue.columnName === EXEC_ERROR_COLUMN) return 'EXEC';
  if (issue.columnName === CONNECT_COLUMN) return 'CONNECT';
  return 'THRESHOLD';
}

// 실패 티켓의 전체 에러 문구 (message는 255바이트로 잘린 첫 줄, details에 원문이 있다)
export function failureError(issue: IssueRow): string {
  const raw = issue.details[0]?.ERROR;
  return raw != null && raw !== '' ? String(raw) : (issue.message ?? '');
}

// 실패 티켓의 실패 유형 문구 (SQL 실행 오류 / 실행 시간 초과 / ...)
export function failureLabel(issue: IssueRow): string {
  const raw = issue.details[0]?.FAILURE;
  return raw ? String(raw) : KIND_LABELS[issueKind(issue)];
}

const LABEL_COLUMN_HINT = /NAME|TABLESPACE|OWNER|USER|SCHEMA|OBJECT|FILE|JOB|GROUP|SEGMENT|INSTANCE|SID|PROGRAM|DISK|TABLE/i;

function isNumericLike(value: unknown): boolean {
  if (typeof value === 'number') return true;
  const text = String(value ?? '').trim();
  return text !== '' && !Number.isNaN(Number(text.replace(/[,%]/g, '')));
}

// 위반 행에서 "무엇이" 위반했는지 알려 줄 식별 값 (예: 테이블스페이스 이름).
// 이름 같은 컬럼을 우선, 없으면 위반 컬럼이 아닌 첫 번째 문자열 컬럼. 못 찾으면 null.
export function objectLabel(row: Record<string, unknown>, violatedColumn: string): string | null {
  const candidates = Object.keys(row).filter((column) => column !== violatedColumn && row[column] != null && String(row[column]).trim() !== '');
  const hinted = candidates.find((column) => LABEL_COLUMN_HINT.test(column) && !isNumericLike(row[column]));
  const fallback = candidates.find((column) => !isNumericLike(row[column]));
  const column = hinted ?? fallback;
  return column ? String(row[column]) : null;
}

export interface ViolationItem {
  label: string | null;
  value: string;
}

// 카드에 보여 줄 위반 대상 목록 (식별 값 + 위반 값)
export function violationItems(issue: IssueRow): ViolationItem[] {
  return issue.details.map((row) => ({ label: objectLabel(row, issue.columnName), value: String(row[issue.columnName] ?? '') }));
}
