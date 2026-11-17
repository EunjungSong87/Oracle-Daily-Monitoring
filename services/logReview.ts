import { RULES, type LogRule, type LogType, type Severity } from './logReviewRules';

// Maintenance > 로그 업로드 검토 — DB 접근 없는 순수 함수 (logReview.test.ts에서 단위 테스트).
// 업로드한 alert / 리스너 / CRS 로그 텍스트를 줄 단위로 규칙과 맞춰 특이사항을 뽑는다. 결과는 저장하지 않는다.

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_LINES = 500_000;
const CONTEXT_LINES = 2;

export interface Finding {
  line: number; // 1부터
  time: string | null; // YYYY-MM-DD HH:MM:SS (best-effort, 못 뽑으면 null)
  severity: Severity;
  category: string;
  label: string;
  text: string;
  context: string[]; // 전후 CONTEXT_LINES줄 (자기 줄 포함). 합성 finding은 해당 구간의 실패 줄 전부
  contextFrom: number | null; // context 첫 줄 번호. 합성 finding은 줄이 띄엄띄엄이라 null
  synthetic?: boolean; // 여러 줄을 모아 만든 finding (IP별 연속 접속 실패)
}

export interface Summary {
  critical: number;
  warn: number;
  info: number;
  security: number;
  total: number;
  byCategory: Record<string, number>;
}

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, WARN: 1, INFO: 2 };
const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

const pad = (n: number) => String(n).padStart(2, '0');

function format(y: number, mo: number, d: number, h: number, mi: number, s: number): string | null {
  if (!mo || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

// 11g alert: "Mon Nov 17 10:15:32 2026" / 12.2+ alert, CRS: "2026-11-17T10:15:32.123+09:00", "2026-11-17 10:15:32.123"
const DAY_MON_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;
// 리스너/CRS: "17-NOV-2026 10:15:32"
const DMY_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/;

function fromIso(m: RegExpExecArray): string | null {
  return format(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
}

function fromDmy(m: RegExpExecArray): string | null {
  return format(+m[3], MONTHS[m[2].toUpperCase()], +m[1], +m[4], +m[5], +m[6]);
}

// 그 줄 맨 앞의 타임스탬프 (로그 종류별 포맷). 못 뽑으면 null — best-effort.
export function parseTimestamp(line: string, logType: LogType): string | null {
  const text = line.trimStart();
  let m: RegExpExecArray | null;
  if (logType === 'ALERT') {
    if ((m = DAY_MON_RE.exec(text))) return format(+m[6], MONTHS[m[1].toUpperCase()], +m[2], +m[3], +m[4], +m[5]);
    if ((m = ISO_RE.exec(text))) return fromIso(m);
    return null;
  }
  if ((m = DMY_RE.exec(text))) return fromDmy(m);
  if ((m = ISO_RE.exec(text))) return fromIso(m);
  return null;
}

function epochOf(time: string): number {
  const [d, t] = time.split(' ');
  const [y, mo, day] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, day, h, mi, s);
}

// 줄 수가 MAX_LINES를 넘으면 뒷부분(최근 기록)만 남긴다. dropped = 앞에서 버린 줄 수.
export function splitLines(text: string): { lines: string[]; dropped: number } {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length > MAX_LINES ? { lines: lines.slice(-MAX_LINES), dropped: lines.length - MAX_LINES } : { lines, dropped: 0 };
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (let at = buffer.indexOf(10); at !== -1; at = buffer.indexOf(10, at + 1)) count++;
  return count;
}

// 크기 가드: 로그는 최근 기록이 끝에 쌓이므로 MAX_BYTES / MAX_LINES를 넘으면 뒷부분만 남긴다
// (첫 줄이 반쯤 잘리지 않게 줄 경계에서). lineOffset = 앞에서 버린 줄 수 — 줄 번호를 원본 파일 기준으로 맞출 때 쓴다.
export function limitText(text: string): { text: string; truncatedBytes: boolean; truncatedLines: boolean; lineCount: number; lineOffset: number } {
  let result = text;
  let truncatedBytes = false;
  let lineOffset = 0;
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length > MAX_BYTES) {
    const cut = buffer.length - MAX_BYTES;
    const newline = buffer.indexOf(10, cut);
    const start = newline === -1 ? cut : newline + 1;
    lineOffset = countNewlines(buffer.subarray(0, start));
    result = buffer.subarray(start).toString('utf8');
    truncatedBytes = true;
  }
  const { lines, dropped } = splitLines(result);
  return { text: dropped > 0 ? lines.join('\n') : result, truncatedBytes, truncatedLines: dropped > 0, lineCount: lines.length, lineOffset: lineOffset + dropped };
}

// 한 줄에 걸린 규칙 중 심각도가 가장 높은 것 (같으면 앞의 것)
export function matchLine(line: string, rules: LogRule[]): { rule: LogRule; label: string } | null {
  let best: { rule: LogRule; label: string } | null = null;
  for (const rule of rules) {
    const m = rule.pattern.exec(line);
    if (!m) continue;
    if (!best || SEVERITY_RANK[rule.severity] < SEVERITY_RANK[best.rule.severity]) {
      best = { rule, label: rule.label.replace('$1', m[1] ?? '') };
      if (rule.severity === 'CRITICAL') break;
    }
  }
  return best;
}

// 리스너 표준 포맷: "17-NOV-2026 10:15:32 * ... * (ADDRESS=(PROTOCOL=tcp)(HOST=10.0.0.5)(PORT=51234)) * establish * ORCL * 12514"
// CONNECT_DATA 안의 (HOST=클라이언트 호스트명)이 아니라 ADDRESS 안의 HOST(접속 IP)를 쓴다.
const LISTENER_ADDRESS_RE = /\(ADDRESS=\(PROTOCOL=[^)]*\)\(HOST=([^)]+)\)/i;
const LISTENER_CODE_RE = /\*\s*(\d+)\s*$/;

