import type { DataFilter, ObjectFilter, ObjectFilterRule } from '../../shared/lib/types';

// 오브젝트 필터 / 데이터 필터·옵션 화면 공용: 서버(services/dataPumpFilters.ts)와 같은 표와 요약 규칙.

export interface DataOptionInfo {
  name: string;
  label: string;
  operations: ('EXPORT' | 'IMPORT')[];
  since: number;
  networkImportOnly?: boolean;
}

// 서버의 DATA_OPTIONS 표와 같은 목록 (since = 지원 시작 버전)
export const DATA_OPTIONS: DataOptionInfo[] = [
  { name: 'GROUP_PARTITION_TABLE_DATA', label: '파티션 테이블 데이터를 한 번에 (파티션 정의가 달라도 import 가능)', operations: ['EXPORT', 'IMPORT'], since: 12.2 },
  { name: 'VERIFY_STREAM_FORMAT', label: '덤프에 쓰기 전에 스트림 형식 검증', operations: ['EXPORT'], since: 12.2 },
  { name: 'SKIP_CONSTRAINT_ERRORS', label: '제약조건 위반 행은 건너뛰고 계속 (external table 방식일 때만)', operations: ['IMPORT'], since: 11.1 },
  { name: 'DISABLE_APPEND_HINT', label: 'APPEND 힌트 끄기 (동시 작업이 같은 테이블에 쓸 때 잠금 대기 방지)', operations: ['IMPORT'], since: 11.2 },
  { name: 'REJECT_ROWS_WITH_REPL_CHAR', label: '문자셋 변환으로 대체 문자가 들어가는 행은 거부', operations: ['IMPORT'], since: 12.1 },
  { name: 'TRUST_EXISTING_TABLE_PARTITIONS', label: '기존 테이블 파티션에 병렬 적재 (파티션 정의가 원본과 같을 때, APPEND/TRUNCATE)', operations: ['IMPORT'], since: 12.2 },
  { name: 'VALIDATE_TABLE_DATA', label: 'NUMBER/DATE 데이터 검증', operations: ['IMPORT'], since: 18.0 },
  { name: 'ENABLE_NETWORK_COMPRESSION', label: '네트워크 압축 (DB 링크 Import 전용)', operations: ['IMPORT'], since: 12.2, networkImportOnly: true },
  { name: 'CONTINUE_LOAD_ON_FORMAT_ERROR', label: '스트림 형식 오류가 나면 다음 묶음부터 계속', operations: ['IMPORT'], since: 19.0 },
];

export const NAME_OPS: { value: ObjectFilterRule['op']; label: string }[] = [
  { value: 'ALL', label: '전체' },
  { value: '=', label: '=' },
  { value: '!=', label: '!=' },
  { value: 'IN', label: 'IN' },
  { value: 'NOT IN', label: 'NOT IN' },
  { value: 'LIKE', label: 'LIKE' },
  { value: 'NOT LIKE', label: 'NOT LIKE' },
  { value: 'SUBQUERY', label: '서브쿼리' },
];

export function hasIncludeRules(filter: ObjectFilter): boolean {
  return filter.rules.some((rule) => rule.kind === 'INCLUDE');
}

export function countDataFilter(filter: DataFilter): number {
  return (filter.queries?.length ?? 0) + (filter.samples?.length ?? 0) + (filter.dataOptions?.length ?? 0) + (filter.viewsAsTables?.length ?? 0);
}

function ruleText(rule: ObjectFilterRule): string {
  const values = rule.values ?? [];
  if (rule.op === 'ALL') return `${rule.kind} ${rule.path}`;
  if (rule.op === 'SUBQUERY') return `${rule.kind} ${rule.path} IN (${rule.subquery ?? ''})`;
  if (rule.op === 'IN' || rule.op === 'NOT IN') return `${rule.kind} ${rule.path} ${rule.op} (${values.join(', ')})`;
  return `${rule.kind} ${rule.path} ${rule.op} ${values[0] ?? ''}`;
}

// 실행 확인창에 보여줄 필터/옵션 요약 (SQL 조건은 원문 그대로)
export function describeFilters(objectFilter: ObjectFilter, dataFilter: DataFilter): string[] {
  const lines = objectFilter.rules.map(ruleText);
  for (const query of dataFilter.queries ?? []) lines.push(`QUERY ${query.table ? `${query.owner}.${query.table}` : '(모든 테이블)'}: ${query.where}`);
  for (const sample of dataFilter.samples ?? []) lines.push(`SAMPLE ${sample.table ? `${sample.owner}.${sample.table}` : '(모든 테이블)'}: ${sample.percent}%`);
  if ((dataFilter.dataOptions ?? []).length > 0) lines.push(`DATA_OPTIONS=${dataFilter.dataOptions!.join(',')}`);
  if ((dataFilter.viewsAsTables ?? []).length > 0) {
    lines.push(`VIEWS_AS_TABLES=${dataFilter.viewsAsTables!.map((view) => `${view.owner}.${view.view}${view.template ? `:${view.template}` : ''}`).join(',')}`);
  }
  return lines;
}

// 화면에서 쓰다 만(값이 빈) 규칙은 서버로 보내지 않는다.
export function cleanObjectFilter(filter: ObjectFilter): ObjectFilter {
  return {
    rules: filter.rules.filter(
      (rule) =>
        rule.path.trim() !== '' &&
        (rule.op === 'ALL' || (rule.op === 'SUBQUERY' ? !!rule.subquery?.trim() : (rule.values ?? []).some((value) => value.trim() !== '')))
    ),
  };
}

export function cleanDataFilter(filter: DataFilter): DataFilter {
  return {
    queries: (filter.queries ?? []).filter((query) => query.where.trim() !== ''),
    samples: (filter.samples ?? []).filter((sample) => Number(sample.percent) > 0),
    dataOptions: filter.dataOptions ?? [],
    viewsAsTables: filter.viewsAsTables ?? [],
  };
}

// "OWNER.TABLE" 입력 → { owner, table } (빈 칸이면 모든 테이블)
export function parseTarget(text: string): { owner: string | null; table: string | null } {
  const value = text.trim().toUpperCase();
  if (!value) return { owner: null, table: null };
  const [owner, table] = value.split('.');
  return table ? { owner, table } : { owner: null, table: owner };
}

export function targetText(owner?: string | null, table?: string | null): string {
  return table ? `${owner ? `${owner}.` : ''}${table}` : '';
}
