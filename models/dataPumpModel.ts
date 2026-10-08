import oracledb from 'oracledb';
import * as db from '../db';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';

// Data Pump(EXPDP/IMPDP)를 DB 서버 안에서 DBMS_DATAPUMP API로 실행합니다. 덤프/로그 파일은 DB 서버의
// DIRECTORY 객체 경로에 생깁니다 (이 앱이 도는 PC가 아님). 옵션 검증과 PL/SQL에 넣을 필터 문자열 조립은
// services/dataPumpService.ts가 하고, 여기서는 이미 검증된 값을 전부 바인드 변수로만 넘깁니다.

export interface DirectoryInfo {
  name: string;
  path: string;
}

export interface DataPumpJob {
  owner: string;
  jobName: string;
  operation: string; // EXPORT | IMPORT
  jobMode: string; // SCHEMA | TABLE | FULL
  state: string; // EXECUTING | DEFINING | NOT RUNNING | STOP PENDING ...
  degree: number;
  attachedSessions: number;
  progressPct: number | null; // V$SESSION_LONGOPS 기준
  progressMessage: string | null;
  // 아래도 V$SESSION_LONGOPS 기준. 남은 시간은 지금까지의 처리 속도로 오라클이 계산한 값이라, 작업 초반(메타데이터
  // 처리 단계)에는 없거나 들쭉날쭉할 수 있다.
  elapsedSec: number | null;
  remainingSec: number | null;
  doneMb: number | null;
  totalMb: number | null;
}

// 화면이 조립해서 넘기는 "실행 계획" — 서비스 계층에서 검증/변환을 끝낸 값입니다.
export interface DataPumpPlan {
  operation: 'EXPORT' | 'IMPORT';
  jobMode: 'SCHEMA' | 'TABLE' | 'FULL';
  jobName: string;
  directory: string;
  dumpfile: string | null; // NETWORK_LINK로 바로 가져오는 import는 덤프 파일 없음
  logfile: string;
  filesize: string | null; // 예: '2G' — 덤프 파일 하나의 최대 크기
  parallel: number;
  schemaExpr: string | null; // METADATA_FILTER SCHEMA_EXPR, 예: IN ('HR','SCOTT')
  nameExpr: string | null; // METADATA_FILTER NAME_EXPR (테이블 모드), 예: IN ('EMP','DEPT')
  excludeTableExpr: string | null; // 스키마 모드에서 빼는 테이블 (분할 시 다른 작업으로 떼어 낸 큰 테이블), 예: NOT IN ('BIG1')
  content: 'ALL' | 'METADATA_ONLY' | 'DATA_ONLY';
  excludeStatistics: boolean;
  reuseDumpfiles: boolean; // EXPORT
  flashbackConsistent: boolean; // EXPORT(또는 NETWORK_LINK import) — 시작 시점 원본 SCN으로 일관성 있게
  flashbackScn: string | null; // EXPORT — 여러 작업을 같은 시점으로 맞출 때 지정 SCN (없으면 작업 시작 시점)
  tableExistsAction: 'SKIP' | 'APPEND' | 'TRUNCATE' | 'REPLACE' | null; // IMPORT
  remapSchemas: { from: string; to: string }[]; // IMPORT
  remapTablespaces: { from: string; to: string }[]; // IMPORT
  networkLink: string | null; // DB 링크 (EXPORT: 링크 너머 DB를 이 DB 덤프로, IMPORT: 링크 너머 DB에서 덤프 없이 바로)
  // 파티션 단위 EXPORT: 테이블마다 DATA_FILTER PARTITION_EXPR (expdp TABLES=OWNER.TAB:PART). 여기 없는 테이블은 통째로.
  partitionFilters: { owner: string; table: string; partitions: string[] }[];
  // TABLE 모드 작업의 정확한 (소유자, 테이블) 목록 = parfile TABLES=. DBMS_DATAPUMP TABLE 모드는 스키마 하나만 받으므로(ORA-39040)
  // 스키마가 여럿이면 서비스가 실행할 때 스키마마다 작업 하나로 나눈다 (startJob에는 늘 스키마 하나짜리만 온다).
  tables: { owner: string; table: string }[];
  // 오브젝트 필터(INCLUDE/EXCLUDE) + 데이터 필터·옵션 — services/dataPumpFilters.ts가 검증해서 만든 값
  filters: PlanFilters;
  // 파티션 단위 IMPORT: 작업 시작 전에 대상 테이블(REMAP_SCHEMA 반영)에서 비울 파티션.
  truncateTarget: { owner: string; name: string } | null;
  truncatePartitions: string[];
}

// 실행에 쓰는 필터 값 (모두 서비스에서 형식/허용 목록 검증을 마친 값 — 식/조건은 바인드 변수로 넘긴다)
export interface PlanFilters {
  includePaths: string[]; // INCLUDE_PATH_EXPR IN (...)
  excludePaths: string[]; // EXCLUDE_PATH_EXPR IN (...) — 통계 제외(STATISTICS) 포함
  nameFilters: { path: string; expr: string }[]; // NAME_EXPR (object_path별, 여러 개는 AND)
  queries: { owner: string | null; table: string | null; where: string }[]; // DATA_FILTER SUBQUERY
  samples: { owner: string | null; table: string | null; percent: number }[]; // DATA_FILTER SAMPLE
  dataOptionConstants: string[]; // DBMS_DATAPUMP.KU$_DATAOPT_* 상수 이름 (고정 목록에서만)
  viewsAsTables: string[]; // OWNER.VIEW[:TEMPLATE]
  excludeTablesOnly: boolean; // 뷰만 있는 테이블 모드 작업 — 실제 테이블은 빼기 (EXCLUDE_TABLES=Y)
  // 실행에는 안 쓰고 parfile / 작업 이력 요약 / 시작 감사 로그에 쓰는 값
  parfileLines: string[];
  summary: string[];
  audit: string[];
}

export interface TableSize {
  owner: string;
  name: string;
  bytes: number; // 테이블(파티션 포함) + LOB 세그먼트 크기
}

export interface LogContent {
  exists: boolean;
  text: string;
  truncated: boolean; // 너무 커서 끝부분만 가져왔으면 true
}

// 대상 DBMS에 접속합니다 (다른 model과 같은 방식). dbname도 함께 돌려줍니다.
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

async function withConnection<T>(dbmsid: DbmsIdParam, work: (connection: oracledb.Connection, dbname: string) => Promise<T>): Promise<T> {
  let connection: oracledb.Connection | undefined;
  try {
    const target = await connectTarget(dbmsid);
    connection = target.connection;
    return await work(connection, target.dbname);
  } finally {
    if (connection) await connection.close();
  }
}

