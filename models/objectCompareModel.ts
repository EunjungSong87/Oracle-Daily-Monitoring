import oracledb from 'oracledb';
import * as db from '../db';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';

// 비교 대상 오브젝트 타입. 화면/결과의 표시 순서도 이 배열 순서를 따릅니다 (테이블스페이스가 맨 앞).
export const OBJECT_TYPES = [
  'TABLESPACE',
  'TABLE',
  'INDEX',
  'VIEW',
  'MATERIALIZED VIEW',
  'SEQUENCE',
  'SYNONYM',
  'FUNCTION',
  'PROCEDURE',
  'PACKAGE',
  'PACKAGE BODY',
  'TRIGGER',
  'TYPE',
  'TYPE BODY',
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

// DBA_SOURCE에 소스가 들어있는 타입 (줄 단위 해시로 비교하고, 상세는 줄 단위 diff로 보여줌).
export const SOURCE_TYPES: ObjectType[] = ['FUNCTION', 'PROCEDURE', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER', 'TYPE', 'TYPE BODY'];
// 정의가 LONG 컬럼 하나(DBA_VIEWS.TEXT / DBA_MVIEWS.QUERY)에 통째로 들어있는 타입.
export const TEXT_TYPES: ObjectType[] = ['VIEW', 'MATERIALIZED VIEW'];

export interface TablespaceInfo {
  name: string;
  contents: string;
  blockSize: number;
  bigfile: string;
  extentManagement: string;
  allocationType: string;
  segmentSpaceManagement: string;
  logging: string;
  status: string;
  autoextensible: string | null;
  fileCount: number | null;
  sizeMb: number | null;
  maxSizeMb: number | null;
}

export interface TableInfo {
  name: string;
  tablespace: string | null;
  partitioned: string;
  temporary: string;
}

export interface ColumnInfo {
  table: string;
  name: string;
  position: number;
  dataType: string;
  dataLength: number | null;
  charLength: number | null;
  charUsed: string | null;
  precision: number | null;
  scale: number | null;
  nullable: string;
  defaultValue: string | null;
}

export interface IndexInfo {
  name: string;
  table: string;
  uniqueness: string;
  indexType: string;
  tablespace: string | null;
  partitioned: string;
  generated: string; // 'Y'면 SYS_C00123 같은 시스템 생성 이름 — DB마다 달라서 이름으로 매칭하면 안 됨
  columns: string[]; // 위치 순서대로, 함수 기반이면 표현식, 내림차순이면 뒤에 ' DESC'
}

export interface SequenceInfo {
  name: string;
  minValue: string;
  maxValue: string;
  incrementBy: string;
  cycle: string;
  order: string;
  cacheSize: string;
}

export interface SynonymInfo {
  name: string;
  target: string;
}

export interface SourceHash {
  type: string;
  name: string;
  lines: number;
  hash: string;
}

export interface TextObject {
  type: string;
  name: string;
  text: string;
}

export interface SchemaSnapshot {
  dbname: string;
  tablespaces: TablespaceInfo[];
  tables: TableInfo[];
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  sequences: SequenceInfo[];
  synonyms: SynonymInfo[];
  sourceHashes: SourceHash[];
  textObjects: TextObject[];
  // 소스/뷰류 오브젝트의 VALID/INVALID 상태 (key: `${type}\u0000${name}`)
  statuses: Record<string, string>;
}

const FETCH_OPTIONS = { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchArraySize: 1000 };

// 대상 DBMS에 접속합니다 (tableSpecModel과 동일한 방식). dbname도 함께 돌려줍니다.
async function connectTarget(dbmsid: DbmsIdParam): Promise<{ connection: oracledb.Connection; dbname: string }> {
  const dbconfig = await dbmsModel.getDbmsInfo(dbmsid);
  if (!dbconfig) {
    throw new Error('DBMS 정보를 찾을 수 없습니다.');
  }
  const config = {
    user: dbconfig[0],
    password: dbconfig[1],
    connectString: dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4],
  };
  return { connection: await db.connectDB(config), dbname: dbconfig[6] };
}

async function query(connection: oracledb.Connection, sql: string, binds: oracledb.BindParameters = {}): Promise<Record<string, any>[]> {
  const result = await connection.execute<Record<string, any>>(sql, binds, FETCH_OPTIONS);
  return result.rows ?? [];
}

// Oracle 기본 제공 스키마를 뺀 전체 사용자 목록. Table Spec과 달리 테이블이 하나도 없는 스키마
// (프로시저/패키지만 있는 스키마)도 비교 대상이 될 수 있어서 DBA_TABLES가 아니라 DBA_USERS 기준입니다.
async function getSchemas(dbmsid: DbmsIdParam): Promise<string[]> {
  let connection: oracledb.Connection | undefined;
  try {
    ({ connection } = await connectTarget(dbmsid));
    const rows = await query(connection, `SELECT USERNAME FROM DBA_USERS WHERE ORACLE_MAINTAINED = 'N' ORDER BY USERNAME`);
    return rows.map((row) => row.USERNAME);
  } finally {
    if (connection) await connection.close();
  }
}

async function loadTablespaces(connection: oracledb.Connection): Promise<TablespaceInfo[]> {
  const rows = await query(
    connection,
    `SELECT t.TABLESPACE_NAME, t.CONTENTS, t.BLOCK_SIZE, t.BIGFILE, t.EXTENT_MANAGEMENT, t.ALLOCATION_TYPE,
            t.SEGMENT_SPACE_MANAGEMENT, t.LOGGING, t.STATUS,
            f.FILE_COUNT, f.SIZE_MB, f.MAX_SIZE_MB, f.AUTOEXTENSIBLE
       FROM DBA_TABLESPACES t
       LEFT JOIN (
             SELECT TABLESPACE_NAME,
                    COUNT(*) AS FILE_COUNT,
                    ROUND(SUM(BYTES) / 1048576) AS SIZE_MB,
                    ROUND(SUM(GREATEST(BYTES, MAXBYTES)) / 1048576) AS MAX_SIZE_MB,
                    MAX(AUTOEXTENSIBLE) AS AUTOEXTENSIBLE
               FROM (SELECT TABLESPACE_NAME, BYTES, MAXBYTES, AUTOEXTENSIBLE FROM DBA_DATA_FILES
                     UNION ALL
                     SELECT TABLESPACE_NAME, BYTES, MAXBYTES, AUTOEXTENSIBLE FROM DBA_TEMP_FILES)
              GROUP BY TABLESPACE_NAME
            ) f ON f.TABLESPACE_NAME = t.TABLESPACE_NAME
      ORDER BY t.TABLESPACE_NAME`
  );
  return rows.map((row) => ({
    name: row.TABLESPACE_NAME,
    contents: row.CONTENTS,
    blockSize: row.BLOCK_SIZE,
    bigfile: row.BIGFILE,
    extentManagement: row.EXTENT_MANAGEMENT,
    allocationType: row.ALLOCATION_TYPE,
    segmentSpaceManagement: row.SEGMENT_SPACE_MANAGEMENT,
    logging: row.LOGGING,
    status: row.STATUS,
    autoextensible: row.AUTOEXTENSIBLE,
    fileCount: row.FILE_COUNT,
    sizeMb: row.SIZE_MB,
    maxSizeMb: row.MAX_SIZE_MB,
  }));
}

// 휴지통(BIN$), 중첩 테이블, 도메인 인덱스의 보조 테이블, IOT 오버플로 세그먼트는 사용자가 직접 만든
// 테이블이 아니라 이름이 DB마다 달라질 수 있어서 제외합니다.
async function loadTables(connection: oracledb.Connection, owner: string): Promise<TableInfo[]> {
  const rows = await query(
    connection,
    `SELECT TABLE_NAME, TABLESPACE_NAME, PARTITIONED, TEMPORARY
       FROM DBA_TABLES
      WHERE OWNER = :owner
        AND TABLE_NAME NOT LIKE 'BIN$%'
        AND NESTED = 'NO'
        AND SECONDARY = 'N'
        AND (IOT_TYPE IS NULL OR IOT_TYPE = 'IOT')`,
    { owner }
  );
  return rows.map((row) => ({
    name: row.TABLE_NAME,
    tablespace: row.TABLESPACE_NAME,
    partitioned: row.PARTITIONED,
    temporary: row.TEMPORARY,
  }));
}

// DBA_TAB_COLUMNS는 뷰의 컬럼도 포함하므로 호출한 쪽에서 테이블 목록으로 걸러 씁니다.
async function loadColumns(connection: oracledb.Connection, owner: string): Promise<ColumnInfo[]> {
  const rows = await query(
    connection,
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_ID, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, CHAR_USED,
            DATA_PRECISION, DATA_SCALE, NULLABLE, DATA_DEFAULT
       FROM DBA_TAB_COLUMNS
      WHERE OWNER = :owner
      ORDER BY TABLE_NAME, COLUMN_ID`,
    { owner }
  );
  return rows.map((row) => ({
    table: row.TABLE_NAME,
    name: row.COLUMN_NAME,
    position: row.COLUMN_ID,
    dataType: row.DATA_TYPE,
    dataLength: row.DATA_LENGTH,
    charLength: row.CHAR_LENGTH,
    charUsed: row.CHAR_USED,
    precision: row.DATA_PRECISION,
    scale: row.DATA_SCALE,
    nullable: row.NULLABLE,
    defaultValue: row.DATA_DEFAULT,
  }));
}

// LOB 인덱스(SYS_IL...)는 LOB 컬럼에 자동으로 딸려오는 것이라 제외합니다.
async function loadIndexes(connection: oracledb.Connection, owner: string): Promise<IndexInfo[]> {
  const indexRows = await query(
    connection,
    `SELECT INDEX_NAME, TABLE_NAME, UNIQUENESS, INDEX_TYPE, TABLESPACE_NAME, PARTITIONED, GENERATED
       FROM DBA_INDEXES
      WHERE OWNER = :owner
        AND INDEX_TYPE <> 'LOB'
        AND TABLE_NAME NOT LIKE 'BIN$%'`,
    { owner }
  );
  const columnRows = await query(
    connection,
    `SELECT INDEX_NAME, COLUMN_POSITION, COLUMN_NAME, DESCEND
       FROM DBA_IND_COLUMNS
      WHERE INDEX_OWNER = :owner
      ORDER BY INDEX_NAME, COLUMN_POSITION`,
    { owner }
  );
  // 함수 기반 인덱스(내림차순 컬럼 포함)는 DBA_IND_COLUMNS에 SYS_NC00012$ 같은 숨은 컬럼명으로 나오므로
  // 실제 표현식으로 바꿔서 비교합니다.
  const expressionRows = await query(
    connection,
    `SELECT INDEX_NAME, COLUMN_POSITION, COLUMN_EXPRESSION
       FROM DBA_IND_EXPRESSIONS
      WHERE INDEX_OWNER = :owner`,
    { owner }
  );
  const expressions = new Map<string, string>();
  for (const row of expressionRows) {
    expressions.set(`${row.INDEX_NAME}\u0000${row.COLUMN_POSITION}`, String(row.COLUMN_EXPRESSION ?? '').trim());
  }
  const columnsByIndex = new Map<string, string[]>();
  for (const row of columnRows) {
    const expression = expressions.get(`${row.INDEX_NAME}\u0000${row.COLUMN_POSITION}`);
    // 단순 내림차순 컬럼은 표현식이 "COL" 형태로 들어있어서 따옴표를 벗겨 컬럼명으로 되돌립니다.
    const simpleColumn = expression?.match(/^"([^"]+)"$/)?.[1];
    const base = simpleColumn ?? expression ?? row.COLUMN_NAME;
    const list = columnsByIndex.get(row.INDEX_NAME) ?? [];
    list.push(row.DESCEND === 'DESC' ? `${base} DESC` : base);
    columnsByIndex.set(row.INDEX_NAME, list);
  }
  return indexRows.map((row) => ({
    name: row.INDEX_NAME,
    table: row.TABLE_NAME,
    uniqueness: row.UNIQUENESS,
    indexType: row.INDEX_TYPE,
    tablespace: row.TABLESPACE_NAME,
    partitioned: row.PARTITIONED,
    generated: row.GENERATED,
    columns: columnsByIndex.get(row.INDEX_NAME) ?? [],
  }));
}

// IDENTITY 컬럼이 자동으로 만드는 시퀀스(ISEQ$$_숫자)는 이름이 DB마다 달라서 제외합니다.
// 값이 28자리까지 나올 수 있어 JS number로 받으면 정밀도가 깨지므로 문자열로 받습니다.
async function loadSequences(connection: oracledb.Connection, owner: string): Promise<SequenceInfo[]> {
  const rows = await query(
    connection,
    `SELECT SEQUENCE_NAME, TO_CHAR(MIN_VALUE) AS MIN_VALUE, TO_CHAR(MAX_VALUE) AS MAX_VALUE,
            TO_CHAR(INCREMENT_BY) AS INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, TO_CHAR(CACHE_SIZE) AS CACHE_SIZE
       FROM DBA_SEQUENCES
      WHERE SEQUENCE_OWNER = :owner
        AND SEQUENCE_NAME NOT LIKE 'ISEQ$$\\_%' ESCAPE '\\'`,
    { owner }
  );
  return rows.map((row) => ({
    name: row.SEQUENCE_NAME,
    minValue: row.MIN_VALUE,
    maxValue: row.MAX_VALUE,
    incrementBy: row.INCREMENT_BY,
    cycle: row.CYCLE_FLAG,
    order: row.ORDER_FLAG,
    cacheSize: row.CACHE_SIZE,
  }));
}

async function loadSynonyms(connection: oracledb.Connection, owner: string): Promise<SynonymInfo[]> {
  const rows = await query(
    connection,
    `SELECT SYNONYM_NAME, TABLE_OWNER, TABLE_NAME, DB_LINK FROM DBA_SYNONYMS WHERE OWNER = :owner`,
    { owner }
  );
  return rows.map((row) => ({
    name: row.SYNONYM_NAME,
    target: `${row.TABLE_OWNER ? row.TABLE_OWNER + '.' : ''}${row.TABLE_NAME}${row.DB_LINK ? '@' + row.DB_LINK : ''}`,
  }));
}

// "CREATE PROCEDURE 스키마.이름"처럼 스키마를 붙여 만든 소스는 DBA_SOURCE 첫 줄에 스키마명이 그대로 남습니다.
// 스키마명이 다른 두 곳을 비교하거나 한쪽만 접두어를 붙여 만든 경우 전부 "다름"으로 나오지 않도록,
// 첫 줄의 "스키마." 접두어는 빼고 비교합니다. 해시(SQL)와 diff(JS)가 같은 규칙을 써야 하므로 패턴을 공유합니다.
// 최신 버전(확인: 23ai)은 접두어를 지우는 대신 같은 길이의 공백으로 바꿔 저장하므로, 첫 줄은 연속 공백도 하나로 합칩니다.
function ownerPrefixPattern(owner: string): string {
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `"?${escaped}"?\\s*\\.\\s*`;
}

// 소스 전문을 양쪽에서 다 끌어오면 스키마가 클 때 수십 MB가 되므로, DB에서 오브젝트별 해시만 계산해 옵니다.
// 줄 끝 공백/개행 차이는 무시하고(RTRIM), 줄 순서가 바뀐 것도 잡히도록 한쪽 합에는 줄 번호를 곱합니다.
// 32비트 해시 두 개(seed 0/1)를 조합하므로 실제로 다른 소스가 같다고 나올 가능성은 무시할 수준입니다.
async function loadSourceHashes(connection: oracledb.Connection, owner: string, types: string[]): Promise<SourceHash[]> {
  if (types.length === 0) return [];
  const binds: Record<string, string> = { owner, ownerPattern: ownerPrefixPattern(owner) };
  const placeholders = types.map((type, index) => {
    binds[`t${index}`] = type;
    return `:t${index}`;
  });
  const rows = await query(
    connection,
    `SELECT TYPE, NAME, COUNT(*) AS LINE_COUNT,
            TO_CHAR(SUM(ORA_HASH(TRIMMED) * LINE)) || '-' || TO_CHAR(SUM(ORA_HASH(TRIMMED, 4294967295, 1))) AS HASH
       FROM (SELECT TYPE, NAME, LINE,
                    RTRIM(CASE WHEN LINE = 1
                               THEN REGEXP_REPLACE(REGEXP_REPLACE(TEXT, :ownerPattern, '', 1, 1, 'i'), '\\s+', ' ')
                               ELSE TEXT END,
                          ' ' || CHR(9) || CHR(10) || CHR(13)) AS TRIMMED
               FROM DBA_SOURCE
              WHERE OWNER = :owner
                AND TYPE IN (${placeholders.join(', ')}))
      GROUP BY TYPE, NAME`,
    binds
  );
  return rows.map((row) => ({ type: row.TYPE, name: row.NAME, lines: row.LINE_COUNT, hash: row.HASH }));
}

async function loadTextObjects(connection: oracledb.Connection, owner: string, types: string[]): Promise<TextObject[]> {
  const objects: TextObject[] = [];
  if (types.includes('VIEW')) {
    const rows = await query(connection, `SELECT VIEW_NAME, TEXT FROM DBA_VIEWS WHERE OWNER = :owner`, { owner });
    for (const row of rows) objects.push({ type: 'VIEW', name: row.VIEW_NAME, text: String(row.TEXT ?? '') });
  }
  if (types.includes('MATERIALIZED VIEW')) {
    const rows = await query(connection, `SELECT MVIEW_NAME, QUERY FROM DBA_MVIEWS WHERE OWNER = :owner`, { owner });
    for (const row of rows) objects.push({ type: 'MATERIALIZED VIEW', name: row.MVIEW_NAME, text: String(row.QUERY ?? '') });
  }
  return objects;
}

async function loadStatuses(connection: oracledb.Connection, owner: string, types: string[]): Promise<Record<string, string>> {
  if (types.length === 0) return {};
  const binds: Record<string, string> = { owner };
  const placeholders = types.map((type, index) => {
    binds[`t${index}`] = type;
    return `:t${index}`;
  });
  const rows = await query(
    connection,
    `SELECT OBJECT_TYPE, OBJECT_NAME, STATUS
       FROM DBA_OBJECTS
      WHERE OWNER = :owner
        AND OBJECT_TYPE IN (${placeholders.join(', ')})`,
    binds
  );
  const statuses: Record<string, string> = {};
  for (const row of rows) statuses[`${row.OBJECT_TYPE}\u0000${row.OBJECT_NAME}`] = row.STATUS;
  return statuses;
}

// 한 DB/스키마에 대해, 선택된 타입을 비교하는 데 필요한 딕셔너리 정보를 한 커넥션으로 모두 읽어옵니다.
async function getSnapshot(dbmsid: DbmsIdParam, owner: string, types: ObjectType[]): Promise<SchemaSnapshot> {
  let connection: oracledb.Connection | undefined;
  try {
    const target = await connectTarget(dbmsid);
    connection = target.connection;
    const wants = (type: ObjectType): boolean => types.includes(type);
    const sourceTypes = SOURCE_TYPES.filter(wants);
    const textTypes = TEXT_TYPES.filter(wants);

    return {
      dbname: target.dbname,
      tablespaces: wants('TABLESPACE') ? await loadTablespaces(connection) : [],
      tables: wants('TABLE') ? await loadTables(connection, owner) : [],
      columns: wants('TABLE') ? await loadColumns(connection, owner) : [],
      indexes: wants('INDEX') ? await loadIndexes(connection, owner) : [],
      sequences: wants('SEQUENCE') ? await loadSequences(connection, owner) : [],
      synonyms: wants('SYNONYM') ? await loadSynonyms(connection, owner) : [],
      sourceHashes: await loadSourceHashes(connection, owner, sourceTypes),
      textObjects: await loadTextObjects(connection, owner, textTypes),
      statuses: await loadStatuses(connection, owner, [...sourceTypes, ...textTypes]),
    };
  } finally {
    if (connection) await connection.close();
  }
}

// 상세 diff용: 오브젝트 하나의 소스를 줄 배열로 가져옵니다. 없으면 null.
async function getSourceLines(dbmsid: DbmsIdParam, owner: string, type: ObjectType, name: string): Promise<string[] | null> {
  let connection: oracledb.Connection | undefined;
  try {
    ({ connection } = await connectTarget(dbmsid));
    if (type === 'VIEW' || type === 'MATERIALIZED VIEW') {
      const sql =
        type === 'VIEW'
          ? `SELECT TEXT AS BODY FROM DBA_VIEWS WHERE OWNER = :owner AND VIEW_NAME = :name`
          : `SELECT QUERY AS BODY FROM DBA_MVIEWS WHERE OWNER = :owner AND MVIEW_NAME = :name`;
      const rows = await query(connection, sql, { owner, name });
      if (rows.length === 0) return null;
      return String(rows[0].BODY ?? '').split(/\r?\n/);
    }
    const rows = await query(
      connection,
      `SELECT TEXT FROM DBA_SOURCE WHERE OWNER = :owner AND TYPE = :type AND NAME = :name ORDER BY LINE`,
      { owner, type, name }
    );
    if (rows.length === 0) return null;
    const ownerPrefix = new RegExp(ownerPrefixPattern(owner), 'i');
    return rows.map((row, index) => {
      const text = String(row.TEXT ?? '');
      return index === 0 ? text.replace(ownerPrefix, '').replace(/\s+/g, ' ') : text;
    });
  } finally {
    if (connection) await connection.close();
  }
}

export { getSchemas, getSnapshot, getSourceLines };
