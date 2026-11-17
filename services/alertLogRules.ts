import crypto from 'crypto';

// Monitoring > Alert Log의 순수 로직 (DB 접근 없음 — alertLogRules.test.ts에서 단위 테스트).

export const MAX_SEARCH_LIMIT = 5000;
export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_RANGE_DAYS = 366;
export const MESSAGE_MAX_BYTES = 4000; // alert_log_history.message_text VARCHAR2(4000)

export interface AlertLogSearchParams {
  dbmsId: number | null; // null = 전체 DB
  fromDate: string; // YYYY-MM-DD (포함)
  toDate: string; // YYYY-MM-DD (포함)
  oraCode: string | null; // 정규화된 접두어 (예: ORA-00600) — LIKE 'ORA-00600%'
  keyword: string | null; // message_text 부분 일치 (대소문자 무시)
  limit: number;
  offset: number;
}

export type ParseResult = { ok: true; params: AlertLogSearchParams } | { ok: false; message: string };

// 메시지에서 첫 ORA-NNNNN (저장은 SQL의 REGEXP_SUBSTR로 하지만, 같은 규칙을 Node 쪽 검증/테스트용으로 둔다)
export function extractOraCode(message: string | null | undefined): string | null {
  const match = /ORA-[0-9]+/.exec(message ?? '');
  return match ? match[0] : null;
}

// 사용자가 넣은 ORA 코드 → 검색 접두어. "600", "ora-600", "ORA600" → "ORA-00600". 빈 값이면 null, 형식이 아니면 undefined(오류).
export function normalizeOraCode(input: unknown): string | null | undefined {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') return undefined;
  const value = input.trim().toUpperCase();
  if (!value) return null;
  const match = /^(?:ORA-?)?(\d{1,6})$/.exec(value);
  if (!match) return undefined;
  return `ORA-${match[1].padStart(5, '0')}`;
}

// LIKE 와일드카드(%, _)와 이스케이프 문자를 글자 그대로 찾게 (SQL에서 ESCAPE '\')
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseDay(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

// 검색/추이 POST 바디 검증. 날짜는 YYYY-MM-DD, from ≤ to, 기간 최대 MAX_RANGE_DAYS일, limit 1~MAX_SEARCH_LIMIT.
export function parseSearchParams(body: Record<string, unknown> | null | undefined): ParseResult {
  const input = body ?? {};
  let dbmsId: number | null = null;
  if (input.dbmsId !== undefined && input.dbmsId !== null && input.dbmsId !== '') {
    const id = Number(input.dbmsId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'DB 선택이 올바르지 않습니다.' };
    dbmsId = id;
  }
  const from = parseDay(input.fromDate);
  const to = parseDay(input.toDate);
  if (!from || !to) return { ok: false, message: '기간을 YYYY-MM-DD 형식으로 입력해주세요.' };
  if (from > to) return { ok: false, message: '시작일이 종료일보다 늦습니다.' };
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) return { ok: false, message: `기간은 최대 ${MAX_RANGE_DAYS}일까지 조회할 수 있습니다.` };
  const oraCode = normalizeOraCode(input.oraCode);
  if (oraCode === undefined) return { ok: false, message: 'ORA 코드는 ORA-00600 또는 600 형식으로 입력해주세요.' };
  let keyword: string | null = null;
  if (input.keyword !== undefined && input.keyword !== null) {
    if (typeof input.keyword !== 'string') return { ok: false, message: '키워드가 올바르지 않습니다.' };
    keyword = input.keyword.trim() || null;
    if (keyword && keyword.length > 200) return { ok: false, message: '키워드는 200자 이하로 입력해주세요.' };
  }
  const limit = input.limit === undefined ? DEFAULT_SEARCH_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) return { ok: false, message: `한 번에 조회할 행 수는 1~${MAX_SEARCH_LIMIT}입니다.` };
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (!Number.isInteger(offset) || offset < 0) return { ok: false, message: 'offset이 올바르지 않습니다.' };
  return { ok: true, params: { dbmsId, fromDate: input.fromDate as string, toDate: input.toDate as string, oraCode, keyword, limit, offset } };
}

// 중복 적재 방지 키 (유니크 인덱스 dbms_id + log_time + msg_hash)
export function messageHash(messageText: string): string {
  return crypto.createHash('md5').update(messageText).digest('hex');
}

// VARCHAR2(4000) 바이트 한도에 맞게 자른다 (멀티바이트 글자를 반으로 쪼개지 않게)
export function truncateBytes(text: string, maxBytes: number = MESSAGE_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    result += ch;
    bytes += size;
  }
  return result;
}

// 대상 DB에서 읽은 줄 → 저장 단위: 해시는 원문 전체로, 저장 텍스트는 4000바이트로 자르고,
// 같은 시각+메시지가 한 번에 여러 줄 오면 하나만 (MERGE 한 배치 안에서 같은 키 반복 방지)
export function toSamples<T extends { logTime: string; messageText: string }>(entries: T[]): (T & { msgHash: string })[] {
  const seen = new Set<string>();
  const samples: (T & { msgHash: string })[] = [];
  for (const entry of entries) {
    const msgHash = messageHash(entry.messageText);
    const key = `${entry.logTime}\u0001${msgHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ ...entry, messageText: truncateBytes(entry.messageText), msgHash });
  }
  return samples;
}