async function query(connection: oracledb.Connection, sql: string, binds: oracledb.BindParameters = {}): Promise<Record<string, any>[]> {
  const result = await connection.execute<Record<string, any>>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return result.rows ?? [];
}

export interface TargetInfo {
  dbname: string;
  user: string;
  host: string;
  port: string;
  sid: string;
}

// 등록된 DBMS의 이름/접속 정보 (비밀번호 제외) — 덮어쓰기 확인과 expdp/impdp 명령어 생성에 씁니다.
async function getTargetInfo(dbmsid: DbmsIdParam): Promise<TargetInfo> {
  const dbconfig = await dbmsModel.getDbmsInfo(dbmsid);
  if (!dbconfig) throw new Error('DBMS 정보를 찾을 수 없습니다.');
  return { dbname: dbconfig[6], user: dbconfig[0], host: dbconfig[2], port: String(dbconfig[3]), sid: dbconfig[4] };
}

async function getDirectories(dbmsid: DbmsIdParam): Promise<DirectoryInfo[]> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(connection, `SELECT directory_name, directory_path FROM dba_directories ORDER BY directory_name`);
    return rows.map((row) => ({ name: row.DIRECTORY_NAME, path: row.DIRECTORY_PATH }));
  });
}

// DB 에디션. Data Pump PARALLEL(2 이상)은 Enterprise Edition에서만 됩니다 (Standard/Express/Free는 ORA-39094).
async function getEdition(dbmsid: DbmsIdParam): Promise<{ banner: string; parallelSupported: boolean }> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(connection, `SELECT banner FROM v$version WHERE banner LIKE 'Oracle%' AND ROWNUM = 1`);
    const banner: string = rows[0]?.BANNER ?? '';
    return { banner, parallelSupported: /Enterprise/i.test(banner) };
  });
}

// 이 DB에서 쓸 수 있는 DB 링크 (본인 소유 + PUBLIC). NETWORK_LINK 옵션의 목록이자, 넘어온 링크 이름의 허용 목록입니다.
export interface DbLinkInfo {
  name: string;
  owner: string;
  username: string | null;
  host: string | null;
}

async function getDbLinks(dbmsid: DbmsIdParam): Promise<DbLinkInfo[]> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(
      connection,
      `SELECT db_link, owner, username, host FROM all_db_links WHERE owner IN (USER, 'PUBLIC') ORDER BY db_link`
    );
    return rows.map((row) => ({ name: row.DB_LINK, owner: row.OWNER, username: row.USERNAME, host: row.HOST }));
  });
}

// link가 있으면 링크 너머 DB의 딕셔너리를 읽는다. link는 서비스가 getDbLinks 목록과 대조해 검증한 이름만 들어온다
// (식별자라 바인드 변수로 넘길 수 없어서 SQL에 붙임).
function remote(link: string | null): string {
  return link ? `@${link}` : '';
}

async function getSchemas(dbmsid: DbmsIdParam, link: string | null = null): Promise<string[]> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(connection, `SELECT username FROM dba_users${remote(link)} WHERE oracle_maintained = 'N' ORDER BY username`);
    return rows.map((row) => row.USERNAME);
  });
}

// 테이블별 크기 = 테이블 세그먼트(파티션/서브파티션 포함) + 그 테이블 LOB 컬럼의 LOB 세그먼트.
// 인덱스는 덤프에 DDL만 들어가고 데이터는 없으므로 뺍니다. 세그먼트는 할당된 공간이라 실제 덤프는 보통 이보다 작습니다.
// 딕셔너리 뷰만 읽고(데이터 블록은 안 읽음), 세그먼트를 한 번만 훑도록 미리 합산한 뒤 테이블에 붙입니다.
// pairs를 주면 그 (소유자, 테이블)만 읽습니다 — 테이블 목록 export에서 스키마 전체를 훑지 않게.
async function loadTableSizes(
  connection: oracledb.Connection,
  owners: string[],
  link: string | null,
  pairs: { owner: string; table: string }[] | null = null
): Promise<TableSize[]> {
  if (owners.length === 0 || (pairs && pairs.length === 0)) return [];
  const at = remote(link);
  // 바인드 목록이 너무 길어지지 않게(IN 목록 한도 1000) 나눠서 읽는다.
  const chunks = pairs ? Array.from({ length: Math.ceil(pairs.length / 500) }, (_, i) => pairs.slice(i * 500, i * 500 + 500)) : [null];
  const result: TableSize[] = [];
  for (const chunk of chunks) {
    const binds: Record<string, string> = {};
    const ownerList = owners
      .map((owner, index) => {
        binds[`o${index}`] = owner;
        return `:o${index}`;
      })
      .join(', ');
    let pairFilter = (_owner: string, _name: string) => '1 = 1';
    if (chunk) {
      const tuples = chunk
        .map((pair, index) => {
          binds[`po${index}`] = pair.owner;
          binds[`pt${index}`] = pair.table;
          return `(:po${index}, :pt${index})`;
        })
        .join(', ');
      pairFilter = (owner: string, name: string) => `(${owner}, ${name}) IN (${tuples})`;
    }
    const rows = await query(
      connection,
      `WITH seg AS (
         SELECT owner, segment_name, SUM(bytes) AS bytes
           FROM dba_segments${at}
          WHERE owner IN (${ownerList}) AND ${pairFilter('owner', 'segment_name')}
            AND segment_type IN ('TABLE', 'TABLE PARTITION', 'TABLE SUBPARTITION', 'NESTED TABLE')
          GROUP BY owner, segment_name
       ), lob AS (
         SELECT l.owner, l.table_name, SUM(s.bytes) AS bytes
           FROM dba_lobs${at} l
           JOIN dba_segments${at} s ON s.owner = l.owner AND s.segment_name = l.segment_name
          WHERE l.owner IN (${ownerList}) AND ${pairFilter('l.owner', 'l.table_name')}
          GROUP BY l.owner, l.table_name
       )
       SELECT t.owner, t.table_name, NVL(seg.bytes, 0) + NVL(lob.bytes, 0) AS bytes
         FROM dba_tables${at} t
         LEFT JOIN seg ON seg.owner = t.owner AND seg.segment_name = t.table_name
         LEFT JOIN lob ON lob.owner = t.owner AND lob.table_name = t.table_name
        WHERE t.owner IN (${ownerList}) AND ${pairFilter('t.owner', 't.table_name')}
          AND t.table_name NOT LIKE 'BIN$%'
          AND t.nested = 'NO' AND t.secondary = 'N'
          AND (t.iot_type IS NULL OR t.iot_type = 'IOT')
        ORDER BY t.owner, t.table_name`,
      binds
    );
    result.push(...rows.map((row) => ({ owner: row.OWNER, name: row.TABLE_NAME, bytes: Number(row.BYTES) })));
  }
  return result;
}

