import { fail } from './dataPumpErrors';
import type { DataFilter, ObjectFilter, ObjectFilterRule, QueryRule } from './dataPumpFilters';
import { logLines } from './dataPumpLogVerify';
import { parseIdentifier, parseParList, parseQualified, qualifiedName, sqlName } from './dataPumpNames';
import type { DataPumpRequest } from './dataPumpService';

// Import 탭 "기존 Export에서 가져오기": Export의 parfile / 로그 헤더 / 작업 이력에서 Import 폼에 채울 값을 만든다 (DB 접근 없는 순수 함수).
// 절대 규칙: Export에 있던 스키마·테이블·파티션 항목은 하나도 빠지면 안 된다 — 다 읽지 못하면 채우지 않고 거부한다.

export interface ImportDraft {
  source: string; // 사람이 읽는 출처 설명
  directory: string | null;
  dumpfile: string | null; // %U / %u 그대로
  mode: 'FULL' | 'SCHEMA' | 'TABLE';
  schemas: string[]; // SQL 표기 (따옴표 이름 유지)
  tables: string[]; // OWNER.TABLE 또는 OWNER.TABLE:PART (SQL 표기). 소유자 없는 Export면 TABLE만
  parallel: number | null;
  content: 'ALL' | 'DATA_ONLY' | 'METADATA_ONLY' | null;
  excludeStatistics: boolean | null;
  metrics: boolean | null; // METRICS=YES/NO
  logtime: 'NONE' | 'STATUS' | 'LOGFILE' | 'ALL' | null;
  objectFilter: ObjectFilter;
  dataFilter: DataFilter;
  warnings: string[];
  unknownKeys: string[]; // 처리하지 못해 폼에 반영하지 않은 항목 (원문)
}

// 파일/로그·실행 관련 설정이라 Import 폼에는 해당 없음 (조용히 넘기되 목록에는 보여 줌)
const EXPORT_ONLY = new Set([
  'LOGFILE',
  'NOLOGFILE',
  'JOB_NAME',
  'FILESIZE',
  'REUSE_DUMPFILES',
  'FLASHBACK_SCN',
  'FLASHBACK_TIME',
  'COMPRESSION',
  'COMPRESSION_ALGORITHM',
  'ESTIMATE',
  'ESTIMATE_ONLY',
  'USERID',
  'STATUS',
  'KEEP_MASTER',
  'ENCRYPTION_PASSWORD',
]);

// ── parfile → (키, 값) 목록 ──
// 값이 여러 줄에 걸칠 수 있다: 따옴표/괄호가 안 닫혔거나, 값이 쉼표로 끝났거나, 다음 줄이 "KEY=" 꼴이 아니면 이어지는 값.
// 같은 키가 여러 줄에 나오면 모두 남긴다 (EXCLUDE/QUERY/TABLES 등은 합치고, 하나짜리 값은 마지막 것).
const KEY_LINE = /^\s*([A-Za-z_]+)\s*=(.*)$/s;

function openState(text: string): { quote: string | null; depth: number } {
  let quote: string | null = null;
  let depth = 0;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return { quote, depth };
}

export function parseParfileEntries(text: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || (/^\s*#/.test(line) && entries.length === 0)) continue;
    const last = entries[entries.length - 1];
    const open = last ? openState(last.value) : { quote: null, depth: 0 };
    const continues = last && (open.quote !== null || open.depth > 0 || /,\s*$/.test(last.value) || !KEY_LINE.test(line));
    if (continues) {
      if (/^\s*#/.test(line) && open.quote === null && open.depth === 0) continue;
      last.value = open.quote ? `${last.value}\n${line}` : `${last.value}${/,\s*$/.test(last.value) ? '' : ' '}${line.trim()}`;
      continue;
    }
    const match = line.match(KEY_LINE)!;
    entries.push({ key: match[1].toUpperCase(), value: match[2].trim() });
  }
  return entries;
}

// 명령줄(로그 헤더의 "Starting ...:  system/******** directory=X tables=A,B") → (키, 값). 공백으로 나누되 따옴표·괄호 안은 그대로.
export function parseCommandLine(text: string): { key: string; value: string }[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && !quote && depth === 0) {
      if (current) tokens.push(current);
      current = '';
    } else current += ch;
  }
  if (current) tokens.push(current);
  const entries: { key: string; value: string }[] = [];
  for (const token of tokens) {
    const match = token.match(/^([A-Za-z_]+)=(.*)$/s);
    if (match) entries.push({ key: match[1].toUpperCase(), value: match[2] });
    else if (entries.length > 0 && !/^[^=]+\/[^=]*$/.test(token)) entries[entries.length - 1].value += ` ${token}`; // 쉼표 뒤 공백으로 끊긴 목록 이어 붙임
  }
  return entries;
}

