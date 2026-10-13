import * as objectCompareModel from '../models/objectCompareModel';
import { OBJECT_TYPES, SOURCE_TYPES, TEXT_TYPES } from '../models/objectCompareModel';
import type {
  ColumnInfo,
  IndexInfo,
  ObjectType,
  SchemaSnapshot,
  SequenceInfo,
  SynonymInfo,
  TableInfo,
  TablespaceInfo,
} from '../models/objectCompareModel';
import type { DbmsIdParam } from '../models/dbmsModel';

export type CompareResult = 'SAME' | 'DIFF' | 'ONLY_SOURCE' | 'ONLY_TARGET';

// 상세 화면의 한 줄. info=true면 참고용(예: 테이블스페이스 크기)이라 "다름" 판정에는 들어가지 않습니다.
export interface DiffRow {
  item: string;
  attribute: string;
  source: string | null;
  target: string | null;
  info?: boolean;
}

export interface CompareItem {
  type: ObjectType;
  name: string;
  result: CompareResult;
  summary: string;
  diffs: DiffRow[];
  // true면 소스 줄 단위 diff를 /objectCompare/sourceDiff 로 따로 조회할 수 있습니다.
  hasSourceDiff: boolean;
  // 어느 스키마 짝의 결과인지 (여러 스키마 비교). TABLESPACE는 DB 전체라 null.
  sourceSchema?: string | null;
  targetSchema?: string | null;
  // "다름"인 TABLE/INDEX/SEQUENCE/SYNONYM: 대상을 기준과 같게 맞추는 DDL (줄 단위, 위험한 것은 -- 주석).
  // VIEW/PL/SQL은 소스 diff를 받아 화면에서 CREATE OR REPLACE로 만든다.
  ddl?: string[];
}

export interface CompareSide {
  dbmsid: number | string;
  schema: string;
}

// 여러 스키마 비교의 한 짝: 기준 스키마 ↔ 대상 스키마 (보통 같은 이름)
export interface SchemaPair {
  source: string;
  target: string;
}

export class ObjectCompareValidationError extends Error {}

// 한 번에 비교할 수 있는 스키마 짝 수 (스키마마다 딕셔너리를 차례로 읽으므로 너무 많으면 오래 걸린다)
const MAX_PAIRS = 50;

export interface CompareOptions {
  // 테이블/인덱스가 놓인 테이블스페이스 이름 차이를 무시합니다 (운영/개발처럼 이름 체계가 다른 환경 비교용).
  ignoreTablespace?: boolean;
  // DDL에 쓸 스키마 (DDL은 대상 스키마에 실행, 시노님이 기준 스키마를 가리키면 대상 스키마로 바꿈). 없으면 스키마 없이.
  sourceSchema?: string | null;
  targetSchema?: string | null;
}

export interface CompareResponse {
  // schema는 표시용 (여러 스키마면 쉼표로 이은 목록). 짝별 스키마는 pairs와 항목의 sourceSchema/targetSchema.
  source: CompareSide & { dbname: string };
  target: CompareSide & { dbname: string };
  pairs: SchemaPair[];
  types: ObjectType[];
  items: CompareItem[];
}

export interface DiffLine {
  op: 'same' | 'del' | 'add';
  text: string;
  sourceLine: number | null;
  targetLine: number | null;
}

function rtrim(text: string): string {
  return text.replace(/[ \t\r\n]+$/, '');
}

function show(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

// 컬럼 데이터 타입을 DDL에 쓰는 형태로 만듭니다 (길이/정밀도 포함) — 예: VARCHAR2(20 CHAR), NUMBER(10,2).
// 문자 타입은 CHAR 시맨틱이면 CHAR_LENGTH, BYTE 시맨틱이면 DATA_LENGTH를 써야 캐릭터셋이 다른 DB끼리도
// (예: AL32UTF8 vs KO16MSWIN949) 같은 정의가 같게 나옵니다.
function formatDataType(column: ColumnInfo): string {
  const type = column.dataType;
  if (type === 'VARCHAR2' || type === 'CHAR') {
    return column.charUsed === 'C' ? `${type}(${column.charLength} CHAR)` : `${type}(${column.dataLength} BYTE)`;
  }
  if (type === 'NVARCHAR2' || type === 'NCHAR') {
    return `${type}(${column.charLength})`;
  }
  if (type === 'NUMBER') {
    if (column.precision === null && column.scale === null) return 'NUMBER';
    if (column.precision === null) return `NUMBER(*,${column.scale})`;
    return column.scale ? `NUMBER(${column.precision},${column.scale})` : `NUMBER(${column.precision})`;
  }
  if (type === 'FLOAT') {
    return column.precision === null ? 'FLOAT' : `FLOAT(${column.precision})`;
  }
  if (type === 'RAW') {
    return `RAW(${column.dataLength})`;
  }
  return type; // DATE, CLOB, BLOB, TIMESTAMP(6) 등은 DATA_TYPE에 이미 다 들어있음
}

// DATA_DEFAULT는 입력한 그대로(뒤 공백/개행 포함) 저장되고, "DEFAULT NULL"은 기본값 없음과 같습니다.
function normalizeDefault(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'NULL') return null;
  return trimmed;
}

