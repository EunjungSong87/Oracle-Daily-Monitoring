import oracledb from 'oracledb';
import * as db from '../db';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';

export interface PartitionRetentionRow {
  TABLE_OWNER: string;
  TABLE_NAME: string;
  COMMENTS: string | null;
  WORK_GROUP: string | null;
  STD_COLUMN: string | null;
  START_HIGHVALUE: string | null;
  END_HIGHVALUE: string | null;
  DELETE_CYCLE: string | null;
  RANGE_TYPE: string | null;
  PARTITION_YN: string | null;
  PARTITION_TYPE: string | null;
  OGG_SYNC_YN: string | null;
  STATUS: string | null;
  LAST_DEL_JOB_TIME: string | null;
  STD_DATE: string | null;
  MEMO: string | null;
}

// 대상 DBMS에 접속합니다 (statsJobModel/tableSpecModel과 동일한 방식).
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

// 파티션 테이블 보관주기(ILM) 관리 대상 목록은 PGDBA.DEL_JOB_TABLE_LIST 테이블에
// 등록돼 있습니다 (내부망 원본 스키마와 동일한 테이블명/계정). 접속 계정이 PGDBA가
// 아닐 수 있으므로 스키마를 명시해서 조회합니다.
async function getPartitionRetentionList(dbmsid: DbmsIdParam): Promise<PartitionRetentionRow[]> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const result = await connection.execute<Record<string, any>>(
      `SELECT TABLE_OWNER, TABLE_NAME, COMMENTS, WORK_GROUP, STD_COLUMN,
              START_HIGHVALUE, END_HIGHVALUE, DELETE_CYCLE, RANGE_TYPE,
              PARTITION_YN, PARTITION_TYPE, OGG_SYNC_YN, STATUS,
              LAST_DEL_JOB_TIME, STD_DATE, MEMO
         FROM PGDBA.DEL_JOB_TABLE_LIST
        ORDER BY TABLE_OWNER, TABLE_NAME`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []) as PartitionRetentionRow[];
  } catch (err) {
    console.error('파티션 보관주기(ILM) 목록 조회 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

export interface PartitionRetentionKey {
  dbmsid: DbmsIdParam['dbmsid'];
  tableOwner: string;
  tableName: string;
}

// 정책성 컬럼만 수정 대상입니다 — TABLE_OWNER/TABLE_NAME은 행을 식별하는 키라 여기서
// 바꾸지 않고(바꾸려면 삭제 후 재등록), STD_COLUMN/RANGE_TYPE/PARTITION_YN/PARTITION_TYPE/
// START_HIGHVALUE/END_HIGHVALUE/STD_DATE/LAST_DEL_JOB_TIME은 파티션 구조·잡 실행 결과라
// 이 화면에서는 읽기 전용으로 둡니다.
export interface PartitionRetentionUpdate extends PartitionRetentionKey {
  comments: string | null;
  workGroup: string | null;
  deleteCycle: string | null;
  status: string | null;
  oggSyncYn: string | null;
  memo: string | null;
}

async function updatePartitionRetention(input: PartitionRetentionUpdate): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget({ dbmsid: input.dbmsid });
    const result = await connection.execute(
      `UPDATE PGDBA.DEL_JOB_TABLE_LIST
          SET COMMENTS = :comments, WORK_GROUP = :workGroup, DELETE_CYCLE = :deleteCycle,
              STATUS = :status, OGG_SYNC_YN = :oggSyncYn, MEMO = :memo
        WHERE TABLE_OWNER = :tableOwner AND TABLE_NAME = :tableName`,
      {
        comments: input.comments,
        workGroup: input.workGroup,
        deleteCycle: input.deleteCycle,
        status: input.status,
        oggSyncYn: input.oggSyncYn,
        memo: input.memo,
        tableOwner: input.tableOwner,
        tableName: input.tableName,
      },
      { autoCommit: true }
    );
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('파티션 보관주기(ILM) 수정 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

// 신규 등록 시에는 테이블이 아직 없는 상태이므로, 수정 화면과 달리 파티션 구조
// 정보(STD_COLUMN/RANGE_TYPE/...)까지 함께 입력받습니다. LAST_DEL_JOB_TIME은 잡이
// 실제로 실행된 뒤 채워지는 결과 컬럼이라 등록 시점에는 비워둡니다.
export interface PartitionRetentionAdd {
  dbmsid: DbmsIdParam['dbmsid'];
  tableOwner: string;
  tableName: string;
  comments: string | null;
  workGroup: string | null;
  stdColumn: string | null;
  startHighvalue: string | null;
  endHighvalue: string | null;
  deleteCycle: string | null;
  rangeType: string | null;
  partitionYn: string | null;
  partitionType: string | null;
  oggSyncYn: string | null;
  status: string | null;
  stdDate: string | null;
  memo: string | null;
}

async function addPartitionRetention(input: PartitionRetentionAdd): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget({ dbmsid: input.dbmsid });

    const existing = await connection.execute<Record<string, any>>(
      `SELECT 1 FROM PGDBA.DEL_JOB_TABLE_LIST WHERE TABLE_OWNER = :tableOwner AND TABLE_NAME = :tableName`,
      { tableOwner: input.tableOwner, tableName: input.tableName }
    );
    if ((existing.rows?.length ?? 0) > 0) {
      throw new Error(`이미 등록된 테이블입니다: ${input.tableOwner}.${input.tableName}`);
    }

    const result = await connection.execute(
      `INSERT INTO PGDBA.DEL_JOB_TABLE_LIST
         (TABLE_OWNER, TABLE_NAME, COMMENTS, WORK_GROUP, STD_COLUMN, START_HIGHVALUE, END_HIGHVALUE,
          DELETE_CYCLE, RANGE_TYPE, PARTITION_YN, PARTITION_TYPE, OGG_SYNC_YN, STATUS, STD_DATE, MEMO)
       VALUES
         (:tableOwner, :tableName, :comments, :workGroup, :stdColumn, :startHighvalue, :endHighvalue,
          :deleteCycle, :rangeType, :partitionYn, :partitionType, :oggSyncYn, :status, :stdDate, :memo)`,
      {
        tableOwner: input.tableOwner,
        tableName: input.tableName,
        comments: input.comments,
        workGroup: input.workGroup,
        stdColumn: input.stdColumn,
        startHighvalue: input.startHighvalue,
        endHighvalue: input.endHighvalue,
        deleteCycle: input.deleteCycle,
        rangeType: input.rangeType,
        partitionYn: input.partitionYn,
        partitionType: input.partitionType,
        oggSyncYn: input.oggSyncYn,
        status: input.status,
        stdDate: input.stdDate,
        memo: input.memo,
      },
      { autoCommit: true }
    );
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('파티션 보관주기(ILM) 등록 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

export { getPartitionRetentionList, updatePartitionRetention, addPartitionRetention };
