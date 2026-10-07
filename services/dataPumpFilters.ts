import { fail } from './dataPumpErrors';

// Data Pump 오브젝트 필터(INCLUDE/EXCLUDE)와 데이터 필터·옵션(QUERY, SAMPLE, DATA_OPTIONS, VIEWS_AS_TABLES).
// 화면이 보낸 규칙을 검증하고 DBMS_DATAPUMP 호출에 쓸 값과 parfile 줄로 바꾼다 (DB 접근 없는 순수 함수, 단위 테스트로 검증).
//
// 문서(Oracle 19c/21c DBMS_DATAPUMP, Data Pump Export/Import) 기준으로 정한 것:
//  - METADATA_FILTER의 NAME_EXPR는 같은 오브젝트 경로에 여러 개를 걸면 AND로 합쳐진다. 그래서 EXCLUDE 이름 조건은 "부정한
//    NAME_EXPR"로 바꿔 그냥 더하면 되고(합집합 제외), INCLUDE 이름 조건만 같은 유형끼리 하나의 식으로 합쳐야 한다(OR).
//  - INCLUDE와 EXCLUDE 동시 사용은 21c부터 (19c까지는 서로 배타적).
//  - SAMPLE은 Export 전용이고 네트워크(DB 링크) Export에는 쓸 수 없다.
//  - VIEWS_AS_TABLES는 테이블 모드에서만, 템플릿 테이블은 뷰와 같은 스키마.
//  - Export DATA_OPTIONS는 GROUP_PARTITION_TABLE_DATA, VERIFY_STREAM_FORMAT (19c 문서에 XML_CLOBS 없음).

export type FilterKind = 'INCLUDE' | 'EXCLUDE';
export type NameOp = 'ALL' | '=' | '!=' | 'IN' | 'NOT IN' | 'LIKE' | 'NOT LIKE' | 'SUBQUERY';
export type PathMode = 'SCHEMA' | 'TABLE' | 'DATABASE';

export interface ObjectFilterRule {
  kind: FilterKind;
  path: string; // 오브젝트 경로 (예: TABLE, INDEX, TABLE/INDEX)
  op: NameOp; // ALL = 그 유형 전체
  values?: string[]; // =, != 는 하나, IN/NOT IN은 여러 개, LIKE/NOT LIKE는 패턴 하나
  subquery?: string | null; // SUBQUERY: "SELECT ..." (IN (SELECT ...)로 쓰임)
}

export interface ObjectFilter {
  rules: ObjectFilterRule[];
}

export interface QueryRule {
  owner?: string | null; // 소유자·테이블 둘 다 비우면 모든 테이블
  table?: string | null;
  where: string; // WHERE ... 또는 ORDER BY ...
}

export interface SampleRule {
  owner?: string | null;
  table?: string | null;
  percent: number;
}

export interface ViewAsTable {
  owner: string;
  view: string;
  template?: string | null; // 같은 스키마의 템플릿 테이블
}

export interface DataFilter {
  queries?: QueryRule[];
  samples?: SampleRule[];
  dataOptions?: string[];
  viewsAsTables?: ViewAsTable[];
}

export interface PathInfo {
  path: string;
  named: boolean; // 이름 조건(NAME_EXPR)을 걸 수 있는 유형인지
  comments: string;
}

// 대상 DB 정보 — 버전별 허용 여부와 오브젝트 경로 허용 목록 (없으면 그 검사는 건너뛴다: 단위 테스트 등).
export interface FilterEnv {
  versionNumber: number; // 19.0, 12.2, 23.0 …
  paths: Record<PathMode, PathInfo[]>;
  allowSql: boolean; // QUERY/서브쿼리 같은 SQL 조건을 써도 되는 사용자(DBA 이상)인지
}