async function getTableSizes(dbmsid: DbmsIdParam, owners: string[], link: string | null = null): Promise<TableSize[]> {
  if (owners.length === 0) return [];
  return withConnection(dbmsid, (connection) => loadTableSizes(connection, owners, link));
}

// 테이블 목록 export용 크기/파티션 정보를 접속 한 번에 읽는다 (테이블마다 따로 접속하면 대상 DB에 로그온이 몰려서).
//  - sizes: 목록에 나온 (소유자, 테이블)만
//  - partitions: 파티션 줄이 있는 테이블의 파티션 범위/크기
export interface ListSizing {
  sizes: TableSize[];
  partitions: Record<string, { table: PartitionTableInfo | null; partitions: PartitionRow[] }>;
}

async function getListSizing(
  dbmsid: DbmsIdParam,
  pairs: { owner: string; table: string }[],
  partitionKeys: string[],
  link: string | null = null
): Promise<ListSizing> {
  const owners = [...new Set(pairs.map((pair) => pair.owner))];
  return withConnection(dbmsid, async (connection) => {
    const sizes = await loadTableSizes(connection, owners, link, pairs);
    const partitions: ListSizing['partitions'] = {};
    if (partitionKeys.length > 0 && link) throw new Error('파티션 단위 export는 DB 링크 없이 이 DB에서만 지원합니다.');
    for (const key of partitionKeys) {
      const [owner, table] = key.split('.');
      partitions[key] = await loadTablePartitions(connection, owner, table);
    }
    return { sizes, partitions };
  });
}


// 필터 검증용 대상 DB 정보: 버전(v$instance.version — 예: 19.0.0.0.0)과 모드별 오브젝트 경로 목록(*_EXPORT_OBJECTS).
// 경로 목록은 버전마다 다르고 수백 행이라 서비스가 캐시해서 쓴다.
export interface ObjectPathRow {
  path: string;
  named: boolean;
  comments: string;
}

export interface FilterEnvRaw {
  version: string;
  paths: { SCHEMA: ObjectPathRow[]; TABLE: ObjectPathRow[]; DATABASE: ObjectPathRow[] };
}

async function getFilterEnv(dbmsid: DbmsIdParam): Promise<FilterEnvRaw> {
  return withConnection(dbmsid, async (connection) => {
    const version = (await query(connection, `SELECT version FROM v$instance`))[0]?.VERSION ?? '';
    const read = async (view: string): Promise<ObjectPathRow[]> =>
      (await query(connection, `SELECT object_path, named, comments FROM ${view} ORDER BY object_path`)).map((row) => ({
        path: row.OBJECT_PATH,
        named: row.NAMED === 'Y',
        comments: row.COMMENTS ?? '',
      }));
    return {
      version,
      paths: {
        SCHEMA: await read('schema_export_objects'),
        TABLE: await read('table_export_objects'),
        DATABASE: await read('database_export_objects'),
      },
    };
  });
}

// 스키마의 뷰 목록 (VIEWS_AS_TABLES 고르기용, DB 링크면 링크 너머)
async function getViews(dbmsid: DbmsIdParam, owner: string, link: string | null = null): Promise<string[]> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(connection, `SELECT view_name FROM dba_views${remote(link)} WHERE owner = :owner ORDER BY view_name`, { owner });
    return rows.map((row) => row.VIEW_NAME);
  });
}

// 여러 export 작업을 같은 시점의 데이터로 맞추기 위한 현재 SCN (모든 작업에 FLASHBACK_SCN으로 넘김).
// SCN은 JS number 정밀도를 넘을 수 있어 문자열로 받습니다.
async function getCurrentScn(dbmsid: DbmsIdParam, link: string | null = null): Promise<string> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(connection, `SELECT TO_CHAR(current_scn) AS scn FROM v$database${remote(link)}`);
    return rows[0].SCN;
  });
}

// 목록 바인드: 항목은 CHR(30), 항목 안의 칸은 CHR(31)로 구분 (PL/SQL의 piece/pieces가 나눈다). 비면 NULL.
function joinItems(items: string[][]): string | null {
  if (items.length === 0) return null;
  return items.map((fields) => fields.join(String.fromCharCode(31))).join(String.fromCharCode(30));
}

// DATA_OPTIONS: 고정 목록(services/dataPumpFilters.ts DATA_OPTIONS)의 상수 이름만 받아 PL/SQL 안에서 더한다. 버전에 없는 상수를
// 참조하면 블록 전체가 컴파일되지 않으므로 고른 것만 넣는다 (서비스가 DB 버전으로 허용 여부를 이미 확인).
const DATA_OPTION_CONSTANT = /^KU\$_DATAOPT_[A-Z_]+$/;
function dataOptionsStatement(constants: string[]): string {
  if (constants.length === 0) return 'NULL; -- DATA_OPTIONS 없음';
  for (const constant of constants) {
    if (!DATA_OPTION_CONSTANT.test(constant)) throw new Error(`DATA_OPTIONS 상수 이름이 올바르지 않습니다: ${constant}`);
  }
  return `DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'DATA_OPTIONS', value => ${constants.map((constant) => `DBMS_DATAPUMP.${constant}`).join(' + ')});`;
}

