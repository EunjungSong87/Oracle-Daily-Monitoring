import oracledb from 'oracledb';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';
import type { SegmentPlacement } from '../services/dataPumpMigration';
import type { Finding } from '../services/migrationVerify';

// 이관(Import 생성/사전 점검/이관 검증)에서 원본·대상 DB를 읽는 쿼리.
// 부하 원칙: 범위 테이블의 OWNER+이름 조건으로만 조회한다. DBA_SEGMENTS는 쓰지 않는다 (테이블스페이스 위치는 딕셔너리의 TABLESPACE_NAME).

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const PAIR_CHUNK = 300; // (owner, table) IN 목록 한 번에 (바인드 600개)
export const MAX_PLACEMENT_ROWS = 50000; // 한 종류(인덱스 파티션 등)당 상한 — 넘으면 truncated

async function withConnection<T>(dbmsid: DbmsIdParam, work: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
  const { connection } = await dbmsModel.connectToTargetById(dbmsid);
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

function inList(values: string[], prefix: string, binds: Record<string, string>): string {
  return values
    .map((value, i) => {
      binds[`${prefix}${i}`] = value;
      return `:${prefix}${i}`;
    })
    .join(', ');
}

function pairList(pairs: { owner: string; table: string }[], binds: Record<string, string>): string {
  return pairs
    .map((pair, i) => {
      binds[`po${i}`] = pair.owner;
      binds[`pt${i}`] = pair.table;
      return `(:po${i}, :pt${i})`;
    })
    .join(', ');
}

// 테이블·파티션·서브파티션·인덱스·인덱스 파티션·LOB·LOB 파티션과 파티션 테이블/인덱스/LOB의 기본 테이블스페이스
async function readPlacementsOn(connection: oracledb.Connection, tables: { owner: string; table: string }[]): Promise<{ rows: SegmentPlacement[]; truncated: boolean }> {
  const rows: SegmentPlacement[] = [];
  let truncated = false;
  for (const chunk of chunks(tables, PAIR_CHUNK)) {
    const run = async (sql: string, map: (row: Record<string, any>) => SegmentPlacement) => {
      const binds: Record<string, string> = {};
      const list = pairList(chunk, binds);
      const result = await connection.execute<Record<string, any>>(sql.replace('%PAIRS%', list), binds, { ...OBJ, maxRows: MAX_PLACEMENT_ROWS + 1 });
      const got = result.rows ?? [];
      if (got.length > MAX_PLACEMENT_ROWS) truncated = true;
      rows.push(...got.slice(0, MAX_PLACEMENT_ROWS).map(map));
    };
    const base = (kind: SegmentPlacement['kind'], row: Record<string, any>, extra: Partial<SegmentPlacement>): SegmentPlacement => ({
      kind,
      owner: row.OWNER ?? row.TABLE_OWNER,
      tableOwner: row.TABLE_OWNER ?? row.OWNER,
      table: row.TABLE_NAME,
      name: row.TABLE_NAME,
      partition: null,
      subpartition: null,
      tablespace: row.TABLESPACE_NAME ?? null,
      ...extra,
    });
    await run(`SELECT owner, table_name, tablespace_name FROM dba_tables WHERE (owner, table_name) IN (%PAIRS%)`, (row) => base('TABLE', row, {}));
    await run(`SELECT owner, table_name, def_tablespace_name AS tablespace_name FROM dba_part_tables WHERE (owner, table_name) IN (%PAIRS%)`, (row) => base('TABLE_DEFAULT', row, {}));
    await run(
      `SELECT table_owner, table_name, partition_name, tablespace_name FROM dba_tab_partitions WHERE (table_owner, table_name) IN (%PAIRS%)`,
      (row) => base('TABLE_PARTITION', row, { partition: row.PARTITION_NAME })
    );
    await run(
      `SELECT table_owner, table_name, partition_name, subpartition_name, tablespace_name FROM dba_tab_subpartitions WHERE (table_owner, table_name) IN (%PAIRS%)`,
      (row) => base('TABLE_SUBPARTITION', row, { partition: row.PARTITION_NAME, subpartition: row.SUBPARTITION_NAME })
    );
    await run(
      `SELECT owner, index_name, table_owner, table_name, tablespace_name FROM dba_indexes WHERE (table_owner, table_name) IN (%PAIRS%) AND index_type <> 'LOB'`,
      (row) => base('INDEX', row, { name: row.INDEX_NAME })
    );
    await run(
      `SELECT i.owner, i.index_name, i.table_owner, i.table_name, p.def_tablespace_name AS tablespace_name
         FROM dba_part_indexes p JOIN dba_indexes i ON i.owner = p.owner AND i.index_name = p.index_name
        WHERE (i.table_owner, i.table_name) IN (%PAIRS%)`,
      (row) => base('INDEX_DEFAULT', row, { name: row.INDEX_NAME })
    );
    await run(
      `SELECT i.owner, i.index_name, i.table_owner, i.table_name, p.partition_name, p.tablespace_name
         FROM dba_ind_partitions p JOIN dba_indexes i ON i.owner = p.index_owner AND i.index_name = p.index_name
        WHERE (i.table_owner, i.table_name) IN (%PAIRS%)`,
      (row) => base('INDEX_PARTITION', row, { name: row.INDEX_NAME, partition: row.PARTITION_NAME })
    );
    await run(
      `SELECT owner, table_name, column_name, segment_name, tablespace_name FROM dba_lobs WHERE (owner, table_name) IN (%PAIRS%)`,
      (row) => base('LOB', row, { name: `${row.COLUMN_NAME} (${row.SEGMENT_NAME})` })
    );
    await run(
      `SELECT table_owner, table_name, column_name, lob_name, def_tablespace_name AS tablespace_name FROM dba_part_lobs WHERE (table_owner, table_name) IN (%PAIRS%)`,
      (row) => base('LOB_DEFAULT', row, { name: `${row.COLUMN_NAME} (${row.LOB_NAME})` })
    );
    await run(
      `SELECT table_owner, table_name, column_name, lob_name, partition_name, tablespace_name FROM dba_lob_partitions WHERE (table_owner, table_name) IN (%PAIRS%)`,
      (row) => base('LOB_PARTITION', row, { name: `${row.COLUMN_NAME} (${row.LOB_NAME})`, partition: row.PARTITION_NAME })
    );
  }
  return { rows, truncated };
}

async function readPlacements(dbmsid: DbmsIdParam, tables: { owner: string; table: string }[]): Promise<{ rows: SegmentPlacement[]; truncated: boolean }> {
  if (tables.length === 0) return { rows: [], truncated: false };
  return withConnection(dbmsid, (connection) => readPlacementsOn(connection, tables));
}

export interface PrecheckRaw {
  users: string[];
  tablespaces: string[];
  freeBytes: Record<string, number>;
  quotas: { user: string; tablespace: string; maxBytes: number; bytes: number }[];
  unlimitedUsers: string[];
}

// Import 전 사전 점검: 대상 스키마/테이블스페이스 존재, 여유 공간(자동 확장 최대까지), QUOTA, UNLIMITED TABLESPACE — 모두 이름 조건
async function readPrecheck(dbmsid: DbmsIdParam, owners: string[], tablespaces: string[]): Promise<PrecheckRaw> {
  return withConnection(dbmsid, async (connection) => {
    const read = async (sql: string, binds: Record<string, string>) => (await connection.execute<Record<string, any>>(sql, binds, OBJ)).rows ?? [];
    const raw: PrecheckRaw = { users: [], tablespaces: [], freeBytes: {}, quotas: [], unlimitedUsers: [] };
    for (const chunk of chunks(owners, 500)) {
      const binds: Record<string, string> = {};
      const list = inList(chunk, 'u', binds);
      raw.users.push(...(await read(`SELECT username FROM dba_users WHERE username IN (${list})`, binds)).map((row) => row.USERNAME));
      raw.unlimitedUsers.push(...(await read(`SELECT grantee FROM dba_sys_privs WHERE privilege = 'UNLIMITED TABLESPACE' AND grantee IN (${list})`, binds)).map((row) => row.GRANTEE));
    }
    for (const chunk of chunks(tablespaces, 500)) {
      const binds: Record<string, string> = {};
      const list = inList(chunk, 't', binds);
      raw.tablespaces.push(...(await read(`SELECT tablespace_name FROM dba_tablespaces WHERE tablespace_name IN (${list})`, binds)).map((row) => row.TABLESPACE_NAME));
      for (const row of await read(
        `SELECT m.tablespace_name, (m.tablespace_size - m.used_space) * t.block_size AS free_bytes
           FROM dba_tablespace_usage_metrics m JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name
          WHERE m.tablespace_name IN (${list})`,
        binds
      )) {
        raw.freeBytes[row.TABLESPACE_NAME] = Number(row.FREE_BYTES);
      }
    }
    if (owners.length > 0 && tablespaces.length > 0) {
      for (const ownerChunk of chunks(owners, 400)) {
        for (const tsChunk of chunks(tablespaces, 400)) {
          const binds: Record<string, string> = {};
          const users = inList(ownerChunk, 'u', binds);
          const spaces = inList(tsChunk, 't', binds);
          raw.quotas.push(
            ...(await read(`SELECT username, tablespace_name, max_bytes, bytes FROM dba_ts_quotas WHERE username IN (${users}) AND tablespace_name IN (${spaces})`, binds)).map((row) => ({
              user: row.USERNAME,
              tablespace: row.TABLESPACE_NAME,
              maxBytes: Number(row.MAX_BYTES),
              bytes: Number(row.BYTES),
            }))
          );
        }
      }
    }
    return raw;
  });
}

// ── 이관 검증: 정리 점검 (범위 테이블의 OWNER+이름 조건, 의존 오브젝트는 지정한 소유자만) ──

export interface PrivilegeRow {
  owner: string;
  table: string;
  grantee: string;
  privilege: string;
}

const MAX_FINDING_ROWS = 5000;

async function readFindings(dbmsid: DbmsIdParam, tables: { owner: string; table: string }[], owners: string[]): Promise<{ findings: Finding[]; privileges: PrivilegeRow[]; truncated: boolean }> {
  const findings: Finding[] = [];
  const privileges: PrivilegeRow[] = [];
  let truncated = false;
  if (tables.length === 0) return { findings, privileges, truncated };
  await withConnection(dbmsid, async (connection) => {
    for (const chunk of chunks(tables, PAIR_CHUNK)) {
      const run = async (sql: string, extra: Record<string, string> = {}) => {
        const binds: Record<string, string> = { ...extra };
        const list = pairList(chunk, binds);
        const result = await connection.execute<Record<string, any>>(sql.replace('%PAIRS%', list), binds, { ...OBJ, maxRows: MAX_FINDING_ROWS + 1 });
        const rows = result.rows ?? [];
        if (rows.length > MAX_FINDING_ROWS) truncated = true;
        return rows.slice(0, MAX_FINDING_ROWS);
      };
      const ownerBinds: Record<string, string> = {};
      const ownerList = inList(owners, 'ow', ownerBinds);
      // 범위 테이블을 참조하는 INVALID 오브젝트 (뷰, PL/SQL, 시노님 …) — 그 소유자만
      if (owners.length > 0) {
        for (const row of await run(
          `SELECT DISTINCT d.owner, d.name, d.type, d.referenced_owner, d.referenced_name
             FROM dba_dependencies d
             JOIN dba_objects o ON o.owner = d.owner AND o.object_name = d.name AND o.object_type = d.type
            WHERE (d.referenced_owner, d.referenced_name) IN (%PAIRS%) AND d.referenced_type = 'TABLE'
              AND d.owner IN (${ownerList}) AND o.status <> 'VALID'`,
          ownerBinds
        )) {
          findings.push({ category: 'INVALID', owner: row.OWNER, name: row.NAME, type: row.TYPE, table: `${row.REFERENCED_OWNER}.${row.REFERENCED_NAME}`, partition: null, detail: `${row.TYPE} INVALID` });
        }
      }
      for (const row of await run(`SELECT owner, index_name, table_owner, table_name FROM dba_indexes WHERE (table_owner, table_name) IN (%PAIRS%) AND status = 'UNUSABLE'`)) {
        findings.push({ category: 'UNUSABLE', owner: row.OWNER, name: row.INDEX_NAME, type: 'INDEX', table: `${row.TABLE_OWNER}.${row.TABLE_NAME}`, partition: null, detail: '인덱스 UNUSABLE' });
      }
      for (const row of await run(
        `SELECT p.index_owner, p.index_name, p.partition_name, i.table_owner, i.table_name
           FROM dba_ind_partitions p JOIN dba_indexes i ON i.owner = p.index_owner AND i.index_name = p.index_name
          WHERE (i.table_owner, i.table_name) IN (%PAIRS%) AND p.status = 'UNUSABLE'`
      )) {
        findings.push({ category: 'UNUSABLE', owner: row.INDEX_OWNER, name: row.INDEX_NAME, type: 'INDEX PARTITION', table: `${row.TABLE_OWNER}.${row.TABLE_NAME}`, partition: row.PARTITION_NAME, detail: '인덱스 파티션 UNUSABLE' });
      }
      for (const row of await run(
        `SELECT owner, constraint_name, constraint_type, table_name, status, validated FROM dba_constraints
          WHERE (owner, table_name) IN (%PAIRS%) AND (status = 'DISABLED' OR validated = 'NOT VALIDATED')`
      )) {
        findings.push({
          category: 'CONSTRAINT',
          owner: row.OWNER,
          name: row.CONSTRAINT_NAME,
          type: row.CONSTRAINT_TYPE,
          table: `${row.OWNER}.${row.TABLE_NAME}`,
          partition: null,
          detail: `${row.STATUS === 'DISABLED' ? 'DISABLED' : 'ENABLED'} / ${row.VALIDATED}`,
        });
      }
      for (const row of await run(`SELECT owner, trigger_name, table_owner, table_name FROM dba_triggers WHERE (table_owner, table_name) IN (%PAIRS%) AND status = 'DISABLED'`)) {
        findings.push({ category: 'TRIGGER', owner: row.OWNER, name: row.TRIGGER_NAME, type: 'TRIGGER', table: `${row.TABLE_OWNER}.${row.TABLE_NAME}`, partition: null, detail: '트리거 DISABLED' });
      }
      for (const row of await run(`SELECT owner, table_name FROM dba_tables WHERE (owner, table_name) IN (%PAIRS%) AND last_analyzed IS NULL`)) {
        findings.push({ category: 'NO_STATS', owner: row.OWNER, name: row.TABLE_NAME, type: 'TABLE', table: `${row.OWNER}.${row.TABLE_NAME}`, partition: null, detail: '통계 없음' });
      }
      for (const row of await run(`SELECT table_owner, table_name, partition_name FROM dba_tab_partitions WHERE (table_owner, table_name) IN (%PAIRS%) AND last_analyzed IS NULL`)) {
        findings.push({ category: 'NO_STATS', owner: row.TABLE_OWNER, name: row.TABLE_NAME, type: 'TABLE PARTITION', table: `${row.TABLE_OWNER}.${row.TABLE_NAME}`, partition: row.PARTITION_NAME, detail: '파티션 통계 없음' });
      }
      for (const row of await run(`SELECT owner, table_name, grantee, privilege FROM dba_tab_privs WHERE (owner, table_name) IN (%PAIRS%)`)) {
        privileges.push({ owner: row.OWNER, table: row.TABLE_NAME, grantee: row.GRANTEE, privilege: row.PRIVILEGE });
      }
    }
  });
  return { findings, privileges, truncated };
}

// 고른 테이블/파티션만 COUNT(*). 이름은 정확한 이름을 큰따옴표로, WHERE는 서비스가 검증한 Export QUERY 조건만.
async function countRows(
  dbmsid: DbmsIdParam,
  items: { key: string; owner: string; table: string; partition: string | null; where: string | null }[],
  callTimeoutMs: number
): Promise<Record<string, { rows: number | null; error?: string }>> {
  const result: Record<string, { rows: number | null; error?: string }> = {};
  const { connection } = await dbmsModel.connectToTargetById(dbmsid, { callTimeoutMs });
  try {
    for (const item of items) {
      const quote = (name: string) => `"${name}"`;
      const sql = `SELECT COUNT(*) AS n FROM ${quote(item.owner)}.${quote(item.table)}${item.partition ? ` PARTITION (${quote(item.partition)})` : ''}${item.where ? ` ${item.where}` : ''}`;
      try {
        const rows = (await connection.execute<Record<string, any>>(sql, {}, OBJ)).rows ?? [];
        result[item.key] = { rows: Number(rows[0]?.N ?? 0) };
      } catch (error) {
        result[item.key] = { rows: null, error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
        if (error instanceof Error && /DPI-1080|NJS-500|ORA-03156/.test(error.message)) break; // 시간 초과로 커넥션이 끊기면 나머지는 하지 않는다
      }
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
  return result;
}

// INVALID 오브젝트 재컴파일 (서비스가 범위 안의 INVALID 오브젝트인지 확인한 것만, SQL은 정해진 형식)
async function compileObjects(dbmsid: DbmsIdParam, objects: { owner: string; name: string; type: string; sql: string }[]): Promise<{ owner: string; name: string; type: string; sql: string; ok: boolean; status: string | null; error: string | null }[]> {
  return withConnection(dbmsid, async (connection) => {
    const results = [];
    for (const object of objects) {
      let error: string | null = null;
      try {
        await connection.execute(object.sql);
      } catch (err) {
        error = err instanceof Error ? err.message.split('\n')[0] : String(err);
      }
      const rows = (
        await connection.execute<Record<string, any>>(`SELECT status FROM dba_objects WHERE owner = :owner AND object_name = :name AND object_type = :type`, { owner: object.owner, name: object.name, type: object.type }, OBJ)
      ).rows;
      const status = rows?.[0]?.STATUS ?? null;
      results.push({ ...object, ok: !error && status === 'VALID', status, error });
    }
    return results;
  });
}

export { readPlacements, readPlacementsOn, readPrecheck, readFindings, countRows, compileObjects, withConnection };
