import oracledb from 'oracledb';
import * as db from '../db';

// 사용자별 화면 표시 예외 (메타데이터 DB의 system.user_screen_access — scripts/add_user_screen_access.sql).
// 역할 기본값과 다르게 둔 것만 행으로 남는다: visible 'Y' = 보이게, 'N' = 숨김.

async function withPool<T>(work: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    return await work(connection);
  } finally {
    if (connection) await connection.close();
  }
}

async function listForUser(userId: number): Promise<Map<string, boolean>> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT screen_key, visible FROM system.user_screen_access WHERE user_id = :userId`,
      { userId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return new Map((result.rows ?? []).map((row) => [row.SCREEN_KEY as string, row.VISIBLE === 'Y']));
  });
}

// 그 사용자의 예외를 통째로 바꾼다 (지우고 다시 넣기, 한 트랜잭션).
async function replaceForUser(userId: number, overrides: Map<string, boolean>, updatedBy: string | null): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(`DELETE FROM system.user_screen_access WHERE user_id = :userId`, { userId });
    const rows = [...overrides].map(([screenKey, visible]) => ({ userId, screenKey, visible: visible ? 'Y' : 'N', updatedBy }));
    if (rows.length > 0) {
      await connection.executeMany(
        `INSERT INTO system.user_screen_access (user_id, screen_key, visible, updated_by, updated_at)
         VALUES (:userId, :screenKey, :visible, :updatedBy, SYSDATE)`,
        rows
      );
    }
    await connection.commit();
  });
}

export { listForUser, replaceForUser };