// DBMS_DATAPUMP로 작업을 시작하고 바로 DETACH합니다 (작업은 DB 서버에서 계속 돌고, 화면은 작업 목록/로그로 지켜봄).
// 시작 단계에서 실패하면 만들어진 작업(마스터 테이블)이 남지 않게 정리하고 원래 에러를 다시 던집니다.
async function startJob(dbmsid: DbmsIdParam, plan: DataPumpPlan): Promise<void> {
  // 마지막 방어선: 스키마 × 테이블 이름 교차곱으로 거르는 실행이라, 스키마가 둘 이상이면 목록 밖 테이블이 딸려 나간다.
  if (plan.jobMode === 'TABLE' && new Set(plan.tables.map((item) => item.owner)).size > 1) {
    throw new Error('테이블 모드 작업에 스키마가 둘 이상입니다 (스키마별로 나눠 실행해야 함).');
  }
  await withConnection(dbmsid, async (connection) => {
    await connection.execute(
      `DECLARE
         h NUMBER;
         scn NUMBER;
         err VARCHAR2(32767);
         job_state VARCHAR2(30);
         sts ku$_Status;
         -- 목록 바인드는 항목을 CHR(30), 항목 안의 칸을 CHR(31)로 구분한다 (값 검증에서 제어 문자는 막혀 있음).
         FUNCTION piece(s VARCHAR2, sep VARCHAR2, n PLS_INTEGER) RETURN VARCHAR2 IS
           startpos PLS_INTEGER := 1;
           endpos PLS_INTEGER;
         BEGIN
           FOR i IN 1 .. n - 1 LOOP
             startpos := INSTR(s, sep, startpos);
             IF startpos = 0 THEN RETURN NULL; END IF;
             startpos := startpos + 1;
           END LOOP;
           endpos := INSTR(s, sep, startpos);
           IF endpos = 0 THEN endpos := LENGTH(s) + 1; END IF;
           RETURN SUBSTR(s, startpos, endpos - startpos);
         END;
         FUNCTION pieces(s VARCHAR2, sep VARCHAR2) RETURN PLS_INTEGER IS
         BEGIN
           IF s IS NULL THEN RETURN 0; END IF;
           RETURN LENGTH(s) - NVL(LENGTH(REPLACE(s, sep)), 0) + 1;
         END;
       BEGIN
         h := DBMS_DATAPUMP.OPEN(operation => :operation, job_mode => :jobMode, job_name => :jobName,
                                 remote_link => :networkLink);
         BEGIN
           -- NETWORK_LINK import는 링크 너머 DB에서 바로 가져오므로 덤프 파일이 없다.
           IF :dumpfile IS NOT NULL THEN
             DBMS_DATAPUMP.ADD_FILE(handle => h, filename => :dumpfile, directory => :directory,
                                    filesize => :filesize, filetype => DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE,
                                    reusefile => :reuse);
           END IF;
           DBMS_DATAPUMP.ADD_FILE(handle => h, filename => :logfile, directory => :directory,
                                  filetype => DBMS_DATAPUMP.KU$_FILE_TYPE_LOG_FILE, reusefile => 1);
           IF :schemaExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'SCHEMA_EXPR', value => :schemaExpr);
           END IF;
           IF :nameExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'NAME_EXPR', value => :nameExpr, object_path => 'TABLE');
           END IF;
           IF :excludeTableExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'NAME_EXPR', value => :excludeTableExpr, object_path => 'TABLE');
           END IF;
           -- 오브젝트 필터: 유형 포함/제외 (통계 제외도 여기 들어 있다)
           IF :includePathExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'INCLUDE_PATH_EXPR', value => :includePathExpr);
           END IF;
           IF :excludePathExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'EXCLUDE_PATH_EXPR', value => :excludePathExpr);
           END IF;
           -- 오브젝트 필터: 이름 조건 ("경로 CHR(31) 식"). 같은 유형에 여러 개면 AND로 합쳐진다.
           FOR i IN 1 .. pieces(:nameFilters, CHR(30)) LOOP
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'NAME_EXPR',
                                           value => piece(piece(:nameFilters, CHR(30), i), CHR(31), 2),
                                           object_path => piece(piece(:nameFilters, CHR(30), i), CHR(31), 1));
           END LOOP;
           -- 뷰를 테이블처럼 (OWNER.VIEW[:TEMPLATE]). 뷰만 있는 작업이면 실제 테이블은 뺀다.
           FOR i IN 1 .. pieces(:viewsAsTables, CHR(30)) LOOP
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'VIEWS_AS_TABLES', value => piece(:viewsAsTables, CHR(30), i));
           END LOOP;
           IF :excludeTablesOnly = 1 THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'EXCLUDE_TABLES', value => 'Y');
           END IF;
           -- 파티션 단위 export (expdp TABLES=OWNER.TAB:PART와 같음). 테이블마다 한 줄씩 "OWNER.TABLE:P1,P2;OWNER.TABLE2:P3"로 넘어오고,
           -- 하위 파티션이 있으면 그 파티션의 하위 파티션 전부. 이름은 서비스가 식별자 형식으로 검증한 값이라 따옴표를 붙여 IN 목록을 만든다.
           IF :partitionFilters IS NOT NULL THEN
             FOR r IN (SELECT REGEXP_SUBSTR(:partitionFilters, '[^;]+', 1, LEVEL) AS item FROM dual
                        CONNECT BY REGEXP_SUBSTR(:partitionFilters, '[^;]+', 1, LEVEL) IS NOT NULL) LOOP
               DBMS_DATAPUMP.DATA_FILTER(
                 handle => h, name => 'PARTITION_EXPR',
                 value => 'IN (''' || REPLACE(SUBSTR(r.item, INSTR(r.item, ':') + 1), ',', ''',''') || ''')',
                 table_name => SUBSTR(r.item, INSTR(r.item, '.') + 1, INSTR(r.item, ':') - INSTR(r.item, '.') - 1),
                 schema_name => SUBSTR(r.item, 1, INSTR(r.item, '.') - 1));
             END LOOP;
           END IF;
           IF :content = 'METADATA_ONLY' THEN
             DBMS_DATAPUMP.DATA_FILTER(handle => h, name => 'INCLUDE_ROWS', value => 0);
           ELSIF :content = 'DATA_ONLY' THEN
             DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'INCLUDE_METADATA', value => 0);
           END IF;
           -- QUERY (행 조건): "소유자 CHR(31) 테이블 CHR(31) WHERE절" — 소유자/테이블이 비면 모든 테이블
           FOR i IN 1 .. pieces(:queries, CHR(30)) LOOP
             DBMS_DATAPUMP.DATA_FILTER(handle => h, name => 'SUBQUERY',
                                       value => piece(piece(:queries, CHR(30), i), CHR(31), 3),
                                       table_name => piece(piece(:queries, CHR(30), i), CHR(31), 2),
                                       schema_name => piece(piece(:queries, CHR(30), i), CHR(31), 1));
           END LOOP;
           -- SAMPLE (비율, 소수점은 '.')
           FOR i IN 1 .. pieces(:samples, CHR(30)) LOOP
             DBMS_DATAPUMP.DATA_FILTER(handle => h, name => 'SAMPLE',
                                       value => TO_NUMBER(piece(piece(:samples, CHR(30), i), CHR(31), 3), '99999990D9999999', 'NLS_NUMERIC_CHARACTERS=''.,'''),
                                       table_name => piece(piece(:samples, CHR(30), i), CHR(31), 2),
                                       schema_name => piece(piece(:samples, CHR(30), i), CHR(31), 1));
           END LOOP;
           ${dataOptionsStatement(plan.filters.dataOptionConstants)}
           IF :flashbackScn IS NOT NULL THEN
             -- 여러 작업을 같은 시점으로 맞출 때: 화면이 미리 받아 둔 SCN을 모든 작업에 똑같이 건다.
             DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'FLASHBACK_SCN', value => TO_NUMBER(:flashbackScn));
           ELSIF :flashback = 1 THEN
             -- 시작 시점 SCN으로 고정해 테이블 간 일관성을 맞춘다 (expdp의 FLASHBACK_TIME=SYSTIMESTAMP와 같음).
             -- NETWORK_LINK 작업은 데이터를 읽는 쪽이 링크 너머 DB라 그 DB의 SCN이어야 한다
             -- (링크 이름은 서비스가 이 DB의 링크 목록과 대조해 검증한 값).
             IF :networkLink IS NOT NULL THEN
               EXECUTE IMMEDIATE 'SELECT current_scn FROM v$database@' || :networkLink INTO scn;
             ELSE
               SELECT current_scn INTO scn FROM v$database;
             END IF;
             DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'FLASHBACK_SCN', value => scn);
           END IF;
           IF :tableExistsAction IS NOT NULL THEN
             DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'TABLE_EXISTS_ACTION', value => :tableExistsAction);
           END IF;
           -- 목록이 비어 있어도 CONNECT BY는 LEVEL 1 행 하나를 돌려주므로, 비었으면 아예 건너뛴다.
           IF :remapSchemas IS NOT NULL THEN
             FOR r IN (SELECT REGEXP_SUBSTR(:remapSchemas, '[^,]+', 1, LEVEL) AS pair FROM dual
                        CONNECT BY REGEXP_SUBSTR(:remapSchemas, '[^,]+', 1, LEVEL) IS NOT NULL) LOOP
               DBMS_DATAPUMP.METADATA_REMAP(handle => h, name => 'REMAP_SCHEMA',
                                            old_value => SUBSTR(r.pair, 1, INSTR(r.pair, ':') - 1),
                                            value => SUBSTR(r.pair, INSTR(r.pair, ':') + 1));
             END LOOP;
           END IF;
           -- 목록이 비어 있어도 CONNECT BY는 LEVEL 1 행 하나를 돌려주므로, 비었으면 아예 건너뛴다.
           IF :remapTablespaces IS NOT NULL THEN
             FOR r IN (SELECT REGEXP_SUBSTR(:remapTablespaces, '[^,]+', 1, LEVEL) AS pair FROM dual
                        CONNECT BY REGEXP_SUBSTR(:remapTablespaces, '[^,]+', 1, LEVEL) IS NOT NULL) LOOP
               DBMS_DATAPUMP.METADATA_REMAP(handle => h, name => 'REMAP_TABLESPACE',
                                            old_value => SUBSTR(r.pair, 1, INSTR(r.pair, ':') - 1),
                                            value => SUBSTR(r.pair, INSTR(r.pair, ':') + 1));
             END LOOP;
           END IF;
           DBMS_DATAPUMP.SET_PARALLEL(handle => h, degree => :parallel);
           DBMS_DATAPUMP.START_JOB(handle => h);
           DBMS_DATAPUMP.DETACH(handle => h);
         EXCEPTION
           WHEN OTHERS THEN
             -- 정리(STOP_JOB) 중에 원래 에러가 지워지므로 먼저 받아 둔다. DBMS_DATAPUMP 에러(ORA-39001 등)는
             -- 그 자체로는 원인이 안 보여서, 작업이 남긴 에러 메시지(GET_STATUS)까지 붙인다.
             err := DBMS_UTILITY.FORMAT_ERROR_STACK;
             BEGIN
               DBMS_DATAPUMP.GET_STATUS(handle => h, mask => DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR, timeout => 0,
                                        job_state => job_state, status => sts);
               IF sts.error IS NOT NULL THEN
                 FOR i IN 1 .. sts.error.COUNT LOOP
                   err := err || CHR(10) || sts.error(i).LogText;
                 END LOOP;
               END IF;
             EXCEPTION
               WHEN OTHERS THEN NULL;
             END;
             BEGIN
               DBMS_DATAPUMP.STOP_JOB(handle => h, immediate => 1, keep_master => 0);
             EXCEPTION
               WHEN OTHERS THEN NULL;
             END;
             RAISE_APPLICATION_ERROR(-20001, SUBSTR(err, 1, 2000));
         END;
       END;`,
      {
        operation: plan.operation,
        jobMode: plan.jobMode,
        jobName: plan.jobName,
        dumpfile: plan.dumpfile,
        directory: plan.directory,
        filesize: plan.filesize,
        // 기존 덤프 덮어쓰기는 export에만 의미가 있다 (import는 읽기만 하므로 넘기지 않음).
        reuse: plan.operation === 'EXPORT' ? (plan.reuseDumpfiles ? 1 : 0) : null,
        logfile: plan.logfile,
        schemaExpr: plan.schemaExpr,
        nameExpr: plan.nameExpr,
        excludeTableExpr: plan.excludeTableExpr,
        flashbackScn: plan.flashbackScn,
        content: plan.content,
        flashback: plan.flashbackConsistent ? 1 : 0,
        tableExistsAction: plan.tableExistsAction,
        remapSchemas: plan.remapSchemas.map((pair) => `${pair.from}:${pair.to}`).join(',') || null,
        remapTablespaces: plan.remapTablespaces.map((pair) => `${pair.from}:${pair.to}`).join(',') || null,
        parallel: plan.parallel,
        networkLink: plan.networkLink,
        partitionFilters:
          plan.partitionFilters.map((filter) => `${filter.owner}.${filter.table}:${filter.partitions.join(',')}`).join(';') || null,
        includePathExpr: plan.filters.includePaths.length > 0 ? `IN (${plan.filters.includePaths.map((path) => `'${path}'`).join(',')})` : null,
        excludePathExpr: plan.filters.excludePaths.length > 0 ? `IN (${plan.filters.excludePaths.map((path) => `'${path}'`).join(',')})` : null,
        nameFilters: joinItems(plan.filters.nameFilters.map((filter) => [filter.path, filter.expr])),
        viewsAsTables: joinItems(plan.filters.viewsAsTables.map((view) => [view])),
        excludeTablesOnly: plan.filters.excludeTablesOnly ? 1 : 0,
        queries: joinItems(plan.filters.queries.map((query) => [query.owner ?? '', query.table ?? '', query.where])),
        samples: joinItems(plan.filters.samples.map((sample) => [sample.owner ?? '', sample.table ?? '', String(sample.percent)])),
      }
    );
  });
}