// DATA_OPTIONS — 화면은 이름만 보내고, PL/SQL은 이 표의 상수만 더한다 (버전에 없는 상수를 참조하면 블록이 컴파일되지 않으므로
// 고른 것만 넣는다). since = 지원 시작 버전.
export const DATA_OPTIONS = [
  { name: 'GROUP_PARTITION_TABLE_DATA', constant: 'KU$_DATAOPT_GRP_PART_TAB', operations: ['EXPORT', 'IMPORT'], since: 12.2 },
  { name: 'VERIFY_STREAM_FORMAT', constant: 'KU$_DATAOPT_VERIFY_STREAM_FORM', operations: ['EXPORT'], since: 12.2 },
  { name: 'SKIP_CONSTRAINT_ERRORS', constant: 'KU$_DATAOPT_SKIP_CONST_ERR', operations: ['IMPORT'], since: 11.1 },
  { name: 'DISABLE_APPEND_HINT', constant: 'KU$_DATAOPT_DISABL_APPEND_HINT', operations: ['IMPORT'], since: 11.2 },
  { name: 'REJECT_ROWS_WITH_REPL_CHAR', constant: 'KU$_DATAOPT_REJECT_ROWS_REPCHR', operations: ['IMPORT'], since: 12.1 },
  { name: 'TRUST_EXISTING_TABLE_PARTITIONS', constant: 'KU$_DATAOPT_TRUST_EXIST_TB_PAR', operations: ['IMPORT'], since: 12.2 },
  { name: 'VALIDATE_TABLE_DATA', constant: 'KU$_DATAOPT_VALIDATE_TBL_DATA', operations: ['IMPORT'], since: 18.0 },
  { name: 'ENABLE_NETWORK_COMPRESSION', constant: 'KU$_DATAOPT_ENABLE_NET_COMP', operations: ['IMPORT'], since: 12.2, networkImportOnly: true },
  { name: 'CONTINUE_LOAD_ON_FORMAT_ERROR', constant: 'KU$_DATAOPT_CONT_LD_ON_FMT_ERR', operations: ['IMPORT'], since: 19.0 },
] as const;