function compareColumns(sourceColumns: ColumnInfo[], targetColumns: ColumnInfo[]): DiffRow[] {
  const diffs: DiffRow[] = [];
  const targetByName = new Map(targetColumns.map((column) => [column.name, column]));
  const sourceNames = new Set(sourceColumns.map((column) => column.name));

  for (const source of sourceColumns) {
    const target = targetByName.get(source.name);
    if (!target) {
      diffs.push({ item: source.name, attribute: '컬럼 없음 (대상)', source: formatDataType(source), target: null });
      continue;
    }
    const sourceType = formatDataType(source);
    const targetType = formatDataType(target);
    if (sourceType !== targetType) {
      diffs.push({ item: source.name, attribute: '데이터 타입/길이', source: sourceType, target: targetType });
    }
    if (source.nullable !== target.nullable) {
      diffs.push({
        item: source.name,
        attribute: 'NULL 허용',
        source: source.nullable === 'Y' ? 'NULL' : 'NOT NULL',
        target: target.nullable === 'Y' ? 'NULL' : 'NOT NULL',
      });
    }
    const sourceDefault = normalizeDefault(source.defaultValue);
    const targetDefault = normalizeDefault(target.defaultValue);
    if (sourceDefault !== targetDefault) {
      diffs.push({ item: source.name, attribute: '기본값', source: sourceDefault, target: targetDefault });
    }
  }
  for (const target of targetColumns) {
    if (!sourceNames.has(target.name)) {
      diffs.push({ item: target.name, attribute: '컬럼 없음 (기준)', source: null, target: formatDataType(target) });
    }
  }

  // 양쪽에 다 있는 컬럼끼리의 상대적 순서가 다르면 한 줄로 알려줍니다 (컬럼 추가로 인한 위치 밀림은 제외).
  const commonSource = sourceColumns.filter((column) => targetByName.has(column.name)).map((column) => column.name);
  const commonTarget = targetColumns.filter((column) => sourceNames.has(column.name)).map((column) => column.name);
  if (commonSource.join(',') !== commonTarget.join(',')) {
    diffs.push({ item: '(테이블)', attribute: '컬럼 순서', source: commonSource.join(', '), target: commonTarget.join(', ') });
  }
  return diffs;
}

function attributeDiffs(item: string, pairs: [attribute: string, source: unknown, target: unknown][]): DiffRow[] {
  const diffs: DiffRow[] = [];
  for (const [attribute, source, target] of pairs) {
    if (show(source) !== show(target)) {
      diffs.push({ item, attribute, source: show(source), target: show(target) });
    }
  }
  return diffs;
}

function compareTablespace(source: TablespaceInfo, target: TablespaceInfo): DiffRow[] {
  const diffs = attributeDiffs(source.name, [
    ['종류 (CONTENTS)', source.contents, target.contents],
    ['블록 크기', source.blockSize, target.blockSize],
    ['BIGFILE', source.bigfile, target.bigfile],
    ['익스텐트 관리', source.extentManagement, target.extentManagement],
    ['익스텐트 할당 방식', source.allocationType, target.allocationType],
    ['세그먼트 공간 관리', source.segmentSpaceManagement, target.segmentSpaceManagement],
    ['LOGGING', source.logging, target.logging],
    ['상태', source.status, target.status],
    ['자동 확장', source.autoextensible, target.autoextensible],
  ]);
  return [...diffs, ...tablespaceInfoRows(source, target)];
}

// 크기/파일 수는 환경마다 다른 게 정상이라 "다름"으로 치지 않고 참고로만 보여줍니다.
function tablespaceInfoRows(source: TablespaceInfo | null, target: TablespaceInfo | null): DiffRow[] {
  const name = (source ?? target)!.name;
  const mb = (value: number | null | undefined): string | null => (value == null ? null : `${value.toLocaleString('en-US')} MB`);
  return [
    { item: name, attribute: '데이터파일 수', source: show(source?.fileCount), target: show(target?.fileCount), info: true },
    { item: name, attribute: '현재 크기', source: mb(source?.sizeMb), target: mb(target?.sizeMb), info: true },
    { item: name, attribute: '최대 크기', source: mb(source?.maxSizeMb), target: mb(target?.maxSizeMb), info: true },
  ];
}