// ── Range 파티션 ──

export interface PartitionTableInfo {
  owner: string;
  name: string;
  keyColumn: string;
  keyType: string; // DATE, TIMESTAMP(6), VARCHAR2, NUMBER ...
  partitionCount: number;
  interval: string | null; // 인터벌 파티션이면 NUMTOYMINTERVAL(1,'MONTH') 같은 식
  subpartitioning: string | null; // NONE이 아니면 HASH/LIST/RANGE
}

export interface PartitionRow {
  name: string;
  position: number;
  highValue: string; // DBA_TAB_PARTITIONS.HIGH_VALUE 원문 (LONG)
  numRows: number | null; // 통계 기준
  bytes: number; // 테이블 세그먼트(하위 파티션 포함) + LOB 파티션 세그먼트
}

// 파티션 키가 컬럼 하나인 RANGE(인터벌 포함) 파티션 테이블.
async function getRangePartitionedTables(dbmsid: DbmsIdParam, owner: string): Promise<PartitionTableInfo[]> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(
      connection,
      `SELECT pt.owner, pt.table_name, pt.interval, pt.subpartitioning_type,
              -- INTERVAL 테이블의 DBA_PART_TABLES.PARTITION_COUNT는 최대치(1048575)라 실제 개수를 센다.
              (SELECT COUNT(*) FROM dba_tab_partitions tp WHERE tp.table_owner = pt.owner AND tp.table_name = pt.table_name) AS partition_count,
              kc.column_name, tc.data_type
         FROM dba_part_tables pt
         JOIN dba_part_key_columns kc ON kc.owner = pt.owner AND kc.name = pt.table_name AND TRIM(kc.object_type) = 'TABLE'
         JOIN dba_tab_columns tc ON tc.owner = pt.owner AND tc.table_name = pt.table_name AND tc.column_name = kc.column_name
        WHERE pt.owner = :owner
          AND pt.partitioning_type = 'RANGE'
          AND pt.partitioning_key_count = 1
          AND pt.table_name NOT LIKE 'BIN$%'
        ORDER BY pt.table_name`,
      { owner }
    );
    return rows.map(toPartitionTableInfo);
  });
}

