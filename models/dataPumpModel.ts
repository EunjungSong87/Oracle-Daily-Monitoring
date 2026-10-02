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
  dumpfile: string;
  logfile: string;
  filesize: string | null; // 예: '2G' — 덤프 파일 하나의 최대 크기
  parallel: number;
  schemaExpr: string | null; // METADATA_FILTER SCHEMA_EXPR, 예: IN ('HR','SCOTT')
  nameExpr: string | null; // METADATA_FILTER NAME_EXPR (테이블 모드), 예: IN ('EMP','DEPT')
  excludeTableExpr: string | null; // 스키마 모드에서 빼는 테이블 (분할 시 다른 작업으로 떼어 낸 큰 테이블), 예: NOT IN ('BIG1')
  content: 'ALL' | 'METADATA_ONLY' | 'DATA_ONLY';
  excludeStatistics: boolean;
  reuseDumpfiles: boolean; // EXPORT
  flashbackConsistent: boolean; // EXPORT — 시작 시점 SCN으로 일관성 있게
  flashbackScn: string | null; // EXPORT — 여러 작업을 같은 시점으로 맞출 때 지정 SCN (없으면 작업 시작 시점)
  tableExistsAction: 'SKIP' | 'APPEND' | 'TRUNCATE' | 'REPLACE' | null; // IMPORT
  remapSchemas: { from: string; to: string }[]; // IMPORT
  remapTablespaces: { from: string; to: string }[]; // IMPORT
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

async function getSchemas(dbmsid: DbmsIdParam): Promise<string[]> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(connection, `SELECT username FROM dba_users WHERE oracle_maintained = 'N' ORDER BY username`);
    return rows.map((row) => row.USERNAME);
  });
}

// 테이블별 크기 = 테이블 세그먼트(파티션/서브파티션 포함) + 그 테이블 LOB 컬럼의 LOB 세그먼트.
// 인덱스는 덤프에 DDL만 들어가고 데이터는 없으므로 뺍니다. 세그먼트는 할당된 공간이라 실제 덤프는 보통 이보다 작습니다.
// 세그먼트를 한 번만 훑도록 소유자 단위로 미리 합산한 뒤 테이블에 붙입니다 (테이블마다 서브쿼리를 돌리면 대형 DB에서 느림).
async function getTableSizes(dbmsid: DbmsIdParam, owners: string[]): Promise<TableSize[]> {
  if (owners.length === 0) return [];
  return withConnection(dbmsid, async (connection) => {
    const binds: Record<string, string> = {};
    const list = owners
      .map((owner, index) => {
        binds[`o${index}`] = owner;
        return `:o${index}`;
      })
      .join(', ');
    const rows = await query(
      connection,
      `WITH seg AS (
         SELECT owner, segment_name, SUM(bytes) AS bytes
           FROM dba_segments
          WHERE owner IN (${list})
            AND segment_type IN ('TABLE', 'TABLE PARTITION', 'TABLE SUBPARTITION', 'NESTED TABLE')
          GROUP BY owner, segment_name
       ), lob AS (
         SELECT l.owner, l.table_name, SUM(s.bytes) AS bytes
           FROM dba_lobs l
           JOIN dba_segments s ON s.owner = l.owner AND s.segment_name = l.segment_name
          WHERE l.owner IN (${list})
          GROUP BY l.owner, l.table_name
       )
       SELECT t.owner, t.table_name, NVL(seg.bytes, 0) + NVL(lob.bytes, 0) AS bytes
         FROM dba_tables t
         LEFT JOIN seg ON seg.owner = t.owner AND seg.segment_name = t.table_name
         LEFT JOIN lob ON lob.owner = t.owner AND lob.table_name = t.table_name
        WHERE t.owner IN (${list})
          AND t.table_name NOT LIKE 'BIN$%'
          AND t.nested = 'NO' AND t.secondary = 'N'
          AND (t.iot_type IS NULL OR t.iot_type = 'IOT')
        ORDER BY t.owner, t.table_name`,
      binds
    );
    return rows.map((row) => ({ owner: row.OWNER, name: row.TABLE_NAME, bytes: Number(row.BYTES) }));
  });
}

// 여러 export 작업을 같은 시점의 데이터로 맞추기 위한 현재 SCN (모든 작업에 FLASHBACK_SCN으로 넘김).
// SCN은 JS number 정밀도를 넘을 수 있어 문자열로 받습니다.
async function getCurrentScn(dbmsid: DbmsIdParam): Promise<string> {
  return withConnection(dbmsid, async (connection) => {
    const rows = await query(connection, `SELECT TO_CHAR(current_scn) AS scn FROM v$database`);
    return rows[0].SCN;
  });
}