function compareTable(
  source: TableInfo,
  target: TableInfo,
  sourceColumns: ColumnInfo[],
  targetColumns: ColumnInfo[],
  options: CompareOptions
): DiffRow[] {
  const tableDiffs = attributeDiffs('(테이블)', [
    ['파티션 여부', source.partitioned, target.partitioned],
    ['임시 테이블 여부', source.temporary, target.temporary],
    ...(options.ignoreTablespace ? [] : ([['테이블스페이스', source.tablespace, target.tablespace]] as [string, unknown, unknown][])),
  ]);
  return [...compareColumns(sourceColumns, targetColumns), ...tableDiffs];
}

function compareIndex(source: IndexInfo, target: IndexInfo, options: CompareOptions): DiffRow[] {
  return attributeDiffs('(인덱스)', [
    ['테이블', source.table, target.table],
    ['컬럼', source.columns.join(', '), target.columns.join(', ')],
    ['UNIQUE 여부', source.uniqueness, target.uniqueness],
    ['인덱스 종류', source.indexType, target.indexType],
    ['파티션 여부', source.partitioned, target.partitioned],
    ...(options.ignoreTablespace ? [] : ([['테이블스페이스', source.tablespace, target.tablespace]] as [string, unknown, unknown][])),
  ]);
}

// 시스템이 이름을 붙인 인덱스(SYS_C00123 등)는 이름이 DB마다 달라서, "테이블(컬럼 목록)"으로 짝을 맞춥니다.
function indexKey(index: IndexInfo): string {
  return index.generated === 'Y' ? `(시스템 생성) ${index.table}(${index.columns.join(', ')})` : index.name;
}

function compareSequence(source: SequenceInfo, target: SequenceInfo): DiffRow[] {
  return attributeDiffs('(시퀀스)', [
    ['INCREMENT BY', source.incrementBy, target.incrementBy],
    ['MINVALUE', source.minValue, target.minValue],
    ['MAXVALUE', source.maxValue, target.maxValue],
    ['CYCLE', source.cycle, target.cycle],
    ['ORDER', source.order, target.order],
    ['CACHE', source.cacheSize, target.cacheSize],
  ]);
}

// ── 차이 DDL: 대상을 기준과 같게 맞추는 문장 (DB 접근 없는 순수 함수) ──
// 데이터를 지우거나(DROP COLUMN) 오래 걸리는(MOVE) 것은 -- 주석으로만 내고, 실패할 수 있는 것은 앞에 경고 주석을 붙인다.