export function parseListenerConnection(line: string): { time: string; ip: string; code: string } | null {
  const time = parseTimestamp(line, 'LISTENER');
  const address = LISTENER_ADDRESS_RE.exec(line);
  const code = LISTENER_CODE_RE.exec(line);
  return time && address && code ? { time, ip: address[1].trim(), code: code[1] } : null;
}

// 같은 IP에서 windowMinutes 안에 threshold건 이상 접속 실패(리턴코드 ≠ 0)면 그 구간마다 합성 finding 하나.
// 구간은 첫 실패부터 windowMinutes 안의 실패를 모은 것 — 한 구간에 쓴 실패는 다음 구간에 다시 쓰지 않는다.
// 브라우저가 골라 보낸 줄의 원본 줄 번호 검증: 보낸 줄 수와 같은 개수, 1 이상 정수, 증가 순, sourceLines 이하.
// 문제가 없으면 null, 있으면 사용자에게 보일 메시지.
export function validateLineNumbers(content: string, lineNumbers: unknown, sourceLines: unknown): string | null {
  if (!Array.isArray(lineNumbers) || lineNumbers.length > MAX_LINES) return '줄 번호 목록이 올바르지 않습니다.';
  const total = Number(sourceLines);
  if (!Number.isInteger(total) || total < lineNumbers.length) return '원본 줄 수가 올바르지 않습니다.';
  const { lines, dropped } = splitLines(content);
  if (lines.length + dropped !== lineNumbers.length) return '보낸 줄 수와 줄 번호 개수가 다릅니다.';
  let previous = 0;
  for (const value of lineNumbers) {
    if (!Number.isInteger(value) || value <= previous || value > total) return '줄 번호 목록이 올바르지 않습니다.';
    previous = value;
  }
  return null;
}

// 줄 위치: 숫자면 앞에서 버린 줄 수(연속된 구간), 배열이면 줄마다의 원본 줄 번호(브라우저가 골라낸 띄엄띄엄한 줄).
export type LinePosition = number | readonly number[];

