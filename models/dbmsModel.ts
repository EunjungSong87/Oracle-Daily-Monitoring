import oracledb from 'oracledb';
import { Duplex } from 'stream';
import * as db from '../db'; // DB 연결 함수 가져오기
import { readClobAsString } from './clobUtils';
import { encrypt, decrypt } from './cryptoUtils';

export interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
}

export interface DbmsIdParam {
  dbmsid: number | string;
}

export interface DbmsInfo {
  id?: number | string;
  dbname: string;
  username: string;
  password?: string;
  sid: string;
  ip: string;
  port: string;
  memo?: string;
}

export interface ScriptInfo {
  id: number | string;
  name: string;
  category?: string;
  description?: string;
  sql_text: string;
  schedule?: string;
  is_active: string;
}

export interface ScheduleConfig {
  enabled: string; // 'Y' | 'N'
  runTime: string; // 'HH:MM'
}

export interface ThresholdInfo {
  id?: number | string;
  task_id: number | string;
  column_name: string;
  condition_type: string;
  operator: string;
  threshold: string;
  clevel: string;
  message?: string;
  is_active: string;
}

async function executeQuery(
  connection: oracledb.Connection,
  query: string,
  params: oracledb.BindParameters = []
): Promise<QueryResult> {
  try {
    const result = await connection.execute<Record<string, any>>(query, params, {
      outFormat: oracledb.OUT_FORMAT_OBJECT, // 객체 형식으로 반환
    });

    for (const row of result.rows ?? []) {
      for (const key of Object.keys(row)) {
        const val = row[key];
        // row data가 LOB 데이턴지 확인
        if (val instanceof Duplex) {
          // Lob은 실제로 Duplex를 상속하지만 구조적으로는 다른 인터페이스라 명시적으로 캐스팅합니다.
          row[key] = await readClobAsString(val as unknown as oracledb.Lob);
        }
      }
    }

    // 컬럼명과 데이터 반환
    return {
      columns: (result.metaData ?? []).map((col) => col.name),
      rows: result.rows ?? [],
    };
  } catch (err) {
    console.error(err);
    throw err;
  }
}