// DBMS_DATAPUMP로 작업을 시작하고 바로 DETACH합니다 (작업은 DB 서버에서 계속 돌고, 화면은 작업 목록/로그로 지켜봄).
// 시작 단계에서 실패하면 만들어진 작업(마스터 테이블)이 남지 않게 정리하고 원래 에러를 다시 던집니다.
async function startJob(dbmsid: DbmsIdParam, plan: DataPumpPlan): Promise<void> {
  await withConnection(dbmsid, async (connection) => {
    await connection.execute(
      `DECLARE
         h NUMBER;
         scn NUMBER;
         err VARCHAR2(32767);
         job_state VARCHAR2(30);
         sts ku$_Status;
       BEGIN
         h := DBMS_DATAPUMP.OPEN(operation => :operation, job_mode => :jobMode, job_name => :jobName);
         BEGIN
           DBMS_DATAPUMP.ADD_FILE(handle => h, filename => :dumpfile, directory => :directory,
                                  filesize => :filesize, filetype => DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE,
                                  reusefile => :reuse);
           DBMS_DATAPUMP.ADD_FILE(handle => h, filename => :logfile, directory => :directory,
                                  filetype => DBMS_DATAPUMP.KU$_FILE_TYPE_LOG_FILE, reusefile => 1);
           IF :schemaExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'SCHEMA_EXPR', value => :schemaExpr);
           END IF;
           IF :nameExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'NAME_EXPR', value => :nameExpr, object_type => 'TABLE');
           END IF;
           IF :excludeTableExpr IS NOT NULL THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'NAME_EXPR', value => :excludeTableExpr, object_type => 'TABLE');
           END IF;
           IF :content = 'METADATA_ONLY' THEN
             DBMS_DATAPUMP.DATA_FILTER(handle => h, name => 'INCLUDE_ROWS', value => 0);
           ELSIF :content = 'DATA_ONLY' THEN
             DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'INCLUDE_METADATA', value => 0);
           END IF;
           IF :excludeStats = 1 THEN
             DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'EXCLUDE_PATH_EXPR', value => 'LIKE ''%STATISTICS%''');
           END IF;
           IF :flashbackScn IS NOT NULL THEN
             -- 여러 작업을 같은 시점으로 맞출 때: 화면이 미리 받아 둔 SCN을 모든 작업에 똑같이 건다.
             DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'FLASHBACK_SCN', value => TO_NUMBER(:flashbackScn));
           ELSIF :flashback = 1 THEN
             -- 시작 시점 SCN으로 고정해 테이블 간 일관성을 맞춘다 (expdp의 FLASHBACK_TIME=SYSTIMESTAMP와 같음).
             SELECT current_scn INTO scn FROM v$database;
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
        excludeStats: plan.excludeStatistics ? 1 : 0,
        flashback: plan.flashbackConsistent ? 1 : 0,
        tableExistsAction: plan.tableExistsAction,
        remapSchemas: plan.remapSchemas.map((pair) => `${pair.from}:${pair.to}`).join(',') || null,
        remapTablespaces: plan.remapTablespaces.map((pair) => `${pair.from}:${pair.to}`).join(',') || null,
        parallel: plan.parallel,
      }
    );
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
    // 남은 시간: Data Pump가 작업 이름으로 V$SESSION_LONGOPS에 남기는 값 (버전/에디션에 따라 안 남기도 함 — 예: 23ai Free).
    const longops = await query(
      connection,
      `SELECT opname, elapsed_seconds, time_remaining
         FROM v$session_longops
        WHERE opname IN (${names.join(', ')})
        ORDER BY start_time DESC`,
      binds
    );

    const result: DataPumpJob[] = [];
    for (const job of jobs) {
      const status = await readJobStatus(connection, job.OWNER_NAME, job.JOB_NAME);
      const master = masters.find((row) => row.OWNER === job.OWNER_NAME && row.OBJECT_NAME === job.JOB_NAME);
      const op = longops.find((row) => row.OPNAME === job.JOB_NAME);
      const elapsedSec: number | null = op?.ELAPSED_SECONDS ?? master?.ELAPSED_SEC ?? null;
      const pct = status?.pct ?? null;
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
        doneMb: status?.doneBytes !== null && status?.doneBytes !== undefined ? Math.round(status.doneBytes / 1048576) : null,
        totalMb: status?.totalBytes ? Math.round(status.totalBytes / 1048576) : null,
      });
    }
    return result;
  });
}

// 진행 상태는 DBMS_DATAPUMP의 공식 조회로 읽는다: 잠깐 붙어서(ATTACH) 상태만 받고 바로 떨어진다(DETACH).
// 작업 자체에는 영향이 없다. 막 시작했거나 끝나는 중이라 붙을 수 없으면 null.
async function readJobStatus(
  connection: oracledb.Connection,
  owner: string,
  jobName: string
): Promise<{ pct: number | null; doneBytes: number | null; totalBytes: number | null } | null> {
  try {
    const result = await connection.execute<{ pct: number | null; done: number | null; total: number | null }>(
      `DECLARE
         h NUMBER;
         job_state VARCHAR2(30);
         sts ku$_Status;
       BEGIN
         h := DBMS_DATAPUMP.ATTACH(job_name => :jobName, job_owner => :owner);
         BEGIN
           DBMS_DATAPUMP.GET_STATUS(handle => h, mask => DBMS_DATAPUMP.KU$_STATUS_JOB_STATUS, timeout => 0,
                                    job_state => job_state, status => sts);
           IF sts.job_status IS NOT NULL THEN
             :pct := sts.job_status.percent_done;
             :done := sts.job_status.bytes_processed;
             :total := sts.job_status.total_bytes;
           END IF;
           DBMS_DATAPUMP.DETACH(handle => h);
         EXCEPTION
           WHEN OTHERS THEN
             DBMS_DATAPUMP.DETACH(handle => h);
             RAISE;
         END;
       END;`,
      {
        jobName,
        owner,
        pct: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        done: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        total: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      }
    );
    const out = result.outBinds!;
    return { pct: out.pct, doneBytes: out.done, totalBytes: out.total };
  } catch {
    return null;
  }
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

// 로그 파일은 DB 서버의 DIRECTORY에 있으므로 BFILE로 읽어 옵니다. 너무 크면 끝부분만 가져옵니다.
const MAX_LOG_BYTES = 512 * 1024;

async function readLog(dbmsid: DbmsIdParam, directory: string, filename: string): Promise<LogContent> {
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
        maxBytes: MAX_LOG_BYTES,
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
  getSchemas,
  getTableSizes,
  getCurrentScn,
  startJob,
  getJobs,
  cancelJob,
  jobExists,
  getFileSizes,
  writeFiles,
  readLog,
};