// 목록 값: 괄호로 감싼 (A,B) 허용, 따옴표 안 쉼표는 구분자가 아님
function listOf(value: string): string[] {
  const trimmed = value.trim();
  const inner = /^\(.*\)$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  return parseParList(inner.replace(/\s*\n\s*/g, ''));
}

function unquoteDouble(text: string): string {
  const trimmed = text.trim();
  return /^".*"$/s.test(trimmed) ? trimmed.slice(1, -1).replace(/\\"/g, '"') : trimmed;
}

// EXCLUDE/INCLUDE 값 하나 → 오브젝트 필터 규칙. 이름 조건이 없으면 그 유형 전체(ALL). 못 읽는 조건은 null.
function filterRule(kind: 'INCLUDE' | 'EXCLUDE', value: string): ObjectFilterRule | null {
  const match = value.trim().match(/^([A-Za-z_/]+)\s*(?::\s*(.+))?$/s);
  if (!match) return null;
  const path = match[1].toUpperCase();
  if (!match[2]) return { kind, path, op: 'ALL' };
  const cond = unquoteDouble(match[2]).trim();
  const values = (text: string) => [...text.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  let m: RegExpMatchArray | null;
  if ((m = cond.match(/^IN\s*\(\s*(SELECT\b.*)\)$/is))) return { kind, path, op: 'SUBQUERY', subquery: m[1].trim() };
  if ((m = cond.match(/^(NOT\s+IN|IN)\s*\((.*)\)$/is))) return { kind, path, op: /^NOT/i.test(m[1]) ? 'NOT IN' : 'IN', values: values(m[2]) };
  if ((m = cond.match(/^(NOT\s+LIKE|LIKE)\s*('.*')$/is))) return { kind, path, op: /^NOT/i.test(m[1]) ? 'NOT LIKE' : 'LIKE', values: values(m[2]) };
  if ((m = cond.match(/^(!=|<>|=)\s*('.*')$/s))) return { kind, path, op: m[1] === '=' ? '=' : '!=', values: values(m[2]) };
  return null;
}

// QUERY=[OWNER.TABLE:]"WHERE ..." → QUERY 규칙
function queryRule(value: string): QueryRule | null {
  const trimmed = value.trim();
  const target = trimmed.match(/^([^"':]+):(.*)$/s);
  const where = unquoteDouble(target ? target[2] : trimmed);
  if (!where) return null;
  if (!target) return { owner: null, table: null, where };
  const [owner, table] = target[1].includes('.') ? target[1].split('.') : [null, target[1]];
  return { owner: owner ? parseIdentifier(owner, 'QUERY 소유자') : null, table: parseIdentifier(table, 'QUERY 테이블'), where };
}

// (키, 값) → Import 폼 값
export function draftFromEntries(entries: { key: string; value: string }[], source: string, sqlAllowed: boolean): ImportDraft {
  const draft: ImportDraft = {
    source,
    directory: null,
    dumpfile: null,
    mode: 'FULL',
    schemas: [],
    tables: [],
    parallel: null,
    content: null,
    excludeStatistics: null,
    metrics: null,
    logtime: null,
    objectFilter: { rules: [] },
    dataFilter: {},
    warnings: [],
    unknownKeys: [],
  };
  let full = false;
  const queries: QueryRule[] = [];
  for (const { key, value } of entries) {
    const raw = `${key}=${value}`;
    switch (key) {
      case 'DIRECTORY':
        draft.directory = parseIdentifier(value.trim(), 'DIRECTORY');
        break;
      case 'DUMPFILE':
        // 여러 줄/여러 번 나오면 합친다. DIRECTORY:FILE 꼴의 디렉토리 접두어는 떼고 경고 (폼은 DIRECTORY 하나)
        draft.dumpfile = [
          ...(draft.dumpfile ? draft.dumpfile.split(',') : []),
          ...listOf(value).map((item) => {
            const [dir, file] = item.includes(':') ? item.split(':') : [null, item];
            if (dir) draft.warnings.push(`DUMPFILE ${item}: 디렉토리 접두어(${dir})는 빼고 DIRECTORY 칸을 따릅니다`);
            return file.trim();
          }),
        ].join(',');
        break;
      case 'FULL':
        full = /^(Y|YES|TRUE)$/i.test(value.trim());
        break;
      case 'SCHEMAS':
        draft.schemas.push(...listOf(value).map((item) => sqlName(parseIdentifier(item, '스키마'))));
        break;
      case 'TABLES':
        draft.tables.push(
          ...listOf(value).map((item) => {
            if (!/[.]/.test(item.replace(/"[^"]*"/g, ''))) {
              const [table, partition] = item.split(':');
              return `${sqlName(parseIdentifier(table, '테이블'))}${partition ? `:${sqlName(parseIdentifier(partition, '파티션'))}` : ''}`;
            }
            const parsed = parseQualified(item);
            return qualifiedName(parsed.owner, parsed.table, parsed.partition);
          })
        );
        break;
      case 'PARALLEL': {
        const n = Number(value.trim());
        if (Number.isInteger(n) && n >= 1) draft.parallel = n;
        else draft.unknownKeys.push(raw);
        break;
      }
      case 'CONTENT': {
        const v = value.trim().toUpperCase();
        if (v === 'ALL' || v === 'DATA_ONLY' || v === 'METADATA_ONLY') draft.content = v;
        else draft.unknownKeys.push(raw);
        break;
      }
      case 'METRICS': {
        const v = value.trim().toUpperCase();
        if (v === 'YES' || v === 'Y') draft.metrics = true;
        else if (v === 'NO' || v === 'N') draft.metrics = false;
        else draft.unknownKeys.push(raw);
        break;
      }
      case 'LOGTIME': {
        const v = value.trim().toUpperCase();
        if (v === 'NONE' || v === 'STATUS' || v === 'LOGFILE' || v === 'ALL') draft.logtime = v;
        else draft.unknownKeys.push(raw);
        break;
      }
      case 'EXCLUDE':
      case 'INCLUDE': {
        for (const item of splitFilterValues(value)) {
          if (key === 'EXCLUDE' && /^STATISTICS$/i.test(item.trim())) {
            draft.excludeStatistics = true;
            continue;
          }
          const rule = filterRule(key, item);
          if (!rule) draft.unknownKeys.push(`${key}=${item}`);
          else if (rule.op === 'SUBQUERY' && !sqlAllowed) draft.warnings.push(`${key}=${item}: 서브쿼리 조건은 DBA 이상만 쓸 수 있어 채우지 않았습니다`);
          else draft.objectFilter.rules.push(rule);
        }
        break;
      }
      case 'QUERY': {
        const rule = queryRule(value);
        if (!rule) draft.unknownKeys.push(raw);
        else if (!sqlAllowed) draft.warnings.push(`${raw}: QUERY 조건은 DBA 이상만 쓸 수 있어 채우지 않았습니다`);
        else queries.push(rule);
        break;
      }
      default:
        if (EXPORT_ONLY.has(key)) break;
        // REMAP_*, TABLE_EXISTS_ACTION 등 Export에 없는 항목, SAMPLE/VIEWS_AS_TABLES/NETWORK_LINK 등 — 채우지 않고 보여 준다
        draft.unknownKeys.push(raw);
    }
  }
  if (queries.length > 0) draft.dataFilter = { queries };
  const kinds = [full, draft.schemas.length > 0, draft.tables.length > 0].filter(Boolean).length;
  if (kinds > 1) fail('FULL / SCHEMAS / TABLES가 함께 있어 모드를 정할 수 없습니다. parfile을 확인하세요.');
  draft.mode = draft.tables.length > 0 ? 'TABLE' : draft.schemas.length > 0 ? 'SCHEMA' : 'FULL';
  if (draft.mode === 'FULL' && !full) draft.warnings.push('SCHEMAS/TABLES/FULL이 없어 "덤프 전체"로 채웠습니다 (Export 기본은 접속 계정 스키마).');
  const dupSchemas = duplicates(draft.schemas);
  const dupTables = duplicates(draft.tables);
  if (dupSchemas.length + dupTables.length > 0) fail('같은 항목이 두 번 들어 있습니다.', [...dupSchemas, ...dupTables]);
  if (draft.tables.some((item) => !item.replace(/"[^"]*"/g, 'X').includes('.'))) draft.warnings.push('소유자 없는 테이블이 있습니다 — Import 폼의 테이블 소유자를 입력해야 합니다.');
  return draft;
}

// EXCLUDE=A,B:"..." 처럼 한 줄에 여러 개 — 따옴표 밖 쉼표로 나눈다
function splitFilterValues(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && !quote && depth === 0) {
      items.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function duplicates(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item) ? true : (seen.add(item), false)));
}

export function parseParfile(text: string, sqlAllowed: boolean): ImportDraft {
  if (!text.trim()) fail('parfile 내용이 비어 있습니다.');
  return draftFromEntries(parseParfileEntries(text), 'parfile', sqlAllowed);
}

// Export 로그 헤더: Starting "SYSTEM"."JOB":  system/******** directory=... tables=...
// parfile=만 있으면(파라미터가 로그에 없음) 읽을 수 없다. 앱이 DBMS_DATAPUMP로 돌린 작업도 명령줄이 없다.
export function parseExportLog(text: string, sqlAllowed: boolean): ImportDraft {
  const lines = logLines(text); // LOGTIME=ALL이면 줄 앞에 시각이 붙는다
  const index = lines.findIndex((line) => /^Starting ".+"\.".+":/.test(line.trim()));
  if (index < 0) fail('로그에서 "Starting ..." 줄을 찾지 못했습니다 (Export 로그가 맞는지 확인하세요).');
  // 명령줄이 길면 다음 줄로 이어진다 — 다음 진행 메시지(Processing/Estimate/Total 등)나 빈 줄 전까지
  let command = lines[index].trim().replace(/^Starting ".+"\.".+":\s*/, '');
  for (const next of lines.slice(index + 1)) {
    if (!next.trim() || /^(Processing|Estimate|Total|Exporting|\. \.|W-|Master table|ORA-|Dump file)/.test(next.trim())) break;
    command += ` ${next.trim()}`;
  }
  const entries = parseCommandLine(command);
  if (entries.some((entry) => entry.key === 'PARFILE')) fail('로그에는 parfile 이름만 있고 파라미터가 없습니다. parfile을 붙여넣거나 올려 주세요.');
  if (!entries.some((entry) => ['SCHEMAS', 'TABLES', 'FULL', 'DUMPFILE', 'DIRECTORY'].includes(entry.key))) {
    fail('로그 헤더에 Export 파라미터가 없습니다 (앱에서 실행한 작업은 "작업 이력"에서 가져오세요).');
  }
  return draftFromEntries(entries, '로그 헤더', sqlAllowed);
}

// 앱이 남긴 Export 요청(DataPumpRequest) → Import 폼 값. 스키마별로 나눠 실행한 하위 작업은 그 작업의 소유자만(runOwners).
export function draftFromRequest(request: DataPumpRequest, row: { directory: string; dumpfile: string | null }, runOwners: Set<string> | null, sqlAllowed: boolean): ImportDraft {
  const draft = draftFromEntries([], '작업 이력 (저장된 요청)', sqlAllowed);
  draft.warnings = [];
  draft.directory = row.directory;
  draft.dumpfile = row.dumpfile;
  draft.parallel = request.parallel ?? null;
  draft.content = request.content ?? null;
  draft.excludeStatistics = request.excludeStatistics ?? null;
  draft.metrics = request.metrics ?? null;
  draft.logtime = request.logtime ?? null;
  draft.objectFilter = request.objectFilter ?? { rules: [] };
  if (request.objectFilter?.rules.some((rule) => rule.op === 'SUBQUERY') && !sqlAllowed) {
    draft.objectFilter = { rules: request.objectFilter.rules.filter((rule) => rule.op !== 'SUBQUERY') };
    draft.warnings.push('서브쿼리 조건은 DBA 이상만 쓸 수 있어 채우지 않았습니다');
  }
  const queries = request.dataFilter?.queries ?? [];
  if (queries.length > 0) {
    if (sqlAllowed) draft.dataFilter = { queries };
    else draft.warnings.push(`QUERY ${queries.length}개는 DBA 이상만 쓸 수 있어 채우지 않았습니다`);
  }
  if ((request.dataFilter?.samples ?? []).length > 0) draft.unknownKeys.push('SAMPLE (Export에서 일부 행만 내보냄 — Import에는 해당 없음)');
  if (request.mode === 'SCHEMA') {
    draft.mode = 'SCHEMA';
    draft.schemas = (request.schemas ?? []).map((name) => sqlName(parseIdentifier(name, '스키마')));
    return draft;
  }
  draft.mode = 'TABLE';
  const pairs =
    request.qualifiedTables && request.qualifiedTables.length > 0
      ? request.qualifiedTables.map((pair) => ({ owner: parseIdentifier(pair.owner, '소유자'), table: parseIdentifier(pair.table, '테이블') }))
      : (request.tables ?? []).map((table) => ({ owner: parseIdentifier(request.tableOwner, '소유자'), table: parseIdentifier(table, '테이블') }));
  const views = (request.dataFilter?.viewsAsTables ?? []).map((view) => ({ owner: parseIdentifier(view.owner, '소유자'), table: parseIdentifier(view.view, '뷰') }));
  const partitionsOf = new Map<string, string[]>();
  const owners = [...new Set(pairs.map((pair) => pair.owner))];
  for (const entry of request.tablePartitions ?? []) {
    const owner = entry.owner ? parseIdentifier(entry.owner, '소유자') : owners[0];
    partitionsOf.set(`${owner}.${parseIdentifier(entry.table, '테이블')}`, entry.partitions.map((p) => parseIdentifier(p, '파티션')));
  }
  if ((request.partitions ?? []).length > 0 && pairs.length === 1) partitionsOf.set(`${pairs[0].owner}.${pairs[0].table}`, request.partitions!.map((p) => parseIdentifier(p, '파티션')));
  for (const pair of [...pairs, ...views].filter((item) => !runOwners || runOwners.has(item.owner))) {
    const parts = partitionsOf.get(`${pair.owner}.${pair.table}`);
    if (parts) draft.tables.push(...parts.map((p) => qualifiedName(pair.owner, pair.table, p)));
    else draft.tables.push(qualifiedName(pair.owner, pair.table));
  }
  return draft;
}

// 요청이 없는 이력(외부 작업 등): 대조용 대상 목록(OWNER.TABLE[:PART], 정확한 이름)이 있으면 그것, 없으면 SCHEMAS= 요약에서.
// 요약이 잘려 있으면(…) 전체 목록을 알 수 없으므로 거부한다.
export function draftFromHistory(row: { directory: string; dumpfile: string | null; jobMode: string; targetDesc: string | null; expected: string[] | null }, sqlAllowed: boolean): ImportDraft {
  const draft = draftFromEntries([], '작업 이력 (대상 목록)', sqlAllowed);
  draft.warnings = [];
  draft.directory = row.directory;
  draft.dumpfile = row.dumpfile;
  if (row.expected && row.expected.length > 0 && row.jobMode === 'TABLE') {
    draft.mode = 'TABLE';
    draft.tables = row.expected.map((key) => {
      const [table, partition] = key.split(':');
      const dot = table.indexOf('.');
      return qualifiedName(table.slice(0, dot), table.slice(dot + 1), partition ?? null);
    });
    return draft;
  }
  const schemas = row.targetDesc?.match(/SCHEMAS=([^/]+)/)?.[1]?.trim();
  if (row.jobMode === 'SCHEMA' && schemas && !schemas.includes('…')) {
    draft.mode = 'SCHEMA';
    draft.schemas = schemas.split(',').map((name) => sqlName(name.trim()));
    return draft;
  }
  fail('이 작업 이력에는 Export 대상 전체 목록이 남아 있지 않아 가져올 수 없습니다 (요약만 있거나 잘림). parfile이나 로그로 가져오세요.');
}

// 절대 규칙: 파싱한 항목과 폼에 채운 항목이 개수·내용 모두 같아야 한다 (다르면 채우지 않는다)
export function assertSameItems(parsed: string[], filled: string[]): void {
  const lost = parsed.filter((item) => !filled.includes(item));
  const extra = filled.filter((item) => !parsed.includes(item));
  if (parsed.length !== filled.length || lost.length > 0 || extra.length > 0) {
    fail(`Export ${parsed.length}개 → Import ${filled.length}개로 항목이 맞지 않아 채우지 않았습니다.`, [...lost.map((item) => `빠짐: ${item}`), ...extra.map((item) => `추가됨: ${item}`)]);
  }
}