const IDENT = /^[A-Z][A-Z0-9_$#]{0,127}$/;
const PATH = /^[A-Z0-9_/]+$/;
const LIKE_PATTERN = /^[A-Z0-9_$#%]{1,128}$/;
const MAX_SQL = 4000;
// SQL 조건에 들어가면 안 되는 키워드 (단어 경계 기준)
const FORBIDDEN_WORDS = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXECUTE', 'BEGIN', 'DECLARE'];

function ident(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!IDENT.test(text)) fail(`${label} 이름이 올바르지 않습니다: ${String(value ?? '')}`);
  return text;
}

// QUERY의 WHERE절과 오브젝트 필터의 서브쿼리 검사.
// 이 검사는 실수(문장 끝 세미콜론, 주석, DML 붙여넣기 등)를 막는 장치일 뿐 완전한 방어가 아니다 — 주 통제는 권한 제한(DBA 이상만
// SQL 조건 사용, 화면 권한)과 작업 시작 감사 로그다.
function checkSqlCondition(value: unknown, kind: 'WHERE' | 'SUBQUERY', label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) fail(`${label}: 조건이 비어 있습니다.`);
  if (text.length > MAX_SQL) fail(`${label}: 조건은 ${MAX_SQL}자 이하여야 합니다.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) fail(`${label}: 제어 문자는 쓸 수 없습니다.`);
  if (text.includes(';')) fail(`${label}: 세미콜론(;)은 쓸 수 없습니다.`);
  if (text.includes('--') || text.includes('/*')) fail(`${label}: 주석(--, /*)은 쓸 수 없습니다.`);
  if (text.includes('"')) fail(`${label}: 큰따옴표(")는 쓸 수 없습니다 (parfile 따옴표가 깨집니다).`);
  const upper = text.toUpperCase();
  if (kind === 'WHERE' && !/^(WHERE|ORDER\s+BY)\b/.test(upper)) fail(`${label}: WHERE 또는 ORDER BY로 시작해야 합니다.`);
  if (kind === 'SUBQUERY' && !/^SELECT\b/.test(upper)) fail(`${label}: SELECT로 시작해야 합니다.`);
  for (const word of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(upper)) fail(`${label}: ${word}는 쓸 수 없습니다.`);
  }
  return text;
}

function sqlAllowed(env: FilterEnv | null | undefined, label: string): void {
  if (env && !env.allowSql) fail(`${label}: SQL 조건은 DBA 이상만 쓸 수 있습니다.`);
}

const quote = (name: string) => `'${name}'`;
const inList = (names: string[]) => `(${names.map(quote).join(',')})`;

// 이름 조건 → NAME_EXPR 식. negate면 반대 조건 (EXCLUDE를 "이 조건이 아닌 것만"으로 바꿀 때).
function nameExpr(op: NameOp, values: string[], subquery: string | null, negate: boolean): string {
  switch (op) {
    case '=':
      return `${negate ? '!=' : '='} ${quote(values[0])}`;
    case '!=':
      return `${negate ? '=' : '!='} ${quote(values[0])}`;
    case 'IN':
      return `${negate ? 'NOT IN' : 'IN'} ${inList(values)}`;
    case 'NOT IN':
      return `${negate ? 'IN' : 'NOT IN'} ${inList(values)}`;
    case 'LIKE':
      return `${negate ? 'NOT LIKE' : 'LIKE'} ${quote(values[0])}`;
    case 'NOT LIKE':
      return `${negate ? 'LIKE' : 'NOT LIKE'} ${quote(values[0])}`;
    case 'SUBQUERY':
      return `${negate ? 'NOT IN' : 'IN'} (${subquery})`;
    default:
      return fail('이름 조건이 올바르지 않습니다.');
  }
}

interface CleanRule {
  kind: FilterKind;
  path: string;
  op: NameOp;
  values: string[];
  subquery: string | null;
}

export interface FilterContext {
  operation: 'EXPORT' | 'IMPORT';
  jobMode: 'SCHEMA' | 'TABLE' | 'FULL'; // 논리 모드 (여러 스키마 테이블 작업도 TABLE)
  networkLink: string | null;
  content: 'ALL' | 'METADATA_ONLY' | 'DATA_ONLY';
  tableExistsAction: string | null;
  excludeStatistics: boolean;
  multiSchemaTables: boolean; // 실행은 SCHEMA 모드 + 테이블만
  hasTables: boolean; // TABLE 모드에 테이블이 있는지 (뷰만 있는 작업이면 false)
  tableOwners: string[]; // TABLE 모드 작업의 테이블 소유자
}

// DBMS_DATAPUMP 호출과 parfile에 쓸 값
export interface CompiledFilters {
  includePaths: string[]; // INCLUDE_PATH_EXPR IN (...)
  excludePaths: string[]; // EXCLUDE_PATH_EXPR IN (...)
  nameFilters: { path: string; expr: string }[]; // METADATA_FILTER NAME_EXPR, object_path
  queries: { owner: string | null; table: string | null; where: string }[];
  samples: { owner: string | null; table: string | null; percent: number }[];
  dataOptions: string[];
  dataOptionConstants: string[]; // DBMS_DATAPUMP.KU$_DATAOPT_* 이름 (PL/SQL에서 더함)
  viewsAsTables: string[]; // OWNER.VIEW 또는 OWNER.VIEW:TEMPLATE
  excludeTablesOnly: boolean; // 뷰만 있는 테이블 모드 작업 (실제 테이블은 빼기 — METADATA_FILTER EXCLUDE_TABLES='Y')
  parfileLines: string[];
  summary: string[]; // 작업 이력 "대상" 요약
  audit: string[]; // 작업 시작 감사 로그 (SQL 조건 원문 포함)
  hasSql: boolean;
}

function pathModeOf(jobMode: FilterContext['jobMode']): PathMode {
  return jobMode === 'SCHEMA' ? 'SCHEMA' : jobMode === 'TABLE' ? 'TABLE' : 'DATABASE';
}

function cleanRules(filter: ObjectFilter | null | undefined, ctx: FilterContext, env: FilterEnv | null | undefined): CleanRule[] {
  const rules = Array.isArray(filter?.rules) ? filter!.rules : [];
  const mode = pathModeOf(ctx.jobMode);
  const known = env ? new Map(env.paths[mode].map((info) => [info.path, info])) : null;
  return rules.map((rule, index) => {
    const label = `오브젝트 필터 ${index + 1}번`;
    const kind = rule?.kind === 'INCLUDE' || rule?.kind === 'EXCLUDE' ? rule.kind : fail(`${label}: INCLUDE/EXCLUDE를 골라주세요.`);
    const path = typeof rule?.path === 'string' ? rule.path.trim().toUpperCase() : '';
    if (!PATH.test(path)) fail(`${label}: 오브젝트 유형이 올바르지 않습니다: ${String(rule?.path ?? '')}`);
    const info = known?.get(path);
    if (known && !info) fail(`${label}: ${path}는 ${mode} 모드에서 쓸 수 있는 오브젝트 유형이 아닙니다.`);
    const op = rule?.op ?? 'ALL';
    if (!['ALL', '=', '!=', 'IN', 'NOT IN', 'LIKE', 'NOT LIKE', 'SUBQUERY'].includes(op)) fail(`${label}: 이름 조건이 올바르지 않습니다.`);
    if (op !== 'ALL' && info && !info.named) fail(`${label}: ${path}는 이름으로 거를 수 없는 유형입니다 (전체만 가능).`);
    const raw = Array.isArray(rule?.values) ? rule.values : [];
    let values: string[] = [];
    let subquery: string | null = null;
    if (op === '=' || op === '!=') {
      if (raw.length !== 1) fail(`${label}: ${op}에는 이름 하나를 넣어주세요.`);
      values = [ident(raw[0], label)];
    } else if (op === 'IN' || op === 'NOT IN') {
      if (raw.length === 0) fail(`${label}: ${op}에는 이름을 하나 이상 넣어주세요.`);
      values = [...new Set(raw.map((value) => ident(value, label)))];
    } else if (op === 'LIKE' || op === 'NOT LIKE') {
      const pattern = typeof raw[0] === 'string' ? raw[0].trim().toUpperCase() : '';
      if (raw.length !== 1 || !LIKE_PATTERN.test(pattern)) fail(`${label}: LIKE 패턴은 영문 대문자/숫자/_ $ # % 로만 (따옴표 없이) 넣어주세요.`);
      values = [pattern];
    } else if (op === 'SUBQUERY') {
      sqlAllowed(env, label);
      subquery = checkSqlCondition(rule?.subquery, 'SUBQUERY', label);
    }
    return { kind, path, op, values, subquery };
  });
}

function compileFilters(
  objectFilter: ObjectFilter | null | undefined,
  dataFilter: DataFilter | null | undefined,
  ctx: FilterContext,
  env?: FilterEnv | null
): CompiledFilters {
  const rules = cleanRules(objectFilter, ctx, env);
  const includes = rules.filter((rule) => rule.kind === 'INCLUDE');
  const excludes = rules.filter((rule) => rule.kind === 'EXCLUDE');
  const isExport = ctx.operation === 'EXPORT';
  const networkImport = !isExport && ctx.networkLink !== null;
  const version = env?.versionNumber ?? null;

  // ── 오브젝트 필터 ──
  for (const path of new Set(includes.map((rule) => rule.path))) {
    if (excludes.some((rule) => rule.path === path)) fail(`${path}에 INCLUDE와 EXCLUDE 규칙을 같이 걸 수 없습니다.`);
  }
  if (includes.length > 0 && excludes.length > 0 && version !== null && version < 21) {
    fail(`INCLUDE와 EXCLUDE를 같이 쓰는 것은 Oracle 21c부터 됩니다 (이 DB는 ${version}).`);
  }
  if (includes.length > 0 && ctx.multiSchemaTables) {
    fail('여러 스키마의 테이블을 묶은 작업에는 INCLUDE를 쓸 수 없습니다 (스키마별로 나눠서 실행하세요).');
  }

  const includePaths: string[] = [];
  const excludePaths: string[] = [];
  const nameFilters: { path: string; expr: string }[] = [];
  const parfileLines: string[] = [];
  const summary: string[] = [];

  // INCLUDE: 유형별로 하나의 식 (같은 유형의 이름 조건은 OR로 합쳐야 해서 =/IN끼리만 합칠 수 있다).
  for (const path of [...new Set(includes.map((rule) => rule.path))]) {
    const own = includes.filter((rule) => rule.path === path);
    includePaths.push(path);
    if (own.some((rule) => rule.op === 'ALL')) {
      if (own.length > 1) fail(`INCLUDE ${path}: "전체"와 이름 조건을 같이 걸 수 없습니다.`);
      parfileLines.push(`INCLUDE=${path}`);
      continue;
    }
    const mergeable = own.filter((rule) => rule.op === '=' || rule.op === 'IN');
    const others = own.filter((rule) => rule.op !== '=' && rule.op !== 'IN');
    if (others.length + (mergeable.length > 0 ? 1 : 0) > 1) {
      fail(`INCLUDE ${path}: 같은 유형의 이름 조건은 =/IN끼리만 합칠 수 있습니다 (LIKE·NOT IN·서브쿼리는 유형당 하나).`);
    }
    const expr =
      mergeable.length > 0
        ? nameExpr('IN', [...new Set(mergeable.flatMap((rule) => rule.values))], null, false)
        : nameExpr(others[0].op, others[0].values, others[0].subquery, false);
    nameFilters.push({ path, expr });
    parfileLines.push(`INCLUDE=${path}:"${expr}"`);
  }

  // EXCLUDE: 전체면 경로 제외, 이름 조건이면 반대 조건의 NAME_EXPR (여러 개는 AND로 합쳐져 "어느 하나라도 맞으면 제외"가 된다).
  for (const rule of excludes) {
    if (rule.op === 'ALL') {
      if (!excludePaths.includes(rule.path)) excludePaths.push(rule.path);
      continue;
    }
    nameFilters.push({ path: rule.path, expr: nameExpr(rule.op, rule.values, rule.subquery, true) });
  }
  // parfile: 전체 제외는 유형마다 한 줄, 이름 조건은 원래 조건으로 (같은 유형의 =/IN은 하나로)
  for (const path of excludePaths) parfileLines.push(`EXCLUDE=${path}`);
  for (const path of [...new Set(excludes.filter((rule) => rule.op !== 'ALL').map((rule) => rule.path))]) {
    const own = excludes.filter((rule) => rule.path === path && rule.op !== 'ALL');
    const inValues = [...new Set(own.filter((rule) => rule.op === '=' || rule.op === 'IN').flatMap((rule) => rule.values))];
    if (inValues.length > 0) parfileLines.push(`EXCLUDE=${path}:"${nameExpr('IN', inValues, null, false)}"`);
    for (const rule of own.filter((item) => item.op !== '=' && item.op !== 'IN')) {
      parfileLines.push(`EXCLUDE=${path}:"${nameExpr(rule.op, rule.values, rule.subquery, false)}"`);
    }
  }

  // 통계 제외: INCLUDE가 있으면 포함 목록이 정하므로 (21c 미만에서는 같이 못 씀) 뺀다.
  const statsExcluded = ctx.excludeStatistics && !(includes.length > 0 && (version === null || version < 21));
  if (statsExcluded && !excludePaths.includes('STATISTICS')) {
    excludePaths.push('STATISTICS');
    parfileLines.push('EXCLUDE=STATISTICS');
  }

  // 여러 스키마 테이블 작업(SCHEMA 모드 실행)은 "테이블만": 스키마의 테이블이 아닌 최상위 유형을 EXCLUDE로 뺀다 (INCLUDE와 섞지 않아
  // 19c에서도 되게). parfile은 TABLES= 한 줄이라 여기 줄은 안 쓴다. 경로 목록이 없으면(테스트) INCLUDE TABLE로 대신한다.
  if (ctx.multiSchemaTables) {
    if (env) {
      const tableTop = new Set(env.paths.TABLE.filter((info) => !info.path.includes('/')).map((info) => info.path));
      for (const info of env.paths.SCHEMA) {
        if (info.path.includes('/') || tableTop.has(info.path) || info.path === 'TABLE' || info.path === 'TABLE_DATA') continue;
        if (!excludePaths.includes(info.path)) excludePaths.push(info.path);
      }
    } else {
      includePaths.push('TABLE');
    }
  }

  const describeRule = (rule: CleanRule) =>
    rule.op === 'ALL'
      ? rule.path
      : rule.op === 'IN' || rule.op === 'NOT IN'
        ? `${rule.path} ${rule.op}(${rule.values.length}개)`
        : rule.op === 'SUBQUERY'
          ? `${rule.path} 서브쿼리`
          : `${rule.path} ${rule.op} ${rule.values[0]}`;
  if (includes.length > 0) summary.push(`INCLUDE ${includes.map(describeRule).join(', ')}`);
  const excludeSummary = [...excludes.map(describeRule), ...(statsExcluded ? ['STATISTICS'] : [])];
  if (excludes.length > 0) summary.push(`EXCLUDE ${excludeSummary.join(', ')}`);

  // ── 데이터 필터 ──
  const data = dataFilter ?? {};
  const audit: string[] = [];
  let hasSql = rules.some((rule) => rule.op === 'SUBQUERY');
  for (const rule of rules.filter((item) => item.op === 'SUBQUERY')) audit.push(`${rule.kind} ${rule.path} IN (${rule.subquery})`);

  const target = (owner: unknown, table: unknown, label: string): { owner: string | null; table: string | null } => {
    const hasOwner = typeof owner === 'string' && owner.trim() !== '';
    const hasTable = typeof table === 'string' && table.trim() !== '';
    if (!hasOwner && !hasTable) return { owner: null, table: null };
    if (!hasTable || !hasOwner) fail(`${label}: 소유자와 테이블을 같이 지정하거나 "모든 테이블"로 두세요.`);
    return { owner: ident(owner, label), table: ident(table, label) };
  };
  const targetKey = (item: { owner: string | null; table: string | null }) => (item.table ? `${item.owner ?? ''}.${item.table}` : '*');

  const queries: CompiledFilters['queries'] = [];
  for (const [index, rule] of (Array.isArray(data.queries) ? data.queries : []).entries()) {
    const label = `QUERY ${index + 1}번`;
    if (ctx.content === 'METADATA_ONLY') fail(`${label}: CONTENT=METADATA_ONLY에는 QUERY를 쓸 수 없습니다.`);
    sqlAllowed(env, label);
    const where = checkSqlCondition(rule?.where, 'WHERE', label);
    const item = { ...target(rule?.owner, rule?.table, label), where };
    if (queries.some((existing) => targetKey(existing) === targetKey(item))) {
      fail(item.table ? `${label}: ${targetKey(item)}에 QUERY가 이미 있습니다.` : `${label}: "모든 테이블" QUERY는 하나만 쓸 수 있습니다.`);
    }
    queries.push(item);
    hasSql = true;
  }

  const samples: CompiledFilters['samples'] = [];
  for (const [index, rule] of (Array.isArray(data.samples) ? data.samples : []).entries()) {
    const label = `SAMPLE ${index + 1}번`;
    if (!isExport) fail(`${label}: SAMPLE은 Export에서만 쓸 수 있습니다.`);
    if (ctx.networkLink) fail(`${label}: SAMPLE은 DB 링크(NETWORK_LINK) Export에는 쓸 수 없습니다.`);
    if (ctx.content === 'METADATA_ONLY') fail(`${label}: CONTENT=METADATA_ONLY에는 SAMPLE을 쓸 수 없습니다.`);
    const percent = Number(rule?.percent);
    if (!Number.isFinite(percent) || percent < 0.000001 || percent >= 100) fail(`${label}: 비율은 0.000001 이상 100 미만이어야 합니다.`);
    const item = { ...target(rule?.owner, rule?.table, label), percent };
    if (samples.some((existing) => targetKey(existing) === targetKey(item))) fail(`${label}: 같은 대상에 SAMPLE이 이미 있습니다.`);
    samples.push(item);
  }

  const dataOptions: string[] = [];
  const dataOptionConstants: string[] = [];
  for (const raw of Array.isArray(data.dataOptions) ? data.dataOptions : []) {
    const name = String(raw).trim().toUpperCase();
    const option = DATA_OPTIONS.find((item) => item.name === name);
    if (!option) fail(`DATA_OPTIONS 값이 올바르지 않습니다: ${name}`);
    if (!(option.operations as readonly string[]).includes(ctx.operation)) fail(`DATA_OPTIONS=${name}는 ${ctx.operation}에서 쓸 수 없습니다.`);
    if (version !== null && version < option.since) fail(`DATA_OPTIONS=${name}는 Oracle ${option.since} 이상에서 됩니다 (이 DB는 ${version}).`);
    if ('networkImportOnly' in option && option.networkImportOnly && !networkImport) fail(`DATA_OPTIONS=${name}는 DB 링크 Import에서만 씁니다.`);
    if (name === 'TRUST_EXISTING_TABLE_PARTITIONS' && ctx.tableExistsAction !== 'APPEND' && ctx.tableExistsAction !== 'TRUNCATE') {
      fail('DATA_OPTIONS=TRUST_EXISTING_TABLE_PARTITIONS는 TABLE_EXISTS_ACTION이 APPEND/TRUNCATE일 때만 씁니다.');
    }
    if (!dataOptions.includes(name)) {
      dataOptions.push(name);
      dataOptionConstants.push(option.constant);
    }
  }

  const viewsAsTables: string[] = [];
  for (const [index, item] of (Array.isArray(data.viewsAsTables) ? data.viewsAsTables : []).entries()) {
    const label = `VIEWS_AS_TABLES ${index + 1}번`;
    if (!isExport && !networkImport) fail(`${label}: VIEWS_AS_TABLES는 Export와 DB 링크 Import에서만 씁니다.`);
    if (ctx.jobMode !== 'TABLE' || ctx.multiSchemaTables) fail(`${label}: VIEWS_AS_TABLES는 테이블 모드 작업에서만 쓸 수 있습니다 (스키마/전체 모드와 같이 못 씀).`);
    const owner = ident(item?.owner, label);
    const view = ident(item?.view, label);
    if (ctx.hasTables && !ctx.tableOwners.includes(owner)) fail(`${label}: 테이블과 같이 쓸 때는 뷰도 같은 스키마여야 합니다 (${ctx.tableOwners.join(', ')}).`);
    const template = item?.template ? ident(item.template, label) : null;
    const value = `${owner}.${view}${template ? `:${template}` : ''}`;
    if (!viewsAsTables.includes(value)) viewsAsTables.push(value);
  }

  if (queries.length > 0) {
    summary.push(`QUERY ${queries.length}개`);
    for (const query of queries) {
      parfileLines.push(query.table ? `QUERY=${query.owner ? `${query.owner}.` : ''}${query.table}:"${query.where}"` : `QUERY="${query.where}"`);
      audit.push(`QUERY ${query.table ? `${query.owner ?? ''}.${query.table}` : '(모든 테이블)'} ${query.where}`);
    }
  }
  if (samples.length > 0) {
    summary.push(samples.length === 1 && !samples[0].table ? `SAMPLE ${samples[0].percent}%` : `SAMPLE ${samples.length}개`);
    for (const sample of samples) {
      parfileLines.push(sample.table ? `SAMPLE=${sample.owner ? `${sample.owner}.` : ''}${sample.table}:${sample.percent}` : `SAMPLE=${sample.percent}`);
      audit.push(`SAMPLE ${sample.table ? `${sample.owner ?? ''}.${sample.table}` : '(모든 테이블)'} ${sample.percent}%`);
    }
  }
  if (dataOptions.length > 0) {
    summary.push(`DATA_OPTIONS=${dataOptions.join(',')}`);
    parfileLines.push(`DATA_OPTIONS=${dataOptions.join(',')}`);
    audit.push(`DATA_OPTIONS=${dataOptions.join(',')}`);
  }
  if (viewsAsTables.length > 0) {
    summary.push(`VIEWS_AS_TABLES ${viewsAsTables.length}개`);
    parfileLines.push(`VIEWS_AS_TABLES=${viewsAsTables.join(',')}`);
    audit.push(`VIEWS_AS_TABLES=${viewsAsTables.join(',')}`);
  }

  return {
    includePaths,
    excludePaths,
    nameFilters,
    queries,
    samples,
    dataOptions,
    dataOptionConstants,
    viewsAsTables,
    excludeTablesOnly: viewsAsTables.length > 0 && !ctx.hasTables,
    parfileLines,
    summary,
    audit,
    hasSql,
  };
}

// ── 분할 계획 크기 반영 ──

function likeToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[$#]/g, (ch) => `\\${ch}`).replace(/%/g, '.*').replace(/_/g, '.')}$`);
}

function nameMatches(op: NameOp, values: string[], name: string): boolean | null {
  switch (op) {
    case 'ALL':
      return true;
    case '=':
    case 'IN':
      return values.includes(name);
    case '!=':
    case 'NOT IN':
      return !values.includes(name);
    case 'LIKE':
      return likeToRegExp(values[0]).test(name);
    case 'NOT LIKE':
      return !likeToRegExp(values[0]).test(name);
    default:
      return null; // 서브쿼리 — 결과를 미리 알 수 없음
  }
}

// 테이블 하나에 대해 필터를 적용한 크기 비율 (0 = 데이터 안 나감, 1 = 그대로, SAMPLE이면 그 비율).
// approx = 서브쿼리/QUERY처럼 미리 알 수 없는 조건이 걸려 실제와 다를 수 있음.
function tableSizeFactor(objectFilter: ObjectFilter | null | undefined, dataFilter: DataFilter | null | undefined, owner: string, table: string): { factor: number; approx: boolean } {
  const rules = (objectFilter?.rules ?? []).map((rule) => ({
    ...rule,
    path: String(rule.path ?? '').toUpperCase(),
    values: (rule.values ?? []).map((value) => String(value).toUpperCase()),
  }));
  let approx = false;
  const tableRules = rules.filter((rule) => rule.path === 'TABLE' || rule.path === 'TABLE_DATA');
  const includes = rules.filter((rule) => rule.kind === 'INCLUDE');
  if (includes.length > 0) {
    const tableIncludes = includes.filter((rule) => rule.path === 'TABLE' || rule.path === 'TABLE_DATA');
    if (tableIncludes.length === 0) return { factor: 0, approx: false }; // INCLUDE에 TABLE이 없으면 데이터 0
    const matched = tableIncludes.map((rule) => nameMatches(rule.op, rule.values, table));
    if (matched.includes(null)) approx = true;
    else if (!matched.some(Boolean)) return { factor: 0, approx: false };
  }
  for (const rule of tableRules.filter((item) => item.kind === 'EXCLUDE')) {
    const matched = nameMatches(rule.op, rule.values, table);
    if (matched === null) approx = true;
    else if (matched) return { factor: 0, approx: false };
  }
  const samples = dataFilter?.samples ?? [];
  const sample =
    samples.find((item) => item.table && String(item.table).toUpperCase() === table && (!item.owner || String(item.owner).toUpperCase() === owner)) ??
    samples.find((item) => !item.table);
  if ((dataFilter?.queries ?? []).length > 0) approx = true;
  return { factor: sample ? Number(sample.percent) / 100 : 1, approx };
}

export { checkSqlCondition, compileFilters, tableSizeFactor };