function toPartitionTableInfo(row: Record<string, any>): PartitionTableInfo {
  return {
    owner: row.OWNER,
    name: row.TABLE_NAME,
    keyColumn: row.COLUMN_NAME,
    keyType: row.DATA_TYPE,
    partitionCount: Number(row.PARTITION_COUNT),
    interval: row.INTERVAL ?? null,
    subpartitioning: row.SUBPARTITIONING_TYPE && row.SUBPARTITIONING_TYPE !== 'NONE' ? row.SUBPARTITIONING_TYPE : null,
  };
}

// 테이블 하나의 파티션 목록. 테이블이 없거나 (컬럼 하나 키의) RANGE 파티션 테이블이 아니면 table = null.
// HIGH_VALUE가 LONG이라 집계/함수와 섞지 않도록 크기는 따로 조회해 붙인다.
async function loadTablePartitions(
  connection: oracledb.Connection,
  owner: string,
  table: string
): Promise<{ table: PartitionTableInfo | null; partitions: PartitionRow[] }> {
  const info = await query(
    connection,
    `SELECT pt.owner, pt.table_name, pt.interval, pt.subpartitioning_type,
            -- INTERVAL 테이블의 DBA_PART_TABLES.PARTITION_COUNT는 최대치(1048575)라 실제 개수를 센다.
            (SELECT COUNT(*) FROM dba_tab_partitions tp WHERE tp.table_owner = pt.owner AND tp.table_name = pt.table_name) AS partition_count,
            kc.column_name, tc.data_type
       FROM dba_part_tables pt
       JOIN dba_part_key_columns kc ON kc.owner = pt.owner AND kc.name = pt.table_name AND TRIM(kc.object_type) = 'TABLE'
       JOIN dba_tab_columns tc ON tc.owner = pt.owner AND tc.table_name = pt.table_name AND tc.column_name = kc.column_name
      WHERE pt.owner = :owner AND pt.table_name = :tableName
        AND pt.partitioning_type = 'RANGE' AND pt.partitioning_key_count = 1`,
    { owner, tableName: table }
  );
  if (info.length === 0) return { table: null, partitions: [] };

  const parts = await query(
    connection,
    `SELECT partition_name, partition_position, high_value, num_rows
       FROM dba_tab_partitions
      WHERE table_owner = :owner AND table_name = :tableName
      ORDER BY partition_position`,
    { owner, tableName: table }
  );
  const sizes = await query(
    connection,
    `WITH seg AS (
       SELECT partition_name, SUM(bytes) AS bytes
         FROM dba_segments
        WHERE owner = :owner AND segment_name = :tableName
        GROUP BY partition_name
     ), sub AS (
       SELECT sp.partition_name, SUM(seg.bytes) AS bytes
         FROM dba_tab_subpartitions sp
         JOIN seg ON seg.partition_name = sp.subpartition_name
        WHERE sp.table_owner = :owner AND sp.table_name = :tableName
        GROUP BY sp.partition_name
     ), lobp AS (
       SELECT lp.partition_name, SUM(s.bytes) AS bytes
         FROM dba_lob_partitions lp
         JOIN dba_segments s ON s.owner = lp.table_owner AND s.segment_name = lp.lob_name AND s.partition_name = lp.lob_partition_name
        WHERE lp.table_owner = :owner AND lp.table_name = :tableName
        GROUP BY lp.partition_name
     ), lobsub AS (
       -- 서브파티션 테이블이면 LOB 세그먼트도 서브파티션 단위라, 테이블 서브파티션을 거쳐 파티션에 붙인다.
       SELECT sp.partition_name, SUM(s.bytes) AS bytes
         FROM dba_lob_subpartitions ls
         JOIN dba_tab_subpartitions sp
           ON sp.table_owner = ls.table_owner AND sp.table_name = ls.table_name AND sp.subpartition_name = ls.subpartition_name
         JOIN dba_segments s ON s.owner = ls.table_owner AND s.segment_name = ls.lob_name AND s.partition_name = ls.lob_subpartition_name
        WHERE ls.table_owner = :owner AND ls.table_name = :tableName
        GROUP BY sp.partition_name
     )
     SELECT p.partition_name, NVL(seg.bytes, 0) + NVL(sub.bytes, 0) + NVL(lobp.bytes, 0) + NVL(lobsub.bytes, 0) AS bytes
       FROM dba_tab_partitions p
       LEFT JOIN seg ON seg.partition_name = p.partition_name
       LEFT JOIN sub ON sub.partition_name = p.partition_name
       LEFT JOIN lobp ON lobp.partition_name = p.partition_name
       LEFT JOIN lobsub ON lobsub.partition_name = p.partition_name
      WHERE p.table_owner = :owner AND p.table_name = :tableName`,
    { owner, tableName: table }
  );
  const bytesByName = new Map(sizes.map((row) => [row.PARTITION_NAME as string, Number(row.BYTES)]));
  return {
    table: toPartitionTableInfo(info[0]),
    partitions: parts.map((row) => ({
      name: row.PARTITION_NAME,
      position: Number(row.PARTITION_POSITION),
      highValue: String(row.HIGH_VALUE ?? ''),
      numRows: row.NUM_ROWS === null || row.NUM_ROWS === undefined ? null : Number(row.NUM_ROWS),
      bytes: bytesByName.get(row.PARTITION_NAME) ?? 0,
    })),
  };
}

