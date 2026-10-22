import { fail } from './dataPumpErrors';

// Data Pump에서 쓰는 Oracle 이름(스키마/테이블/파티션 등) 표기 규칙.
//  - 내부(계획, 키, DB 비교): DB에 저장된 정확한 이름 (MyTable, EMP)
//  - 요청(화면↔서버 왕복, DataPumpRequest)과 사용자 입력: SQL 식별자 표기 — 따옴표 없으면 대문자, "MyTable"이면 그대로
//  - parfile: 따옴표가 든 원소는 원소 전체를 작은따옴표로 감쌈 (값이 "로 시작하면 expdp가 따옴표를 벗긴다 — 23ai에서 확인)
// DBMS_DATAPUMP 필터(SCHEMA_EXPR/NAME_EXPR IN ('MyTable'), DATA_FILTER table_name)는 정확한 이름으로 비교한다 (확인).

// 따옴표 없는 일반 식별자 (대문자로 바꿔서 비교)
export const IDENTIFIER = /^[A-Z][A-Z0-9_$#]{0,127}$/;
// 따옴표 이름의 안쪽: 대소문자는 자유, 문자는 영문/숫자/_ $ # 만. 필터식('...')·parfile 목록(, : . ')·PL/SQL 구분자(; , : .)에
// 끼어들 문자는 받지 않는다 — 그런 이름은 화면에서 다룰 수 없다고 명시적으로 거부한다(조용히 빠지지 않게).
const QUOTED_BODY = /^[A-Za-z0-9_$#]{1,128}$/;

export function parseIdentifier(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const quoted = text.match(/^"(.*)"$/);
  if (quoted) {
    if (!QUOTED_BODY.test(quoted[1])) fail(`${label} 이름이 올바르지 않습니다 (따옴표 이름은 영문/숫자/_ $ #만): ${text}`);
    return quoted[1];
  }
  const upper = text.toUpperCase();
  if (!IDENTIFIER.test(upper)) fail(`${label} 이름이 올바르지 않습니다: ${String(value ?? '')}`);
  return upper;
}

// 정확한 이름 → SQL 표기 (일반 대문자 이름은 그대로, 그 외는 큰따옴표)
export function sqlName(name: string): string {
  return IDENTIFIER.test(name) ? name : `"${name}"`;
}

export function qualifiedName(owner: string, table: string, partition?: string | null): string {
  return `${sqlName(owner)}.${sqlName(table)}${partition ? `:${sqlName(partition)}` : ''}`;
}

// parfile 목록 원소 하나 (TABLES=, SCHEMAS=, REMAP_SCHEMA= 쌍)
export function parElement(text: string): string {
  return text.includes('"') ? `'${text}'` : text;
}

// parfile 값 → 원소 목록. 작은따옴표/큰따옴표 안의 쉼표는 구분자가 아니고, 원소를 감싼 작은따옴표는 벗긴다.
export function parseParList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let single = false;
  let double = false;
  for (const ch of value) {
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single) double = !double;
    if (ch === ',' && !single && !double) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((item) => item.trim().replace(/^'(.*)'$/, '$1')).filter((item) => item !== '');
}

// OWNER.TABLE[:PARTITION] (SQL 표기, 따옴표 가능) → 정확한 이름
export function parseQualified(text: string, label = '테이블'): { owner: string; table: string; partition: string | null } {
  const match = text.trim().match(/^("[^"]*"|[^".:]+)\.("[^"]*"|[^".:]+)(?::("[^"]*"|[^".:]+))?$/);
  if (!match) fail(`${label} 형식이 올바르지 않습니다: ${text}`);
  return {
    owner: parseIdentifier(match[1], `${label} 소유자`),
    table: parseIdentifier(match[2], label),
    partition: match[3] ? parseIdentifier(match[3], '파티션') : null,
  };
}

// 대문자(또는 입력한 그대로)로는 없지만 대소문자를 무시하면 있는 이름들 — "혹시 "MyTable"인가요?" 후보 (SQL 표기)
export function suggestByCase(name: string, candidates: string[]): string[] {
  if (candidates.includes(name)) return [];
  const upper = name.toUpperCase();
  return candidates.filter((candidate) => candidate !== name && candidate.toUpperCase() === upper).map(sqlName);
}

// 이미 정확한 이름인 값 (DB나 매니페스트에서 온 이름)을 검증만 하고 그대로 쓴다.
export function exactName(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value : '';
  if (!QUOTED_BODY.test(text)) fail(`${label} 이름이 올바르지 않습니다: ${String(value ?? '')}`);
  return text;
}
