import oracledb from 'oracledb';
import { connectTarget, query } from './objectCompareModel';
import type { DbmsIdParam } from './dbmsModel';

// 계정·권한 비교 (Object Compare의 "계정·권한" 탭): Profile / User / Role과 그 권한을 대상 DB 딕셔너리에서 읽는다.
// 비밀번호(해시)는 읽지 않는다.

export interface SecurityLists {
  users: { name: string; oracleMaintained: boolean }[];
  roles: { name: string; oracleMaintained: boolean }[];
  profiles: string[];
}

export interface UserInfo {
  name: string;
  accountStatus: string;
  profile: string;
  defaultTablespace: string | null;
  temporaryTablespace: string | null;
  authenticationType: string | null;
}

export interface RoleInfo {
  name: string;
  authenticationType: string | null;
}

export interface ProfileLimit {
  profile: string;
  resource: string;
  resourceType: string;
  limit: string;
}

export interface QuotaInfo {
  user: string;
  tablespace: string;
  maxBytes: number; // -1 = UNLIMITED
}

export interface SysPriv {
  grantee: string;
  privilege: string;
  adminOption: string;
}

export interface RolePriv {
  grantee: string;
  role: string;
  adminOption: string;
  defaultRole: string | null;
}

export interface TabPriv {
  grantee: string;
  owner: string;
  objectName: string;
  privilege: string;
  grantable: string;
}

export interface ColPriv {
  grantee: string;
  owner: string;
  objectName: string;
  column: string;
  privilege: string;
  grantable: string;
}

export interface SecuritySnapshot {
  dbname: string;
  users: UserInfo[];
  roles: RoleInfo[];
  profiles: ProfileLimit[];
  quotas: QuotaInfo[];
  sysPrivs: SysPriv[];
  rolePrivs: RolePriv[]; // grantee가 고른 User/Role인 것
  tabPrivs: TabPriv[];
  colPrivs: ColPriv[]; // 컬럼 단위 권한 (예: 특정 컬럼에만 UPDATE)
  roleGrantees: RolePriv[]; // granted role이 고른 Role인 것 (그 Role을 받은 계정/Role 목록)
}

export interface SecuritySelection {
  users: string[];
  roles: string[];
  profiles: string[];
}

async function withTarget<T>(dbmsid: DbmsIdParam, work: (connection: oracledb.Connection, dbname: string) => Promise<T>): Promise<T> {
  let connection: oracledb.Connection | undefined;
  try {
    const target = await connectTarget(dbmsid);
    connection = target.connection;
    return await work(connection, target.dbname);
  } finally {
    if (connection) await connection.close();
  }
}

// 이름 목록을 IN (:p0, :p1, ...) 바인드로. 비어 있으면 아무것도 맞지 않는 조건.
function inList(names: string[], prefix: string, binds: Record<string, string>): string {
  if (names.length === 0) return 'NULL';
  return names
    .map((name, index) => {
      binds[`${prefix}${index}`] = name;
      return `:${prefix}${index}`;
    })
    .join(', ');
}

// 화면의 선택 목록 (오라클 기본 계정/Role 여부 포함 — 화면에서 숨길지 정함).
async function getLists(dbmsid: DbmsIdParam): Promise<SecurityLists> {
  return withTarget(dbmsid, async (connection) => {
    const users = await query(connection, `SELECT username, oracle_maintained FROM dba_users ORDER BY username`);
    const roles = await query(connection, `SELECT role, oracle_maintained FROM dba_roles ORDER BY role`);
    const profiles = await query(connection, `SELECT DISTINCT profile FROM dba_profiles ORDER BY profile`);
    return {
      users: users.map((row) => ({ name: row.USERNAME, oracleMaintained: row.ORACLE_MAINTAINED === 'Y' })),
      roles: roles.map((row) => ({ name: row.ROLE, oracleMaintained: row.ORACLE_MAINTAINED === 'Y' })),
      profiles: profiles.map((row) => row.PROFILE),
    };
  });
}