async function getTablePartitions(
  dbmsid: DbmsIdParam,
  owner: string,
  table: string
): Promise<{ table: PartitionTableInfo | null; partitions: PartitionRow[] }> {
  return withConnection(dbmsid, (connection) => loadTablePartitions(connection, owner, table));
}

// 파티션 비우기 (파티션 단위 import 전). 글로벌 인덱스가 UNUSABLE이 되지 않게 UPDATE INDEXES.
// 이름은 서비스가 식별자 형식과 실제 존재 여부를 확인한 값만 들어온다 (DDL이라 바인드 불가 → 큰따옴표로 감싸 붙임).
async function truncatePartitions(dbmsid: DbmsIdParam, owner: string, table: string, partitions: string[]): Promise<void> {
  await withConnection(dbmsid, async (connection) => {
    for (const partition of partitions) {
      await connection.execute(`ALTER TABLE "${owner}"."${table}" TRUNCATE PARTITION "${partition}" UPDATE INDEXES`);
    }
  });
}

// 지금 DB에 남아 있는 Data Pump 작업 (실행 중/정지됨). 끝난 작업은 마스터 테이블이 지워지므로 여기 안 나옵니다.
async function getJobs(dbmsid: DbmsIdParam): Promise<DataPumpJob[]> {
  return withConnection(dbmsid, async (connection) => {
    const jobs = await query(
      connection,
      `SELECT owner_name, job_name, operation, job_mode, state, degree, attached_sessions
         FROM dba_datapump_jobs
        WHERE job_name NOT LIKE 'BIN$%'
        ORDER BY job_name DESC`
    );
    if (jobs.length === 0) return [];

    const binds: Record<string, string> = {};
    const names = jobs.map((job, index) => {
      binds[`j${index}`] = job.JOB_NAME;
      return `:j${index}`;
    });
    // 지난 시간: 작업이 시작될 때 작업 이름으로 만들어지는 마스터 테이블의 생성 시각 기준.
    const masters = await query(
      connection,
      `SELECT owner, object_name, ROUND((SYSDATE - created) * 86400) AS elapsed_sec
         FROM dba_objects
        WHERE object_type = 'TABLE' AND object_name IN (${names.join(', ')})`,
      binds
    );
    // 진행률/남은 시간: Data Pump가 작업 이름으로 V$SESSION_LONGOPS에 남기는 값 (SOFAR/TOTALWORK는 MB).
    // 작업에 ATTACH해서 GET_STATUS로 읽으면 작업 큐에 붙느라(sys.kupc$que_int.attach_queues) 락이 잡히고, 앱이 시작하지 않은
    // 작업(parfile로 직접 돌린 것, 멈춰 남은 것)까지 15초마다 붙게 되므로 쓰지 않는다 — 대상 DB에는 읽기 조회만.
    // LONGOPS를 안 남기는 버전/에디션(예: 23ai Free)이면 진행률은 비어 있고 지난 시간만 보인다.
    const longops = await query(
      connection,
      `SELECT opname, elapsed_seconds, time_remaining, sofar, totalwork
         FROM v$session_longops
        WHERE opname IN (${names.join(', ')})
        ORDER BY start_time DESC`,
      binds
    );

    const result: DataPumpJob[] = [];
    for (const job of jobs) {
      const master = masters.find((row) => row.OWNER === job.OWNER_NAME && row.OBJECT_NAME === job.JOB_NAME);
      const op = longops.find((row) => row.OPNAME === job.JOB_NAME);
      const elapsedSec: number | null = op?.ELAPSED_SECONDS ?? master?.ELAPSED_SEC ?? null;
      const doneMb: number | null = op ? Number(op.SOFAR) : null;
      const totalMb: number | null = op && Number(op.TOTALWORK) > 0 ? Number(op.TOTALWORK) : null;
      const pct = doneMb !== null && totalMb !== null ? Math.min(100, Math.round((doneMb / totalMb) * 1000) / 10) : null;
      // LONGOPS 값이 없으면 지금까지의 속도가 유지된다고 보고 어림한다: 지난 시간 × 남은 % / 진행된 %
      let remainingSec: number | null = op?.TIME_REMAINING ?? null;
      if (remainingSec === null && elapsedSec !== null && pct !== null && pct > 0 && pct < 100) {
        remainingSec = Math.round((elapsedSec * (100 - pct)) / pct);
      }
      result.push({
        owner: job.OWNER_NAME,
        jobName: job.JOB_NAME,
        operation: job.OPERATION,
        jobMode: job.JOB_MODE,
        state: job.STATE,
        degree: job.DEGREE,
        attachedSessions: job.ATTACHED_SESSIONS,
        progressPct: pct,
        progressMessage: null,
        elapsedSec,
        remainingSec,
        doneMb,
        totalMb,
      });
    }
    return result;
  });
}

// 작업 취소: 붙어서(ATTACH) 즉시 중지하고 마스터 테이블까지 지웁니다 (다시 시작할 수 없음 — KILL_JOB과 같음).
async function cancelJob(dbmsid: DbmsIdParam, owner: string, jobName: string): Promise<void> {
  await withConnection(dbmsid, async (connection) => {
    await connection.execute(
      `DECLARE
         h NUMBER;
       BEGIN
         h := DBMS_DATAPUMP.ATTACH(job_name => :jobName, job_owner => :owner);
         DBMS_DATAPUMP.STOP_JOB(handle => h, immediate => 1, keep_master => 0);
       END;`,
      { jobName, owner }
    );
  });
}