function lineNumberAt(position: LinePosition, index: number): number {
  return typeof position === 'number' ? position + index + 1 : (position[index] ?? index + 1);
}

export function detectSuspiciousConnections(lines: string[], windowMinutes = 10, threshold = 5, position: LinePosition = 0): Finding[] {
  const byIp = new Map<string, { at: number; time: string; line: number; text: string; code: string }[]>();
  lines.forEach((text, index) => {
    const conn = parseListenerConnection(text);
    if (!conn || conn.code === '0') return;
    const list = byIp.get(conn.ip) ?? [];
    list.push({ at: epochOf(conn.time), time: conn.time, line: lineNumberAt(position, index), text, code: conn.code });
    byIp.set(conn.ip, list);
  });
  const windowMs = windowMinutes * 60 * 1000;
  const findings: Finding[] = [];
  for (const [ip, failures] of byIp) {
    failures.sort((a, b) => a.at - b.at || a.line - b.line);
    let start = 0;
    while (start < failures.length) {
      let end = start;
      while (end + 1 < failures.length && failures[end + 1].at - failures[start].at <= windowMs) end++;
      const count = end - start + 1;
      if (count >= threshold) {
        const group = failures.slice(start, end + 1);
        const codes = [...new Set(group.map((f) => f.code))].join(', ');
        findings.push({
          line: group[0].line,
          time: group[0].time,
          severity: 'CRITICAL',
          category: 'SECURITY',
          label: `IP ${ip} 에서 ${count}건 연속 접속 실패 (${group[0].time}~${group[group.length - 1].time})`,
          text: `리턴코드: ${codes}`,
          context: group.map((f) => f.text),
          contextFrom: null,
          synthetic: true,
        });
        start = end + 1;
      } else {
        start++;
      }
    }
  }
  return findings;
}

// 줄 단위 규칙 매칭 (+ LISTENER면 IP별 연속 실패 합성 finding). 줄 번호 순, 같은 줄이면 합성 finding이 먼저.
// position: 줄 번호를 원본 파일 기준으로 맞추는 정보 (LinePosition). 골라낸 줄(배열)이면 전후 줄이 연속이 아니라 contextFrom은 null.
export function analyze(logType: LogType, text: string, position: LinePosition = 0): Finding[] {
  const rules = RULES[logType];
  const { lines } = splitLines(text);
  const findings: Finding[] = [];
  let currentTime: string | null = null; // alert 로그는 시각이 별도 머리 줄이라 다음 머리 줄까지 이어서 쓴다
  lines.forEach((line, index) => {
    const time = parseTimestamp(line, logType);
    if (time) currentTime = time;
    if (!line.trim()) return;
    const hit = matchLine(line, rules);
    if (!hit) return;
    const from = Math.max(0, index - CONTEXT_LINES);
    findings.push({
      line: lineNumberAt(position, index),
      time: currentTime,
      severity: hit.rule.severity,
      category: hit.rule.category,
      label: hit.label,
      text: line,
      context: lines.slice(from, index + CONTEXT_LINES + 1),
      contextFrom: typeof position === 'number' ? position + from + 1 : null,
    });
  });
  if (logType === 'LISTENER') findings.push(...detectSuspiciousConnections(lines, 10, 5, position));
  return findings.sort((a, b) => a.line - b.line || Number(Boolean(b.synthetic)) - Number(Boolean(a.synthetic)));
}

export function summarize(findings: Finding[]): Summary {
  const summary: Summary = { critical: 0, warn: 0, info: 0, security: 0, total: findings.length, byCategory: {} };
  for (const finding of findings) {
    if (finding.severity === 'CRITICAL') summary.critical++;
    else if (finding.severity === 'WARN') summary.warn++;
    else summary.info++;
    if (finding.category === 'SECURITY') summary.security++;
    summary.byCategory[finding.category] = (summary.byCategory[finding.category] ?? 0) + 1;
  }
  return summary;
}
