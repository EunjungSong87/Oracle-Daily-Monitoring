import oracledb from 'oracledb';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';
import type { SegmentPlacement } from '../services/dataPumpMigration';

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

export { readPlacements, readPlacementsOn, readPrecheck, withConnection };
