import oracledb from 'oracledb';
import * as db from '../db';
import { hashPassword } from './passwordUtils';

export type UserRole = 'VIEWER' | 'DBA' | 'SUPER_ADMIN';

export interface UserSummary {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserWithHash extends UserSummary {
  passwordHash: string;
}

export interface UserBasic {
  username: string;
  displayName: string | null;
}

export interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}

function mapUserSummary(row: Record<string, any>): UserSummary {
  return {
    id: row.ID,
    username: row.USERNAME,
    displayName: row.DISPLAY_NAME,
    role: row.ROLE,
    isActive: row.IS_ACTIVE === 'Y',
    createdAt: row.CREATED_AT,
    lastLoginAt: row.LAST_LOGIN_AT,
  };
}

async function findByUsername(username: string): Promise<UserWithHash | null> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const result = await connection.execute<Record<string, any>>(
      `select id, username, password_hash, display_name, role, is_active, created_at, last_login_at
         from system.users
        where username = :username`,
      { username },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    if (!row) return null;
    return { ...mapUserSummary(row), passwordHash: row.PASSWORD_HASH };
  } finally {
    if (connection) await connection.close();
  }
}

// assignee 검증/선택용 — 비밀번호 해시 없이, 활성 계정만.
async function findBasicByUsername(username: string): Promise<UserBasic | null> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const result = await connection.execute<Record<string, any>>(
      `select username, display_name from system.users where username = :username and is_active = 'Y'`,
      { username },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    if (!row) return null;
    return { username: row.USERNAME, displayName: row.DISPLAY_NAME };
  } finally {
    if (connection) await connection.close();
  }
}

async function listUsers(): Promise<UserSummary[]> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const result = await connection.execute<Record<string, any>>(
      `select id, username, display_name, role, is_active, created_at, last_login_at
         from system.users
        order by username`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map(mapUserSummary);
  } finally {
    if (connection) await connection.close();
  }
}

// 담당자 지정 드롭다운용 — 활성 계정만.
async function listBasic(): Promise<UserBasic[]> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const result = await connection.execute<Record<string, any>>(
      `select username, display_name from system.users where is_active = 'Y' order by username`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []).map((row) => ({ username: row.USERNAME, displayName: row.DISPLAY_NAME }));
  } finally {
    if (connection) await connection.close();
  }
}

async function createUser(input: CreateUserInput): Promise<number> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const maxRes = await connection.execute<any[]>('select nvl(max(id),0)+1 as nextid from system.users');
    const nextId = maxRes.rows?.[0][0];

    const sql = `insert into system.users
                    (id, username, password_hash, display_name, role, is_active, created_at)
                 values
                    (:id, :username, :passwordHash, :displayName, :role, 'Y', TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'))`;

    const result = await connection.execute(
      sql,
      {
        id: nextId,
        username: input.username,
        passwordHash: hashPassword(input.password),
        displayName: input.displayName ?? null,
        role: input.role ?? 'VIEWER',
      },
      { autoCommit: true }
    );
    return result.rowsAffected ?? 0;
  } finally {
    if (connection) await connection.close();
  }
}

export interface UpdateUserInput {
  id: number | string;
  displayName?: string | null;
  role: UserRole;
  isActive: boolean;
  newPassword?: string;
}

// Users 페이지의 수정 팝업 하나로 표시이름/권한/활성상태/비밀번호를 한번에 저장합니다.
// newPassword가 비어있으면(변경하지 않으려면 비워두는 UX) password_hash는 건드리지 않습니다.
async function updateUser(input: UpdateUserInput): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    const setClauses = ['display_name = :displayName', 'role = :role', 'is_active = :isActive'];
    const binds: Record<string, any> = {
      id: input.id,
      displayName: input.displayName || null,
      role: input.role,
      isActive: input.isActive ? 'Y' : 'N',
    };
    if (input.newPassword) {
      setClauses.push('password_hash = :passwordHash');
      binds.passwordHash = hashPassword(input.newPassword);
    }

    await connection.execute(
      `update system.users set ${setClauses.join(', ')} where id = :id`,
      binds,
      { autoCommit: true }
    );
  } finally {
    if (connection) await connection.close();
  }
}

async function touchLastLogin(username: string): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    await connection.execute(
      `update system.users set last_login_at = TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS') where username = :username`,
      { username },
      { autoCommit: true }
    );
  } finally {
    if (connection) await connection.close();
  }
}

export {
  findByUsername,
  findBasicByUsername,
  listUsers,
  listBasic,
  createUser,
  updateUser,
  touchLastLogin,
};