async function getAllDbmses(): Promise<QueryResult> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const query =
      'select ID, DBNAME, USERNAME, SID, IP, PORT, MEMO, CREATETIME, UPDATETIME, AUTO_SCHEDULE from system.monitoring_dbms_list order by ID';
    return await executeQuery(connection, query);
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function getScripts(): Promise<QueryResult> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const query =
      'select id, name, category, description, schedule, is_active, CREATED_AT, UPDATED_AT from SYSTEM.MONITORING_TASKS';
    return await executeQuery(connection, query);
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function getDbmsInfo(dbmsid: DbmsIdParam): Promise<any[] | null> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const { dbmsid: id } = dbmsid;
    console.log('dbmsid 값', id);
    // dbname은 맨 뒤에 추가: 기존 코드가 dbconfig[0]~[5]를 위치로 접근하므로 순서를 바꾸면 안 됨.
    const query =
      'select username, password, ip, port, sid, memo, dbname from system.monitoring_dbms_list where id = :id ';
    const result = await connection.execute<any[]>(query, { id });

    // 4. 결과 반환
    console.log('getDbmsInfo 수행', result.rows?.length, '건');
    // 조회 결과 반환 (결과가 없으면 undefined 반환), 비밀번호는 복호화해서 반환
    if (!result.rows || result.rows.length === 0) return null;
    const row = result.rows[0];
    row[1] = decrypt(row[1]);
    return row;
  } catch (err) {
    console.error('DB 조회 오류:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function getSqlText(scriptid: { id: number | string }): Promise<string | null> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const id = scriptid.id;
    console.log('scriptid 값', id);
    const query = 'select id, name, sql_text from system.MONITORING_TASKS where id = :id ';
    const result = await connection.execute<any[]>(query, { id }, { fetchInfo: { SQL_TEXT: { type: oracledb.STRING } } });

    // 결과 반환 (결과가 없으면 null 반환)
    if (!result.rows || result.rows.length === 0) return null;
    console.log('getSqlText Model 함수 결과값', result.rows[0][2]);
    return result.rows[0][2];
  } catch (err) {
    console.error('Model SQL TEST 갖고 오기 오류:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function listTasks(): Promise<oracledb.Result<any[]> | []> {
  let connection: oracledb.Connection | undefined;

  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const query = `SELECT id, name, sql_text FROM monitoring_tasks WHERE is_active = 'Y' order by id `;
    const result = await connection.execute<any[]>(query, {}, { fetchInfo: { SQL_TEXT: { type: oracledb.STRING } } });

    // 조회 결과 반환 (결과가 없으면 undefined 반환)
    return result || [];
  } catch (err) {
    console.error('DB 조회 오류:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

// 대상 DBMS에 접속합니다. 체크를 여러 개 돌릴 때는 태스크마다 새로 열지 말고
// 이 커넥션 하나를 재사용한 뒤 호출한 쪽에서 한 번만 닫아야 합니다.
async function connectToTarget(dbconfig: any[]): Promise<oracledb.Connection> {
  console.log('Model 함수 안 dbconfig:', dbconfig[0], dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4]);
  const config = {
    user: dbconfig[0],
    password: dbconfig[1],
    connectString: dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4],
  };
  return db.connectDB(config);
}

async function addDbms(dbmsInfo: DbmsInfo): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql =
      'INSERT INTO system.monitoring_dbms_list (id, dbname, username, password, sid, ip, port, memo, createtime, updatetime) VALUES (seq_monitoring_dbms_list.nextval, :dbname, :username, :password, :sid, :ip, :port, :memo, sysdate, sysdate) ';
    console.log('MODEL : dbmsInfo:', { ...dbmsInfo, password: '***' });
    const bindParams = { ...dbmsInfo, password: encrypt(dbmsInfo.password) };

    const result = await connection.execute(sql, bindParams, { autoCommit: true });

    console.log('Insert Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function modifyDbms(dbmsInfo: DbmsInfo): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    // 비밀번호를 비워두고 수정하면 기존 저장된 비밀번호를 유지합니다.
    const hasNewPassword = dbmsInfo.password != null && dbmsInfo.password !== '';
    const sql = hasNewPassword
      ? `update system.monitoring_dbms_list
             set DBNAME = :dbname, username = :username, password = :password, sid = :sid,
                 ip = :ip, port = :port, memo = :memo, updatetime = sysdate
             where id = :id `
      : `update system.monitoring_dbms_list
             set DBNAME = :dbname, username = :username, sid = :sid,
                 ip = :ip, port = :port, memo = :memo, updatetime = sysdate
             where id = :id `;

    console.log('MODEL : dbmsInfo:', { ...dbmsInfo, password: '***' });
    const { password, ...withoutPassword } = dbmsInfo;
    const bindParams = hasNewPassword ? { ...dbmsInfo, password: encrypt(dbmsInfo.password) } : withoutPassword;

    const result = await connection.execute(sql, bindParams, { autoCommit: true }); // bind 묶음 넣기

    console.log('Update Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function deleteDbms(dbmsId: Record<string, any>): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql = 'delete from system.monitoring_dbms_list where id = :dbmsId';
    console.log('MODEL : dbmsInfo:', dbmsId);

    const result = await connection.execute(sql, dbmsId, { autoCommit: true });

    console.log('Delete Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function modifyScript(scriptInfo: ScriptInfo): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql = `update system.monitoring_tasks
                      set name = :name, category = :category, description = :description, sql_text = :sql_text,
                          schedule = :schedule, is_active = :is_active, UPDATED_AT = sysdate
                          where id = :id `;

    const result = await connection.execute(sql, scriptInfo as unknown as oracledb.BindParameters, { autoCommit: true }); // bind 묶음 넣기

    console.log('Update Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function addScript(scriptInfo: ScriptInfo): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql = `INSERT INTO system.MONITORING_TASKS (id, name, category, description, sql_text, schedule, is_active, CREATED_AT, UPDATED_AT)
                   VALUES (:id, :name, :category, :description, :sql_text, :schedule, :is_active, sysdate, sysdate) `;

    console.log('MODEL : scriptInfo:', scriptInfo);

    const result = await connection.execute(sql, scriptInfo as unknown as oracledb.BindParameters, { autoCommit: true });

    console.log('Insert Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function deleteScript(scriptId: Record<string, any>): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql = 'delete from SYSTEM.MONITORING_TASKS where id = :scriptId';
    console.log('MODEL : dbmsInfo:', scriptId);

    const result = await connection.execute(sql, scriptId, { autoCommit: true });

    console.log('Delete Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function getThresholds(): Promise<QueryResult> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const query = `select t.id, t.task_id, m.name task_name, t.column_name, t.condition_type,
                            t.operator, t.threshold, t.clevel, t.message, t.is_active
                       from system.monitoring_thresholds t
                       join system.monitoring_tasks m on m.id = t.task_id
                      order by t.id`;
    return await executeQuery(connection, query);
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

// 활성화된 임계치 규칙만 평가용으로 가져옵니다 (task_id별로 매칭).
async function getActiveThresholds(): Promise<Record<string, any>[]> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const query = `select task_id, column_name, condition_type, operator, threshold, clevel, message
                       from system.monitoring_thresholds
                      where is_active = 'Y'`;
    const result = await executeQuery(connection, query);
    return result.rows;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function addThreshold(thresholdInfo: ThresholdInfo): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const maxRes = await connection.execute<any[]>('select nvl(max(id),0)+1 as nextid from system.monitoring_thresholds');
    const nextId = maxRes.rows?.[0][0];
    const sql = `insert into system.monitoring_thresholds
                      (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
                   values (:id, :task_id, :column_name, :condition_type, :operator, :threshold, :clevel, :message, :is_active, sysdate)`;
    console.log('MODEL : thresholdInfo:', thresholdInfo);
    const bindParams = { id: nextId, ...thresholdInfo };

    const result = await connection.execute(sql, bindParams, { autoCommit: true });

    console.log('Threshold Insert Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function modifyThreshold(thresholdInfo: ThresholdInfo): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql = `update system.monitoring_thresholds
                      set task_id = :task_id, column_name = :column_name, condition_type = :condition_type,
                          operator = :operator, threshold = :threshold, clevel = :clevel,
                          message = :message, is_active = :is_active
                    where id = :id`;
    console.log('MODEL : thresholdInfo:', thresholdInfo);

    const result = await connection.execute(sql, thresholdInfo as unknown as oracledb.BindParameters, { autoCommit: true });

    console.log('Threshold Update Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function deleteThreshold(thresholdId: Record<string, any>): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql = 'delete from system.monitoring_thresholds where id = :thresholdId';
    console.log('MODEL : thresholdId:', thresholdId);

    const result = await connection.execute(sql, thresholdId, { autoCommit: true });

    console.log('Threshold Delete Success:', result.rowsAffected);
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

// 예약 실행(자동 점검) 설정을 조회합니다. 설정 행이 없으면 기본값(미사용)을 반환합니다.
async function getScheduleConfig(): Promise<ScheduleConfig> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const query = 'select enabled, run_time from system.monitoring_schedule_config where id = 1';
    const result = await connection.execute<any[]>(query);
    if (!result.rows || result.rows.length === 0) {
      return { enabled: 'N', runTime: '07:00' };
    }
    const [enabled, runTime] = result.rows[0];
    return { enabled, runTime };
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function saveScheduleConfig(config: ScheduleConfig): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const sql = `update system.monitoring_schedule_config
                    set enabled = :enabled, run_time = :runTime, updatetime = TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS')
                  where id = 1`;
    const result = await connection.execute(sql, config as unknown as oracledb.BindParameters, { autoCommit: true });
    return result.rowsAffected ?? 0;
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

// 자동 실행 대상 DB 목록을 지정한 id 집합으로 갱신합니다 (그 외는 전부 대상 해제).
async function setAutoScheduleTargets(dbmsIds: (number | string)[]): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    await connection.execute("update system.monitoring_dbms_list set auto_schedule = 'N'", {}, { autoCommit: false });

    if (dbmsIds.length > 0) {
      const binds: Record<string, any> = dbmsIds.reduce((acc: Record<string, any>, id, idx) => {
        acc[`id${idx}`] = id;
        return acc;
      }, {});
      const inClause = dbmsIds.map((_, idx) => `:id${idx}`).join(',');
      await connection.execute(
        `update system.monitoring_dbms_list set auto_schedule = 'Y' where id in (${inClause})`,
        binds,
        { autoCommit: false }
      );
    }

    await connection.commit();
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

// 자동 실행 대상으로 지정된 DB 목록을 가져옵니다.
async function getAutoScheduleDbmses(): Promise<QueryResult> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const query = "select ID, DBNAME from system.monitoring_dbms_list where auto_schedule = 'Y' order by ID";
    return await executeQuery(connection, query);
  } catch (err) {
    console.error('Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

export {
  getAllDbmses,
  getDbmsInfo,
  connectToTarget,
  executeQuery,
  addDbms,
  modifyDbms,
  deleteDbms,
  listTasks,
  getScripts,
  getSqlText,
  modifyScript,
  addScript,
  deleteScript,
  getThresholds,
  getActiveThresholds,
  addThreshold,
  modifyThreshold,
  deleteThreshold,
  getScheduleConfig,
  saveScheduleConfig,
  setAutoScheduleTargets,
  getAutoScheduleDbmses,
};