const PLAIN_IDENTIFIER = /^[A-Z][A-Z0-9_$#]*$/;

// 대문자 일반 식별자는 그대로, 그 밖(소문자/특수문자)은 큰따옴표로 감싼다.
function quoteName(name: string): string {
  return PLAIN_IDENTIFIER.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function qualify(schema: string | null | undefined, name: string): string {
  return schema ? `${quoteName(schema)}.${quoteName(name)}` : quoteName(name);
}

// 컬럼 정의 (ADD/MODIFY용): 이름 타입 [DEFAULT 값]
function columnSpec(column: ColumnInfo, withDefault: boolean): string {
  const value = normalizeDefault(column.defaultValue);
  return `${quoteName(column.name)} ${formatDataType(column)}${withDefault && value !== null ? ` DEFAULT ${value}` : ''}`;
}

// 길이/정밀도를 비교할 수 있는 숫자 (문자 타입은 시맨틱에 맞는 길이)
function columnSize(column: ColumnInfo): number | null {
  if (['VARCHAR2', 'CHAR', 'NVARCHAR2', 'NCHAR'].includes(column.dataType)) return column.charUsed === 'C' || column.dataType.startsWith('N') ? column.charLength : column.dataLength;
  if (column.dataType === 'NUMBER' || column.dataType === 'FLOAT') return column.precision;
  if (column.dataType === 'RAW') return column.dataLength;
  return null;
}

function tableDdl(
  source: TableInfo,
  target: TableInfo,
  sourceColumns: ColumnInfo[],
  targetColumns: ColumnInfo[],
  options: CompareOptions
): string[] {
  const table = qualify(options.targetSchema, target.name);
  const ddl: string[] = [];
  const targetByName = new Map(targetColumns.map((column) => [column.name, column]));
  const sourceNames = new Set(sourceColumns.map((column) => column.name));

  for (const column of sourceColumns) {
    const existing = targetByName.get(column.name);
    if (!existing) {
      // NOT NULL 컬럼을 기본값 없이 추가하면 행이 있는 테이블에서 실패하므로 NULL로 추가하고 값을 채운 뒤 NOT NULL로.
      if (column.nullable === 'N' && normalizeDefault(column.defaultValue) === null) {
        ddl.push(`ALTER TABLE ${table} ADD (${columnSpec(column, true)});`);
        ddl.push(`-- ${column.name}: 기존 행에 값을 채운 뒤 NOT NULL로`);
        ddl.push(`ALTER TABLE ${table} MODIFY (${quoteName(column.name)} NOT NULL);`);
      } else {
        ddl.push(`ALTER TABLE ${table} ADD (${columnSpec(column, true)}${column.nullable === 'N' ? ' NOT NULL' : ''});`);
      }
      continue;
    }
    const sourceType = formatDataType(column);
    const targetType = formatDataType(existing);
    if (sourceType !== targetType) {
      const sourceSize = columnSize(column);
      const targetSize = columnSize(existing);
      if (column.dataType !== existing.dataType) {
        ddl.push(`-- ${column.name}: 타입 변경 (${targetType} → ${sourceType}) — 데이터가 있으면 실패할 수 있음`);
      } else if (sourceSize !== null && targetSize !== null && sourceSize < targetSize) {
        ddl.push(`-- ${column.name}: 길이 줄임 (${targetType} → ${sourceType}) — 더 긴 값이 있으면 실패`);
      }
      ddl.push(`ALTER TABLE ${table} MODIFY (${quoteName(column.name)} ${sourceType});`);
    }
    const sourceDefault = normalizeDefault(column.defaultValue);
    if (sourceDefault !== normalizeDefault(existing.defaultValue)) {
      ddl.push(`ALTER TABLE ${table} MODIFY (${quoteName(column.name)} DEFAULT ${sourceDefault ?? 'NULL'});`);
    }
    if (column.nullable !== existing.nullable) {
      if (column.nullable === 'N') ddl.push(`-- ${column.name}: NULL 값이 있으면 실패`);
      ddl.push(`ALTER TABLE ${table} MODIFY (${quoteName(column.name)} ${column.nullable === 'N' ? 'NOT NULL' : 'NULL'});`);
    }
  }
  for (const column of targetColumns) {
    if (sourceNames.has(column.name)) continue;
    ddl.push(`-- ${column.name}: 대상에만 있는 컬럼 — 지우려면 주석을 풀고 실행 (데이터가 삭제됨)`);
    ddl.push(`-- ALTER TABLE ${table} DROP COLUMN ${quoteName(column.name)};`);
  }

  const commonSource = sourceColumns.filter((column) => targetByName.has(column.name)).map((column) => column.name);
  const commonTarget = targetColumns.filter((column) => sourceNames.has(column.name)).map((column) => column.name);
  if (commonSource.join(',') !== commonTarget.join(',')) ddl.push('-- 컬럼 순서가 다름: ALTER로는 바꿀 수 없음 (테이블을 다시 만들어야 함)');
  if (show(source.partitioned) !== show(target.partitioned)) ddl.push('-- 파티션 여부가 다름: ALTER로는 바꿀 수 없음 (DBMS_REDEFINITION 또는 재생성)');
  if (show(source.temporary) !== show(target.temporary)) ddl.push('-- 임시 테이블 여부가 다름: 테이블을 다시 만들어야 함');
  if (!options.ignoreTablespace && source.tablespace && show(source.tablespace) !== show(target.tablespace)) {
    ddl.push('-- 테이블스페이스가 다름 — 옮기려면 주석을 풀고 실행 (테이블이 잠기고, 인덱스는 다시 빌드해야 함)');
    ddl.push(`-- ALTER TABLE ${table} MOVE TABLESPACE ${quoteName(source.tablespace)};`);
  }
  return ddl;
}

// 인덱스 컬럼: 일반 컬럼명(+ DESC)은 이름 규칙대로, 함수 기반 표현식은 그대로.
function indexColumn(expression: string): string {
  const match = expression.match(/^(.+?)( DESC)?$/);
  const base = match?.[1] ?? expression;
  return PLAIN_IDENTIFIER.test(base) ? `${base}${match?.[2] ?? ''}` : expression;
}

function indexDdl(source: IndexInfo, target: IndexInfo, options: CompareOptions): string[] {
  if (source.generated === 'Y' || target.generated === 'Y') {
    return ['-- 제약조건(PK/UNIQUE)이 만든 인덱스: 인덱스가 아니라 제약조건으로 맞추세요'];
  }
  if (source.partitioned === 'YES' || target.partitioned === 'YES') {
    return ['-- 파티션 인덱스: 파티션 정의까지 필요해 DDL을 만들지 않음 (기준 DB에서 DBMS_METADATA.GET_DDL로 확인)'];
  }
  const kind = source.indexType.includes('BITMAP') ? 'BITMAP ' : source.uniqueness === 'UNIQUE' ? 'UNIQUE ' : '';
  if (!/NORMAL|BITMAP/.test(source.indexType)) {
    return [`-- ${source.indexType} 인덱스: DDL을 만들지 않음 (기준 DB에서 DBMS_METADATA.GET_DDL로 확인)`];
  }
  const tablespace = !options.ignoreTablespace && source.tablespace ? ` TABLESPACE ${quoteName(source.tablespace)}` : '';
  return [
    '-- 다시 만드는 동안 이 인덱스를 쓰는 쿼리가 느려질 수 있음',
    `DROP INDEX ${qualify(options.targetSchema, target.name)};`,
    `CREATE ${kind}INDEX ${qualify(options.targetSchema, target.name)} ON ${qualify(options.targetSchema, source.table)} (${source.columns.map(indexColumn).join(', ')})${tablespace};`,
  ];
}

function sequenceDdl(source: SequenceInfo, target: SequenceInfo, options: CompareOptions): string[] {
  const clauses: string[] = [];
  if (show(source.incrementBy) !== show(target.incrementBy)) clauses.push(`INCREMENT BY ${source.incrementBy}`);
  if (show(source.minValue) !== show(target.minValue)) clauses.push(`MINVALUE ${source.minValue}`);
  if (show(source.maxValue) !== show(target.maxValue)) clauses.push(`MAXVALUE ${source.maxValue}`);
  if (show(source.cycle) !== show(target.cycle)) clauses.push(source.cycle === 'Y' ? 'CYCLE' : 'NOCYCLE');
  if (show(source.order) !== show(target.order)) clauses.push(source.order === 'Y' ? 'ORDER' : 'NOORDER');
  if (show(source.cacheSize) !== show(target.cacheSize)) clauses.push(Number(source.cacheSize) > 0 ? `CACHE ${source.cacheSize}` : 'NOCACHE');
  return clauses.length > 0 ? [`ALTER SEQUENCE ${qualify(options.targetSchema, target.name)} ${clauses.join(' ')};`] : [];
}

// 시노님이 가리키는 대상에서 "자기 스키마." 접두어를 (자기 스키마)로 바꿔, 스키마 이름이 다른 짝끼리도 비교되게 한다.
function ownSchemaTarget(target: string, schema: string | null | undefined): string {
  return schema && target.startsWith(`${schema}.`) ? `(자기 스키마).${target.slice(schema.length + 1)}` : target;
}

// 시노님이 기준 스키마 자신의 오브젝트를 가리키면 대상 쪽에서는 대상 스키마의 같은 오브젝트를 가리키게 한다.
function synonymDdl(source: SynonymInfo, target: SynonymInfo, options: CompareOptions): string[] {
  let pointsTo = source.target;
  if (options.sourceSchema && options.targetSchema && pointsTo.startsWith(`${options.sourceSchema}.`)) {
    pointsTo = `${options.targetSchema}.${pointsTo.slice(options.sourceSchema.length + 1)}`;
  }
  return [`CREATE OR REPLACE SYNONYM ${qualify(options.targetSchema, target.name)} FOR ${pointsTo};`];
}

// 뷰/MView 정의 비교용: 줄 끝 공백과 맨 끝 빈 줄은 무시합니다.
function normalizeText(text: string): string {
  const lines = text.split(/\r?\n/).map(rtrim);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function sortedKeys<T>(source: Map<string, T>, target: Map<string, T>): string[] {
  return Array.from(new Set([...source.keys(), ...target.keys()])).sort();
}

// 양쪽을 키로 짝지어 SAME/DIFF/ONLY_* 항목을 만듭니다. describe는 양쪽에 다 있을 때만 호출됩니다.
function pairUp<T>(
  type: ObjectType,
  source: Map<string, T>,
  target: Map<string, T>,
  describe: (source: T, target: T) => { diffs: DiffRow[]; summary?: string; hasSourceDiff?: boolean; ddl?: () => string[] },
  onlyOneSide?: (source: T | null, target: T | null) => DiffRow[]
): CompareItem[] {
  return sortedKeys(source, target).map((name) => {
    const left = source.get(name);
    const right = target.get(name);
    if (left === undefined || right === undefined) {
      return {
        type,
        name,
        result: left === undefined ? 'ONLY_TARGET' : 'ONLY_SOURCE',
        summary: left === undefined ? '대상에만 있음' : '기준에만 있음',
        diffs: onlyOneSide ? onlyOneSide(left ?? null, right ?? null) : [],
        hasSourceDiff: false,
      };
    }
    const { diffs, summary, hasSourceDiff, ddl } = describe(left, right);
    const realDiffs = diffs.filter((diff) => !diff.info);
    const isDiff = realDiffs.length > 0 || !!hasSourceDiff;
    return {
      type,
      name,
      result: isDiff ? 'DIFF' : 'SAME',
      summary: summary ?? (isDiff ? `${realDiffs.length}건 차이` : '동일'),
      diffs,
      hasSourceDiff: !!hasSourceDiff,
      // DDL은 "다름"일 때만 만든다 (동일한 항목에 빈 배열을 싣지 않게)
      ...(isDiff && ddl ? { ddl: ddl() } : {}),
    };
  });
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(key(row));
    if (list) list.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

function statusNote(type: string, name: string, source: SchemaSnapshot, target: SchemaSnapshot): string {
  const key = `${type}\u0000${name}`;
  const notes: string[] = [];
  if (source.statuses[key] && source.statuses[key] !== 'VALID') notes.push(`기준 ${source.statuses[key]}`);
  if (target.statuses[key] && target.statuses[key] !== 'VALID') notes.push(`대상 ${target.statuses[key]}`);
  return notes.length > 0 ? ` [${notes.join(', ')}]` : '';
}

// 두 스냅샷을 비교해 타입 순서(OBJECT_TYPES) → 이름 순으로 정렬된 결과를 만듭니다. DB 접근이 없는 순수 함수입니다.
function compareSnapshots(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  types: ObjectType[],
  options: CompareOptions = {}
): CompareItem[] {
  const items: CompareItem[] = [];
  const byName = <T extends { name: string }>(rows: T[]): Map<string, T> => new Map(rows.map((row) => [row.name, row]));

  for (const type of OBJECT_TYPES) {
    if (!types.includes(type)) continue;

    if (type === 'TABLESPACE') {
      items.push(
        ...pairUp(
          type,
          byName(source.tablespaces),
          byName(target.tablespaces),
          (left, right) => ({ diffs: compareTablespace(left, right) }),
          tablespaceInfoRows
        )
      );
    } else if (type === 'TABLE') {
      const sourceColumns = groupBy(source.columns, (column) => column.table);
      const targetColumns = groupBy(target.columns, (column) => column.table);
      items.push(
        ...pairUp(type, byName(source.tables), byName(target.tables), (left, right) => ({
          diffs: compareTable(left, right, sourceColumns.get(left.name) ?? [], targetColumns.get(right.name) ?? [], options),
          ddl: () => tableDdl(left, right, sourceColumns.get(left.name) ?? [], targetColumns.get(right.name) ?? [], options),
        }))
      );
    } else if (type === 'INDEX') {
      const keyed = (rows: IndexInfo[]): Map<string, IndexInfo> => new Map(rows.map((row) => [indexKey(row), row]));
      items.push(
        ...pairUp(type, keyed(source.indexes), keyed(target.indexes), (left, right) => ({
          diffs: compareIndex(left, right, options),
          ddl: () => indexDdl(left, right, options),
        }))
      );
    } else if (type === 'SEQUENCE') {
      items.push(
        ...pairUp(type, byName(source.sequences), byName(target.sequences), (left, right) => ({
          diffs: compareSequence(left, right),
          ddl: () => sequenceDdl(left, right, options),
        }))
      );
    } else if (type === 'SYNONYM') {
      items.push(
        ...pairUp(type, byName(source.synonyms), byName(target.synonyms), (left, right) => ({
          // 각자 자기 스키마의 오브젝트를 가리키면(HR.EMP ↔ HR2.EMP, 스키마 이름이 다른 짝) 같은 것으로 본다.
          diffs:
            ownSchemaTarget(left.target, options.sourceSchema) === ownSchemaTarget(right.target, options.targetSchema)
              ? []
              : attributeDiffs('(시노님)', [['가리키는 대상', left.target, right.target]]),
          ddl: () => synonymDdl(left, right, options),
        }))
      );
    } else if (SOURCE_TYPES.includes(type)) {
      const ofType = (snapshot: SchemaSnapshot) => byName(snapshot.sourceHashes.filter((row) => row.type === type));
      items.push(
        ...pairUp(type, ofType(source), ofType(target), (left, right) => {
          const differs = left.lines !== right.lines || left.hash !== right.hash;
          const note = statusNote(type, left.name, source, target);
          return {
            diffs: [],
            hasSourceDiff: differs,
            summary: (differs ? `소스 다름 (기준 ${left.lines}줄 / 대상 ${right.lines}줄)` : '동일') + note,
          };
        })
      );
    } else if (TEXT_TYPES.includes(type)) {
      const ofType = (snapshot: SchemaSnapshot) => byName(snapshot.textObjects.filter((row) => row.type === type));
      items.push(
        ...pairUp(type, ofType(source), ofType(target), (left, right) => {
          const differs = normalizeText(left.text) !== normalizeText(right.text);
          const note = statusNote(type, left.name, source, target);
          return { diffs: [], hasSourceDiff: differs, summary: (differs ? '정의(쿼리) 다름' : '동일') + note };
        })
      );
    }
  }
  return items;
}

// 이보다 편집 거리가 크면(= 거의 다른 파일) 정밀 diff를 포기하고 "전부 삭제 후 전부 추가"로 보여줍니다.
// Myers 알고리즘의 역추적 메모리가 편집 거리의 제곱에 비례하기 때문입니다.
const MAX_EDIT_DISTANCE = 3000;

// Myers O(ND) diff. a를 b로 바꾸는 최소 편집 스크립트를 'same'/'del'/'add' 순서열로 돌려줍니다.
function myers(a: string[], b: string[]): ('same' | 'del' | 'add')[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    // 이번 라운드 시작 시점의 v(= 이전 라운드 결과) 중 역추적에 필요한 대각선 범위만 저장합니다.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const ops: ('same' | 'del' | 'add')[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number): number => prev[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('same');
      x--;
      y--;
    }
    ops.push(x === prevX ? 'add' : 'del');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push('same');
    x--;
    y--;
  }
  return ops.reverse();
}

// 두 소스를 줄 단위로 비교합니다. 줄 끝 공백/개행 차이는 무시합니다 (목록 비교의 해시와 같은 기준).
function diffLines(sourceLines: string[], targetLines: string[]): DiffLine[] {
  const a = sourceLines.map(rtrim);
  const b = targetLines.map(rtrim);

  // 앞뒤 공통 부분을 먼저 잘라내면 대부분의 경우 실제로 비교할 범위가 아주 작아집니다.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const ops =
    myers(middleA, middleB) ?? [...middleA.map(() => 'del' as const), ...middleB.map(() => 'add' as const)];

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  const same = (): void => {
    lines.push({ op: 'same', text: a[i], sourceLine: i + 1, targetLine: j + 1 });
    i++;
    j++;
  };
  while (i < start) same();
  for (const op of ops) {
    if (op === 'same') same();
    else if (op === 'del') {
      lines.push({ op: 'del', text: a[i], sourceLine: i + 1, targetLine: null });
      i++;
    } else {
      lines.push({ op: 'add', text: b[j], sourceLine: null, targetLine: j + 1 });
      j++;
    }
  }
  while (i < a.length) same();
  return lines;
}

function parseTypes(types: unknown): ObjectType[] {
  if (!Array.isArray(types) || types.length === 0) return [...OBJECT_TYPES];
  return OBJECT_TYPES.filter((type) => types.includes(type));
}

async function getSchemas(dbmsid: DbmsIdParam): Promise<string[]> {
  try {
    return await objectCompareModel.getSchemas(dbmsid);
  } catch (error) {
    throw new Error('스키마 목록 조회 실패', { cause: error });
  }
}

// 스키마 짝 목록 검증: 1~MAX_PAIRS개, 이름이 비지 않고, 한쪽에서 같은 스키마가 두 짝에 나오지 않으며,
// 같은 DB 안에서 자기 자신과 비교하는 짝은 없어야 한다.
function parsePairs(value: unknown, sameDbms: boolean): SchemaPair[] {
  const fail = (message: string): never => {
    throw new ObjectCompareValidationError(message);
  };
  if (!Array.isArray(value) || value.length === 0) fail('비교할 스키마를 하나 이상 골라주세요.');
  const list = value as unknown[];
  if (list.length > MAX_PAIRS) fail(`한 번에 ${MAX_PAIRS}개 스키마까지 비교할 수 있습니다 (${list.length}개 선택).`);
  const pairs = list.map((item, index) => {
    const { source, target } = (item ?? {}) as Record<string, unknown>;
    if (typeof source !== 'string' || !source.trim() || typeof target !== 'string' || !target.trim()) {
      fail(`${index + 1}번째 짝의 기준/대상 스키마를 골라주세요.`);
    }
    return { source: String(source).trim(), target: String(target).trim() };
  });
  const duplicated = (names: string[]) => names.find((name, index) => names.indexOf(name) !== index);
  const dupSource = duplicated(pairs.map((pair) => pair.source));
  if (dupSource) fail(`기준 스키마 ${dupSource}가 두 짝에 들어 있습니다.`);
  const dupTarget = duplicated(pairs.map((pair) => pair.target));
  if (dupTarget) fail(`대상 스키마 ${dupTarget}가 두 짝에 들어 있습니다.`);
  const self = sameDbms ? pairs.find((pair) => pair.source === pair.target) : undefined;
  if (self) fail(`같은 DB에서 ${self.source}를 자기 자신과 비교할 수는 없습니다. 대상 스키마를 바꿔주세요.`);
  return pairs;
}

// 여러 스키마 짝을 한 번에 비교합니다. DB마다 커넥션 하나로 스키마를 차례로 읽고(두 DB끼리는 동시에),
// 짝마다 compareSnapshots로 비교해 항목에 스키마를 붙입니다. TABLESPACE는 DB 전체라 한 번만 비교합니다.
async function compareSchemaPairs(
  sourceDbmsid: number | string,
  targetDbmsid: number | string,
  pairsInput: unknown,
  types: unknown,
  options: CompareOptions = {}
): Promise<CompareResponse> {
  const pairs = parsePairs(pairsInput, String(sourceDbmsid) === String(targetDbmsid));
  const selected = parseTypes(types);
  let sourceSide: { dbname: string; snapshots: Map<string, SchemaSnapshot> };
  let targetSide: { dbname: string; snapshots: Map<string, SchemaSnapshot> };
  try {
    [sourceSide, targetSide] = await Promise.all([
      objectCompareModel.getSnapshots({ dbmsid: sourceDbmsid }, pairs.map((pair) => pair.source), selected),
      objectCompareModel.getSnapshots({ dbmsid: targetDbmsid }, pairs.map((pair) => pair.target), selected),
    ]);
  } catch (error) {
    throw new Error('오브젝트 정보 조회 실패', { cause: error });
  }

  const items: CompareItem[] = [];
  const first = pairs[0];
  if (selected.includes('TABLESPACE')) {
    const tablespaceItems = compareSnapshots(sourceSide.snapshots.get(first.source)!, targetSide.snapshots.get(first.target)!, ['TABLESPACE'], options);
    items.push(...tablespaceItems.map((item) => ({ ...item, sourceSchema: null, targetSchema: null })));
  }
  const schemaTypes = selected.filter((type) => type !== 'TABLESPACE');
  for (const pair of pairs) {
    const pairItems = compareSnapshots(sourceSide.snapshots.get(pair.source)!, targetSide.snapshots.get(pair.target)!, schemaTypes, {
      ...options,
      sourceSchema: pair.source,
      targetSchema: pair.target,
    });
    items.push(...pairItems.map((item) => ({ ...item, sourceSchema: pair.source, targetSchema: pair.target })));
  }
  return {
    source: { dbmsid: sourceDbmsid, schema: pairs.map((pair) => pair.source).join(', '), dbname: sourceSide.dbname },
    target: { dbmsid: targetDbmsid, schema: pairs.map((pair) => pair.target).join(', '), dbname: targetSide.dbname },
    pairs,
    types: selected,
    items,
  };
}

// 스키마 하나 ↔ 하나 (compareSchemaPairs의 줄임)
async function compareSchemas(source: CompareSide, target: CompareSide, types: unknown, options: CompareOptions = {}): Promise<CompareResponse> {
  return compareSchemaPairs(source.dbmsid, target.dbmsid, [{ source: source.schema, target: target.schema }], types, options);
}

async function getSourceDiff(source: CompareSide, target: CompareSide, type: string, name: string): Promise<DiffLine[]> {
  const objectType = [...SOURCE_TYPES, ...TEXT_TYPES].find((candidate) => candidate === type);
  if (!objectType) {
    throw new Error(`소스 비교를 지원하지 않는 타입입니다: ${type}`);
  }
  let sourceLines: string[] | null;
  let targetLines: string[] | null;
  try {
    [sourceLines, targetLines] = await Promise.all([
      objectCompareModel.getSourceLines({ dbmsid: source.dbmsid }, source.schema, objectType, name),
      objectCompareModel.getSourceLines({ dbmsid: target.dbmsid }, target.schema, objectType, name),
    ]);
  } catch (error) {
    throw new Error('소스 조회 실패', { cause: error });
  }
  return diffLines(sourceLines ?? [], targetLines ?? []);
}

export {
  getSchemas,
  compareSchemas,
  compareSchemaPairs,
  getSourceDiff,
  // 순수 함수라 단위 테스트에서 직접 검증합니다.
  compareSnapshots,
  compareColumns,
  formatDataType,
  diffLines,
  tableDdl,
  indexDdl,
  sequenceDdl,
  synonymDdl,
};