// parfile/실행 스크립트를 DB 서버의 DIRECTORY에 씁니다 (UTL_FILE). 파일마다:
//  - 이미 있고 overwrite가 아니면 건드리지 않고 skipped로 돌려줌 (화면이 확인받은 뒤 overwrite로 다시 호출)
//  - 아니면 내용을 8000자씩 나눠 써서 한 줄이 아주 긴 parfile(긴 EXCLUDE 목록)도 저장되게 함
async function writeFiles(
  dbmsid: DbmsIdParam,
  directory: string,
  files: { name: string; content: string }[],
  overwrite: boolean
): Promise<{ written: string[]; skipped: string[] }> {
  return withConnection(dbmsid, async (connection) => {
    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const result = await connection.execute<{ status: string }>(
        `DECLARE
           f UTL_FILE.FILE_TYPE;
           file_exists BOOLEAN;
           file_length NUMBER;
           block_size BINARY_INTEGER;
           total INTEGER := DBMS_LOB.GETLENGTH(:content);
           pos INTEGER := 1;
         BEGIN
           UTL_FILE.FGETATTR(:directory, :filename, file_exists, file_length, block_size);
           IF file_exists AND :overwrite = 0 THEN
             :status := 'EXISTS';
             RETURN;
           END IF;
           f := UTL_FILE.FOPEN(:directory, :filename, 'w', 32767);
           WHILE pos <= total LOOP
             UTL_FILE.PUT(f, DBMS_LOB.SUBSTR(:content, 8000, pos));
             UTL_FILE.FFLUSH(f);
             pos := pos + 8000;
           END LOOP;
           UTL_FILE.FCLOSE(f);
           :status := 'WRITTEN';
         EXCEPTION
           WHEN OTHERS THEN
             IF UTL_FILE.IS_OPEN(f) THEN UTL_FILE.FCLOSE(f); END IF;
             RAISE;
         END;`,
        {
          directory,
          filename: file.name,
          overwrite: overwrite ? 1 : 0,
          content: { val: file.content, type: oracledb.CLOB },
          status: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 20 },
        }
      );
      if (result.outBinds?.status === 'EXISTS') skipped.push(file.name);
      else written.push(file.name);
    }
    return { written, skipped };
  });
}

// 작업이 아직 대상 DB에 남아 있는지 (실행 중/정지됨). 끝난 작업은 마스터 테이블과 함께 사라진다.
async function jobExists(dbmsid: DbmsIdParam, owner: string, jobName: string): Promise<boolean> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(
      connection,
      `SELECT COUNT(*) AS n FROM dba_datapump_jobs WHERE owner_name = :owner AND job_name = :jobName`,
      { owner, jobName }
    );
    return Number(rows[0]?.N ?? 0) > 0;
  });
}

// DIRECTORY 안 파일들의 크기 (없는 파일은 결과에서 빠짐). 덤프 실제 크기 합계를 이력에 남기는 데 쓴다.
async function getFileSizes(dbmsid: DbmsIdParam, directory: string, filenames: string[]): Promise<Record<string, number>> {
  return withConnection(dbmsid, async (connection) => {
    const sizes: Record<string, number> = {};
    for (const filename of filenames) {
      const result = await connection.execute<{ len: number | null }>(
        `DECLARE
           file_exists BOOLEAN;
           file_length NUMBER;
           block_size BINARY_INTEGER;
         BEGIN
           UTL_FILE.FGETATTR(:directory, :filename, file_exists, file_length, block_size);
           :len := CASE WHEN file_exists THEN file_length END;
         END;`,
        { directory, filename, len: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } }
      );
      const len = result.outBinds?.len;
      if (len !== null && len !== undefined) sizes[filename] = len;
    }
    return sizes;
  });
}

// 로그 파일(과 파티션 export 매니페스트)은 DB 서버의 DIRECTORY에 있으므로 BFILE로 읽어 옵니다. 너무 크면 끝부분만 가져옵니다.
const MAX_LOG_BYTES = 512 * 1024;

async function readLog(dbmsid: DbmsIdParam, directory: string, filename: string, maxBytes: number = MAX_LOG_BYTES): Promise<LogContent> {
  return withConnection(dbmsid, async (connection) => {
    const result = await connection.execute<{ exists: number; truncated: number; content: oracledb.Lob | null }>(
      `DECLARE
         b BFILE;
         c CLOB;
         len INTEGER;
         src_off INTEGER := 1;
         dest_off INTEGER := 1;
         lang INTEGER := DBMS_LOB.DEFAULT_LANG_CTX;
         warn INTEGER;
       BEGIN
         b := BFILENAME(:directory, :filename);
         IF DBMS_LOB.FILEEXISTS(b) = 0 THEN
           :exists := 0;
           :truncated := 0;
           :content := NULL;
           RETURN;
         END IF;
         :exists := 1;
         DBMS_LOB.FILEOPEN(b, DBMS_LOB.FILE_READONLY);
         len := DBMS_LOB.GETLENGTH(b);
         IF len > :maxBytes THEN
           src_off := len - :maxBytes + 1;
           :truncated := 1;
         ELSE
           :truncated := 0;
         END IF;
         DBMS_LOB.CREATETEMPORARY(c, TRUE);
         IF len > 0 THEN
           DBMS_LOB.LOADCLOBFROMFILE(c, b, len - src_off + 1, dest_off, src_off, DBMS_LOB.DEFAULT_CSID, lang, warn);
         END IF;
         DBMS_LOB.FILECLOSE(b);
         :content := c;
       END;`,
      {
        directory,
        filename,
        maxBytes,
        exists: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        truncated: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        content: { dir: oracledb.BIND_OUT, type: oracledb.CLOB },
      }
    );
    const out = result.outBinds!;
    const text = out.content ? String(await out.content.getData()) : '';
    return { exists: out.exists === 1, text, truncated: out.truncated === 1 };
  });
}

export {
  getTargetInfo,
  getEdition,
  getDirectories,
  getDbLinks,
  getSchemas,
  getTableSizes,
  getListSizing,
  getFilterEnv,
  getViews,
  getCurrentScn,
  startJob,
  getJobs,
  cancelJob,
  jobExists,
  getFileSizes,
  writeFiles,
  readLog,
  getRangePartitionedTables,
  getTablePartitions,
  truncatePartitions,
};
