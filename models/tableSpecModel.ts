import oracledb from 'oracledb';
import * as db from '../db';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';

export interface TableSpec {
  tables: Record<string, any>[];
  columns: Record<string, any>[];
  constraints: Record<string, any>[];
  indexes: Record<string, any>[];
  grants: Record<string, any>[];
  synonyms: Record<string, any>[];
}

// 대상 DBMS에 접속합니다 (모니터링 대상 접속과 동일한 방식).
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

// Oracle이 기본 제공하는(사용자가 만들지 않은) 스키마를 제외하고 목록을 가져옵니다.
async function getSchemas(dbmsid: DbmsIdParam): Promise<string[]> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const query = `
      SELECT DISTINCT t.OWNER
        FROM DBA_TABLES t
        JOIN DBA_USERS u ON u.USERNAME = t.OWNER
       WHERE u.ORACLE_MAINTAINED = 'N'
       ORDER BY t.OWNER
    `;
    const result = await connection.execute<Record<string, any>>(query, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (result.rows ?? []).map((row) => row.OWNER);
  } catch (err) {
    console.error('스키마 목록 조회 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

async function getTables(dbmsid: DbmsIdParam, owner: string): Promise<string[]> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);
    const query = `SELECT TABLE_NAME FROM DBA_TABLES WHERE OWNER = :owner ORDER BY TABLE_NAME`;
    const result = await connection.execute<Record<string, any>>(query, { owner }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return (result.rows ?? []).map((row) => row.TABLE_NAME);
  } catch (err) {
    console.error('테이블 목록 조회 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

// 선택된 테이블들의 명세(코멘트/컬럼/제약조건/인덱스/권한/시노님)를 한 번에 조회합니다.
async function getTableSpec(dbmsid: DbmsIdParam, owner: string, tableNames: string[]): Promise<TableSpec> {
  let connection: oracledb.Connection | undefined;
  try {
    connection = await connectTarget(dbmsid);

    const binds: Record<string, any> = tableNames.reduce(
      (acc: Record<string, any>, name, idx) => {
        acc[`t${idx}`] = name;
        return acc;
      },
      { owner }
    );
    const inClause = tableNames.map((_, idx) => `:t${idx}`).join(',');

    const outFormat = { outFormat: oracledb.OUT_FORMAT_OBJECT };

    const tablesResult = await connection.execute<Record<string, any>>(
      `SELECT t.OWNER, t.TABLE_NAME, c.COMMENTS
         FROM DBA_TABLES t
         LEFT JOIN DBA_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
        WHERE t.OWNER = :owner AND t.TABLE_NAME IN (${inClause})
        ORDER BY t.TABLE_NAME`,
      binds,
      outFormat
    );

    const columnsResult = await connection.execute<Record<string, any>>(
      `SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_ID, c.COLUMN_NAME, c.DATA_TYPE,
              c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE,
              c.DATA_DEFAULT, cc.COMMENTS
         FROM DBA_TAB_COLUMNS c
         LEFT JOIN DBA_COL_COMMENTS cc
                ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.OWNER = :owner AND c.TABLE_NAME IN (${inClause})
        ORDER BY c.TABLE_NAME, c.COLUMN_ID`,
      binds,
      { ...outFormat, fetchInfo: { DATA_DEFAULT: { type: oracledb.STRING } } }
    );

    // SEARCH_CONDITION은 LONG 타입이라 LISTAGG/GROUP BY와 같은 쿼리에서 함께 못 씁니다(ORA-00997).
    // 그래서 제약조건 메타데이터와 CHECK 조건문을 쿼리 두 개로 나눠서 가져온 뒤 JS에서 합칩니다.
    const constraintsResult = await connection.execute<Record<string, any>>(
      `SELECT con.OWNER, con.TABLE_NAME, con.CONSTRAINT_NAME, con.CONSTRAINT_TYPE,
              con.R_CONSTRAINT_NAME, rcon.TABLE_NAME R_TABLE_NAME,
              LISTAGG(cc.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY cc.POSITION) COLUMNS
         FROM DBA_CONSTRAINTS con
         JOIN DBA_CONS_COLUMNS cc ON cc.OWNER = con.OWNER AND cc.CONSTRAINT_NAME = con.CONSTRAINT_NAME
         LEFT JOIN DBA_CONSTRAINTS rcon ON rcon.OWNER = con.R_OWNER AND rcon.CONSTRAINT_NAME = con.R_CONSTRAINT_NAME
        WHERE con.OWNER = :owner AND con.TABLE_NAME IN (${inClause})
          AND con.CONSTRAINT_TYPE IN ('P','R','U','C')
        GROUP BY con.OWNER, con.TABLE_NAME, con.CONSTRAINT_NAME, con.CONSTRAINT_TYPE,
                 con.R_CONSTRAINT_NAME, rcon.TABLE_NAME
        ORDER BY con.TABLE_NAME, con.CONSTRAINT_TYPE, con.CONSTRAINT_NAME`,
      binds,
      outFormat
    );

    const searchConditionResult = await connection.execute<Record<string, any>>(
      `SELECT OWNER, TABLE_NAME, CONSTRAINT_NAME, SEARCH_CONDITION
         FROM DBA_CONSTRAINTS
        WHERE OWNER = :owner AND TABLE_NAME IN (${inClause}) AND CONSTRAINT_TYPE = 'C'`,
      binds,
      { ...outFormat, fetchInfo: { SEARCH_CONDITION: { type: oracledb.STRING } } }
    );
    const searchConditionByConstraint: Record<string, string | null> = {};
    (searchConditionResult.rows ?? []).forEach((row) => {
      searchConditionByConstraint[row.CONSTRAINT_NAME] = row.SEARCH_CONDITION;
    });
    (constraintsResult.rows ?? []).forEach((row) => {
      row.SEARCH_CONDITION = searchConditionByConstraint[row.CONSTRAINT_NAME] || null;
    });

    const indexesResult = await connection.execute<Record<string, any>>(
      `SELECT i.OWNER, i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE,
              LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) COLUMNS
         FROM DBA_INDEXES i
         JOIN DBA_IND_COLUMNS ic ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
        WHERE i.OWNER = :owner AND i.TABLE_NAME IN (${inClause})
        GROUP BY i.OWNER, i.TABLE_NAME, i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE
        ORDER BY i.TABLE_NAME, i.INDEX_NAME`,
      binds,
      outFormat
    );

    const grantsResult = await connection.execute<Record<string, any>>(
      `SELECT OWNER, TABLE_NAME, GRANTEE, PRIVILEGE, GRANTABLE
         FROM DBA_TAB_PRIVS
        WHERE OWNER = :owner AND TABLE_NAME IN (${inClause})
        ORDER BY TABLE_NAME, GRANTEE, PRIVILEGE`,
      binds,
      outFormat
    );

    const synonymsResult = await connection.execute<Record<string, any>>(
      `SELECT TABLE_OWNER OWNER, TABLE_NAME, OWNER SYNONYM_OWNER, SYNONYM_NAME
         FROM DBA_SYNONYMS
        WHERE TABLE_OWNER = :owner AND TABLE_NAME IN (${inClause})
        ORDER BY TABLE_NAME, SYNONYM_OWNER, SYNONYM_NAME`,
      binds,
      outFormat
    );

    return {
      tables: tablesResult.rows ?? [],
      columns: columnsResult.rows ?? [],
      constraints: constraintsResult.rows ?? [],
      indexes: indexesResult.rows ?? [],
      grants: grantsResult.rows ?? [],
      synonyms: synonymsResult.rows ?? [],
    };
  } catch (err) {
    console.error('테이블 명세 조회 오류:', err);
    throw err;
  } finally {
    if (connection) await connection.close();
  }
}

export { getSchemas, getTables, getTableSpec };