async function getSnapshot(dbmsid: DbmsIdParam, selection: SecuritySelection): Promise<SecuritySnapshot> {
  return withTarget(dbmsid, async (connection, dbname) => {
    const binds: Record<string, string> = {};
    const users = inList(selection.users, 'u', binds);
    const roles = inList(selection.roles, 'r', binds);
    const profiles = inList(selection.profiles, 'p', binds);
    const run = async (sql: string, names: string[]) => {
      // 그 쿼리에 쓰인 바인드만 넘긴다 (안 쓰는 바인드가 있으면 ORA-01036).
      const used = Object.fromEntries(Object.entries(binds).filter(([key]) => names.some((prefix) => key.startsWith(prefix))));
      return query(connection, sql, used);
    };

    const userRows = await run(
      `SELECT username, account_status, profile, default_tablespace, temporary_tablespace, authentication_type
         FROM dba_users WHERE username IN (${users})`,
      ['u']
    );
    const roleRows = await run(`SELECT role, authentication_type FROM dba_roles WHERE role IN (${roles})`, ['r']);
    const profileRows = await run(
      `SELECT profile, resource_name, resource_type, limit FROM dba_profiles WHERE profile IN (${profiles})`,
      ['p']
    );
    const quotaRows = await run(`SELECT username, tablespace_name, max_bytes FROM dba_ts_quotas WHERE username IN (${users})`, ['u']);
    const grantees = `${users}, ${roles}`;
    const sysRows = await run(`SELECT grantee, privilege, admin_option FROM dba_sys_privs WHERE grantee IN (${grantees})`, ['u', 'r']);
    const roleRows2 = await run(
      `SELECT grantee, granted_role, admin_option, default_role FROM dba_role_privs WHERE grantee IN (${grantees})`,
      ['u', 'r']
    );
    const tabRows = await run(
      `SELECT grantee, owner, table_name, privilege, grantable FROM dba_tab_privs WHERE grantee IN (${grantees})`,
      ['u', 'r']
    );
    const colRows = await run(
      `SELECT grantee, owner, table_name, column_name, privilege, grantable FROM dba_col_privs WHERE grantee IN (${grantees})`,
      ['u', 'r']
    );
    const granteeRows = await run(
      `SELECT grantee, granted_role, admin_option, default_role FROM dba_role_privs WHERE granted_role IN (${roles})`,
      ['r']
    );

    const toRolePriv = (row: Record<string, any>): RolePriv => ({
      grantee: row.GRANTEE,
      role: row.GRANTED_ROLE,
      adminOption: row.ADMIN_OPTION,
      defaultRole: row.DEFAULT_ROLE ?? null,
    });
    return {
      dbname,
      users: userRows.map((row) => ({
        name: row.USERNAME,
        accountStatus: row.ACCOUNT_STATUS,
        profile: row.PROFILE,
        defaultTablespace: row.DEFAULT_TABLESPACE ?? null,
        temporaryTablespace: row.TEMPORARY_TABLESPACE ?? null,
        authenticationType: row.AUTHENTICATION_TYPE ?? null,
      })),
      roles: roleRows.map((row) => ({ name: row.ROLE, authenticationType: row.AUTHENTICATION_TYPE ?? null })),
      profiles: profileRows.map((row) => ({ profile: row.PROFILE, resource: row.RESOURCE_NAME, resourceType: row.RESOURCE_TYPE, limit: row.LIMIT })),
      quotas: quotaRows.map((row) => ({ user: row.USERNAME, tablespace: row.TABLESPACE_NAME, maxBytes: Number(row.MAX_BYTES) })),
      sysPrivs: sysRows.map((row) => ({ grantee: row.GRANTEE, privilege: row.PRIVILEGE, adminOption: row.ADMIN_OPTION })),
      rolePrivs: roleRows2.map(toRolePriv),
      tabPrivs: tabRows.map((row) => ({
        grantee: row.GRANTEE,
        owner: row.OWNER,
        objectName: row.TABLE_NAME,
        privilege: row.PRIVILEGE,
        grantable: row.GRANTABLE,
      })),
      colPrivs: colRows.map((row) => ({
        grantee: row.GRANTEE,
        owner: row.OWNER,
        objectName: row.TABLE_NAME,
        column: row.COLUMN_NAME,
        privilege: row.PRIVILEGE,
        grantable: row.GRANTABLE,
      })),
      roleGrantees: granteeRows.map(toRolePriv),
    };
  });
}

export { getLists, getSnapshot };
