import oracledb from 'oracledb';
import { Duplex } from 'stream';
import db = require('../db'); // DB 연결 함수 가져오기

const { readClobAsString } = require('./clobUtils');
const { encrypt, decrypt } = require('./cryptoUtils');

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
          row[key] = await readClobAsString(val);
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
      'select ID, DBNAME, USERNAME, SID, IP, PORT, MEMO, CREATETIME, UPDATETIME from system.monitoring_dbms_list order by ID';
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
    const query = 'select username, password, ip, port, sid, memo from system.monitoring_dbms_list where id = :id ';
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

async function getMonResult(dbmsid: DbmsIdParam, id: number | string, sql: string): Promise<QueryResult | []> {
  let connection: oracledb.Connection | undefined;

  const dbconfig = await getDbmsInfo(dbmsid);
  if (!dbconfig) {
    throw new Error('DBMS 정보를 찾을 수 없습니다.');
  }
  console.log('Model 함수 안 dbconfig:', dbconfig[0], dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4]);

  try {
    const config = {
      user: dbconfig[0],
      password: dbconfig[1],
      connectString: dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4],
    };

    connection = await db.connectDB(config);
    const result = await executeQuery(connection as oracledb.Connection, sql);
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

module.exports = {
  getAllDbmses,
  getDbmsInfo,
  getMonResult,
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
};
