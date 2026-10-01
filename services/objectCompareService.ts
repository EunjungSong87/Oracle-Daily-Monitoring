import * as objectCompareModel from '../models/objectCompareModel';
import { OBJECT_TYPES, SOURCE_TYPES, TEXT_TYPES } from '../models/objectCompareModel';
import type {
  ColumnInfo,
  IndexInfo,
  ObjectType,
  SchemaSnapshot,
  SequenceInfo,
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
}

export interface CompareSide {
  dbmsid: number | string;
  schema: string;
}

export interface CompareOptions {
  // 테이블/인덱스가 놓인 테이블스페이스 이름 차이를 무시합니다 (운영/개발처럼 이름 체계가 다른 환경 비교용).
  ignoreTablespace?: boolean;
}

export interface CompareResponse {
  source: CompareSide & { dbname: string };
  target: CompareSide & { dbname: string };
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
  describe: (source: T, target: T) => { diffs: DiffRow[]; summary?: string; hasSourceDiff?: boolean },
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
    const { diffs, summary, hasSourceDiff } = describe(left, right);
    const realDiffs = diffs.filter((diff) => !diff.info);
    const isDiff = realDiffs.length > 0 || !!hasSourceDiff;
    return {
      type,
      name,
      result: isDiff ? 'DIFF' : 'SAME',
      summary: summary ?? (isDiff ? `${realDiffs.length}건 차이` : '동일'),
      diffs,
      hasSourceDiff: !!hasSourceDiff,
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
        }))
      );
    } else if (type === 'INDEX') {
      const keyed = (rows: IndexInfo[]): Map<string, IndexInfo> => new Map(rows.map((row) => [indexKey(row), row]));
      items.push(
        ...pairUp(type, keyed(source.indexes), keyed(target.indexes), (left, right) => ({
          diffs: compareIndex(left, right, options),
        }))
      );
    } else if (type === 'SEQUENCE') {
      items.push(
        ...pairUp(type, byName(source.sequences), byName(target.sequences), (left, right) => ({
          diffs: compareSequence(left, right),
        }))
      );
    } else if (type === 'SYNONYM') {
      items.push(
        ...pairUp(type, byName(source.synonyms), byName(target.synonyms), (left, right) => ({
          diffs: attributeDiffs('(시노님)', [['가리키는 대상', left.target, right.target]]),
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

async function compareSchemas(
  source: CompareSide,
  target: CompareSide,
  types: unknown,
  options: CompareOptions = {}
): Promise<CompareResponse> {
  const selected = parseTypes(types);
  let sourceSnapshot: SchemaSnapshot;
  let targetSnapshot: SchemaSnapshot;
  try {
    // 두 DB는 서로 독립이라 동시에 읽어옵니다.
    [sourceSnapshot, targetSnapshot] = await Promise.all([
      objectCompareModel.getSnapshot({ dbmsid: source.dbmsid }, source.schema, selected),
      objectCompareModel.getSnapshot({ dbmsid: target.dbmsid }, target.schema, selected),
    ]);
  } catch (error) {
    throw new Error('오브젝트 정보 조회 실패', { cause: error });
  }
  return {
    source: { ...source, dbname: sourceSnapshot.dbname },
    target: { ...target, dbname: targetSnapshot.dbname },
    types: selected,
    items: compareSnapshots(sourceSnapshot, targetSnapshot, selected, options),
  };
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
  getSourceDiff,
  // 순수 함수라 단위 테스트에서 직접 검증합니다.
  compareSnapshots,
  compareColumns,
  formatDataType,
  diffLines,
};
