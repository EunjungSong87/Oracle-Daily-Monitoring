import oracledb from 'oracledb';
import * as db from '../db';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';

export interface JobStatus {
  OWNER: string;
  JOB_NAME: string;
  ENABLED: string;
  STATE: string;
  LAST_START_DATE: string | null;
  NEXT_RUN_DATE: string | null;
  STATUS: string | null;
  ACTUAL_START_DATE: string | null;
  RUN_DURATION: string | null;
  ERRORS: string | null;
}

export interface StaleStatsRow {
  OWNER: string;
  TABLE_NAME: string;
  LAST_ANALYZED: string | null;
  NUM_ROWS: number | null;
}

// 대상 DBMS에 접속합니다 (tableSpecModel과 동일한 방식).
async function connectTarget(dbmsid: DbmsIdParam): Promise<oracledb.Connection> {
  const dbconfig = await dbmsModel.getDbmsInfo(dbmsid);
  if (!dbconfig) {
    throw new Error('DBMS 정보를 찾을 수 없습니다.');
  }
  const config = {
    user: dbconfig[0],
    password: dbconfig[1],
    connectString: dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4],
  };
  return db.connectDB(config);
}

// 특정 잡 이름 두 개를 하드코딩하지 않고 이름에 STAT이 들어간 사용자 잡을 전부 잡습니다 —
// 등록된 DB마다 잡 이름이 다를 수 있어서, 패턴으로 찾는 게 이 앱(여러 DB를 관리)에 맞습니다.
async function getJobStatus(dbmsid: DbmsIdParam): Promise<JobStatus[]> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const outFormat = { outFormat: oracledb.OUT_FORMAT_OBJECT };

    // ORACLE_MAINTAINED='N'으로 거르면 SYSTEM 계정도 딸려 나가서 빠집니다(이 계정도
    // Oracle 내부 계정으로 분류되어 있지만, 실제로는 이 앱이 관리하는 DB들에서 DBA가
    // 통계 수집 잡을 만드는 데 흔히 쓰는 계정입니다). 진짜 Oracle 내장 잡(SYS 소유)만 제외합니다.
    const jobsResult = await connection.execute<Record<string, any>>(
      `SELECT j.OWNER, j.JOB_NAME, j.ENABLED, j.STATE, j.LAST_START_DATE, j.NEXT_RUN_DATE
         FROM DBA_SCHEDULER_JOBS j
        WHERE j.OWNER != 'SYS'
          AND UPPER(j.JOB_NAME) LIKE '%STAT%'
        ORDER BY j.JOB_NAME`,
      {},
      outFormat
    );
    const jobs = jobsResult.rows ?? [];
    if (jobs.length === 0) return [];

    const binds: Record<string, any> = jobs.reduce((acc: Record<string, any>, row, idx) => {
      acc[`j${idx}`] = row.JOB_NAME;
      return acc;
    }, {});
    const inClause = jobs.map((_, idx) => `:j${idx}`).join(',');

    // RUN_DURATION은 INTERVAL DAY TO SECOND 타입이라 oracledb가 그대로 못 읽어서(NJS-010)
    // 문자열로 캐스팅해서 가져옵니다. ERRORS는 CLOB이라 fetchInfo로 문자열 변환합니다.
    const runsResult = await connection.execute<Record<string, any>>(
      `SELECT OWNER, JOB_NAME, STATUS, ACTUAL_START_DATE, RUN_DURATION, ERRORS
         FROM (
           SELECT OWNER, JOB_NAME, STATUS, ACTUAL_START_DATE,
                  TO_CHAR(RUN_DURATION) RUN_DURATION, ERRORS,
                  ROW_NUMBER() OVER (PARTITION BY OWNER, JOB_NAME ORDER BY ACTUAL_START_DATE DESC) rn
             FROM DBA_SCHEDULER_JOB_RUN_DETAILS
            WHERE JOB_NAME IN (${inClause})
         )
        WHERE rn = 1`,
      binds,
      { ...outFormat, fetchInfo: { ERRORS: { type: oracledb.STRING } } }
    );

    const latestRunByJob: Record<string, Record<string, any>> = {};
    (runsResult.rows ?? []).forEach((row) => {
      latestRunByJob[`${row.OWNER}.${row.JOB_NAME}`] = row;
    });

    return jobs.map((job) => {
      const run = latestRunByJob[`${job.OWNER}.${job.JOB_NAME}`];
      return {
        OWNER: job.OWNER,
        JOB_NAME: job.JOB_NAME,
        ENABLED: job.ENABLED,
        STATE: job.STATE,
        LAST_START_DATE: job.LAST_START_DATE,
        NEXT_RUN_DATE: job.NEXT_RUN_DATE,
        STATUS: run?.STATUS ?? null,
        ACTUAL_START_DATE: run?.ACTUAL_START_DATE ?? null,
        RUN_DURATION: run?.RUN_DURATION ?? null,
        ERRORS: run?.ERRORS ?? null,
      };
    });
  } catch (err) {
    console.error('통계 잡 현황 조회 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

async function getStaleStats(dbmsid: DbmsIdParam, thresholdDays: number): Promise<StaleStatsRow[]> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const result = await connection.execute<Record<string, any>>(
      `SELECT s.OWNER, s.TABLE_NAME, s.LAST_ANALYZED, s.NUM_ROWS
         FROM DBA_TAB_STATISTICS s
         JOIN DBA_USERS u ON u.USERNAME = s.OWNER
        WHERE u.ORACLE_MAINTAINED = 'N'
          AND s.OBJECT_TYPE = 'TABLE'
          AND (s.LAST_ANALYZED IS NULL OR s.LAST_ANALYZED < SYSDATE - :thresholdDays)
        ORDER BY s.LAST_ANALYZED NULLS FIRST, s.OWNER, s.TABLE_NAME`,
      { thresholdDays },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []) as StaleStatsRow[];
  } catch (err) {
    console.error('통계 미수집 테이블 조회 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

// jobName을 PL/SQL 블록에 바로 넣기 전에, 바인드 변수로 먼저 실제 존재하는 잡인지 확인합니다
// (식별자는 바인드로 못 넘기므로, 카탈로그에서 검증된 값만 문자열로 조립 — SQL 인젝션 방지).
async function runJob(dbmsid: DbmsIdParam, jobName: string): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const checkResult = await connection.execute<Record<string, any>>(
      `SELECT OWNER, JOB_NAME FROM DBA_SCHEDULER_JOBS WHERE JOB_NAME = :jobName`,
      { jobName },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = checkResult.rows?.[0];
    if (!row) {
      throw new Error('존재하지 않는 잡입니다.');
    }
    await connection.execute(
      `BEGIN DBMS_SCHEDULER.RUN_JOB('"${row.OWNER}"."${row.JOB_NAME}"', FALSE); END;`,
      [],
      { autoCommit: true }
    );
  } catch (err) {
    console.error('통계 잡 수동 실행 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

export { getJobStatus, getStaleStats, runJob };
