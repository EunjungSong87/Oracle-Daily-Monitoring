import oracledb from 'oracledb';
import { parseJson, withPool } from './dataPumpHistoryModel';

// Data Pump 이관 흐름의 메타데이터 DB 저장소.
//  - scripts/add_datapump_bundle.sql: Export 분할 묶음(datapump_export_bundle / _job), 파티션 이력(datapump_partition_history)
//  - scripts/add_datapump_migration.sql: 매핑표(datapump_remap_set), 생성한 Import(datapump_migration_plan / _job)
// 테이블이 없으면 ORA-00942를 그대로 던진다 — 서비스가 isMissingTable로 "설치 필요"를 안내한다.

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const clob = (value: unknown) => ({ val: value === null || value === undefined ? null : JSON.stringify(value), type: oracledb.CLOB });
const TS = 'YYYY-MM-DD HH24:MI:SS';

export function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && /ORA-00942|ORA-00904/.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

// ── Export 묶음 ──

export interface BundleJobRecord {
  no: number;
  jobName: string;
  mode: string;
  request: unknown;
  expected: string[];
  tableSizes: { owner: string; name: string; bytes: number }[];
  excludedTables: string[];
}

export interface PartitionRecord {
  jobNo: number;
  owner: string;
  table: string;
  partition: string;
  position: number;
  highValue: string;
  low: string | null;
  high: string | null;
  known: boolean;
  bytes: number;
  numRows: number | null;
  dumpfile: string;
  keyColumn: string;
  keyType: string;
  interval: string | null;
}

export interface BundleRecord {
  bundleId: string;
  dbmsId: number;
  dbname: string;
  missing: string[];
  filteredOut: string[];
  createdBy: string | null;
  jobs: BundleJobRecord[];
  partitions: PartitionRecord[];
}

// 처음 한 번만 남긴다 (같은 계획의 작업을 하나씩 시작하거나 parfile 저장 후 실행해도 한 번)
async function saveBundle(bundle: BundleRecord): Promise<void> {
  await withPool(async (connection) => {
    const exists = await connection.execute<Record<string, any>>(`SELECT 1 AS x FROM system.datapump_export_bundle WHERE bundle_id = :id`, { id: bundle.bundleId }, OBJ);
    if ((exists.rows ?? []).length > 0) return;
    await connection.execute(
      `INSERT INTO system.datapump_export_bundle (bundle_id, dbms_id, dbname, job_count, missing, filtered_out, created_by, created_at)
       VALUES (:id, :dbmsId, :dbname, :jobCount, :missing, :filteredOut, :createdBy, SYSDATE)`,
      {
        id: bundle.bundleId,
        dbmsId: bundle.dbmsId,
        dbname: bundle.dbname,
        jobCount: bundle.jobs.length,
        missing: clob(bundle.missing),
        filteredOut: clob(bundle.filteredOut),
        createdBy: bundle.createdBy,
      }
    );
    for (const job of bundle.jobs) {
      await connection.execute(
        `INSERT INTO system.datapump_export_bundle_job (bundle_id, job_no, job_name, job_mode, request_json, expected_items, table_sizes, excluded_tables)
         VALUES (:id, :jobNo, :jobName, :jobMode, :request, :expected, :sizes, :excluded)`,
        {
          id: bundle.bundleId,
          jobNo: job.no,
          jobName: job.jobName,
          jobMode: job.mode,
          request: clob(job.request),
          expected: clob(job.expected),
          sizes: clob(job.tableSizes),
          excluded: clob(job.excludedTables),
        }
      );
    }
    if (bundle.partitions.length > 0) {
      await connection.executeMany(
        `INSERT INTO system.datapump_partition_history
           (bundle_id, job_no, owner, table_name, partition_name, position, high_value, range_low, range_high, known,
            est_bytes, num_rows, dumpfile, key_column, key_type, interval_expr)
         VALUES (:bundleId, :jobNo, :owner, :tableName, :partitionName, :position, SUBSTR(:highValue, 1, 4000), :low, :high, :known,
                 :bytes, :numRows, :dumpfile, :keyColumn, :keyType, SUBSTR(:intervalExpr, 1, 1000))`,
        bundle.partitions.map((p) => ({
          bundleId: bundle.bundleId,
          jobNo: p.jobNo,
          owner: p.owner,
          tableName: p.table,
          partitionName: p.partition,
          position: p.position,
          highValue: p.highValue,
          low: p.low,
          high: p.high,
          known: p.known ? 'Y' : 'N',
          bytes: p.bytes,
          numRows: p.numRows,
          dumpfile: p.dumpfile,
          keyColumn: p.keyColumn,
          keyType: p.keyType,
          intervalExpr: p.interval,
        })),
        {
          bindDefs: {
            bundleId: { type: oracledb.STRING, maxSize: 64 },
            jobNo: { type: oracledb.NUMBER },
            owner: { type: oracledb.STRING, maxSize: 128 },
            tableName: { type: oracledb.STRING, maxSize: 128 },
            partitionName: { type: oracledb.STRING, maxSize: 128 },
            position: { type: oracledb.NUMBER },
            highValue: { type: oracledb.STRING, maxSize: 4000 },
            low: { type: oracledb.STRING, maxSize: 19 },
            high: { type: oracledb.STRING, maxSize: 19 },
            known: { type: oracledb.STRING, maxSize: 1 },
            bytes: { type: oracledb.NUMBER },
            numRows: { type: oracledb.NUMBER },
            dumpfile: { type: oracledb.STRING, maxSize: 400 },
            keyColumn: { type: oracledb.STRING, maxSize: 128 },
            keyType: { type: oracledb.STRING, maxSize: 106 },
            intervalExpr: { type: oracledb.STRING, maxSize: 1000 },
          },
        }
      );
    }
    await connection.commit();
  });
}

const BUNDLE_JOB_FETCH = {
  REQUEST_JSON: { type: oracledb.STRING },
  EXPECTED_ITEMS: { type: oracledb.STRING },
  TABLE_SIZES: { type: oracledb.STRING },
  EXCLUDED_TABLES: { type: oracledb.STRING },
};

function mapBundleJob(row: Record<string, any>): BundleJobRecord {
  return {
    no: row.JOB_NO,
    jobName: row.JOB_NAME,
    mode: row.JOB_MODE,
    request: parseJson(row.REQUEST_JSON),
    expected: parseJson<string[]>(row.EXPECTED_ITEMS) ?? [],
    tableSizes: parseJson(row.TABLE_SIZES) ?? [],
    excludedTables: parseJson<string[]>(row.EXCLUDED_TABLES) ?? [],
  };
}

async function getBundleJobs(bundleId: string): Promise<BundleJobRecord[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT job_no, job_name, job_mode, request_json, expected_items, table_sizes, excluded_tables
         FROM system.datapump_export_bundle_job WHERE bundle_id = :id ORDER BY job_no`,
      { id: bundleId },
      { ...OBJ, fetchInfo: BUNDLE_JOB_FETCH }
    );
    return (result.rows ?? []).map(mapBundleJob);
  });
}

// parfile만 저장하고 직접 실행한 Export(외부 작업으로 발견)도 같은 묶음에 잇기 위해 작업 이름으로 찾는다
async function findBundleJob(dbmsId: number | string, jobName: string): Promise<{ bundleId: string; job: BundleJobRecord } | null> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT j.bundle_id, j.job_no, j.job_name, j.job_mode, j.request_json, j.expected_items, j.table_sizes, j.excluded_tables
           FROM system.datapump_export_bundle_job j
           JOIN system.datapump_export_bundle b ON b.bundle_id = j.bundle_id
          WHERE j.job_name = :jobName AND b.dbms_id = :dbmsId
          ORDER BY b.created_at DESC
       ) WHERE ROWNUM = 1`,
      { jobName, dbmsId: Number(dbmsId) },
      { ...OBJ, fetchInfo: BUNDLE_JOB_FETCH }
    );
    const row = result.rows?.[0];
    return row ? { bundleId: row.BUNDLE_ID, job: mapBundleJob(row) } : null;
  });
}

async function getPartitionRows(bundleId: string, owner: string | null = null, table: string | null = null): Promise<PartitionRecord[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT job_no, owner, table_name, partition_name, position, high_value, range_low, range_high, known, est_bytes, num_rows,
              dumpfile, key_column, key_type, interval_expr
         FROM system.datapump_partition_history
        WHERE bundle_id = :id AND (:owner IS NULL OR owner = :owner) AND (:tableName IS NULL OR table_name = :tableName)
        ORDER BY owner, table_name, position`,
      { id: bundleId, owner, tableName: table },
      OBJ
    );
    return (result.rows ?? []).map((row) => ({
      jobNo: row.JOB_NO,
      owner: row.OWNER,
      table: row.TABLE_NAME,
      partition: row.PARTITION_NAME,
      position: row.POSITION,
      highValue: row.HIGH_VALUE ?? '',
      low: row.RANGE_LOW ?? null,
      high: row.RANGE_HIGH ?? null,
      known: row.KNOWN === 'Y',
      bytes: Number(row.EST_BYTES ?? 0),
      numRows: row.NUM_ROWS ?? null,
      dumpfile: row.DUMPFILE,
      keyColumn: row.KEY_COLUMN ?? '',
      keyType: row.KEY_TYPE ?? '',
      interval: row.INTERVAL_EXPR ?? null,
    }));
  });
}

// 파티션 Import 탭의 "이력에서": 파티션을 내보낸 묶음과 테이블
async function listPartitionExports(dbmsId: number | string): Promise<{ bundleId: string; createdAt: string; createdBy: string | null; owner: string; table: string; partitions: number }[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT b.bundle_id, TO_CHAR(b.created_at, '${TS}') AS created_at, b.created_by, p.owner, p.table_name, COUNT(*) AS n
           FROM system.datapump_export_bundle b
           JOIN system.datapump_partition_history p ON p.bundle_id = b.bundle_id
          WHERE b.dbms_id = :dbmsId
          GROUP BY b.bundle_id, b.created_at, b.created_by, p.owner, p.table_name
          ORDER BY b.created_at DESC, p.owner, p.table_name
       ) WHERE ROWNUM <= 200`,
      { dbmsId: Number(dbmsId) },
      OBJ
    );
    return (result.rows ?? []).map((row) => ({ bundleId: row.BUNDLE_ID, createdAt: row.CREATED_AT, createdBy: row.CREATED_BY ?? null, owner: row.OWNER, table: row.TABLE_NAME, partitions: Number(row.N) }));
  });
}

// ── Export 이력 (덤프 세트) ──

export interface ExportHistoryRow {
  id: number;
  dbmsId: number;
  jobName: string;
  jobMode: string;
  status: string;
  directory: string;
  dumpfile: string | null;
  logfile: string;
  startedAt: string | null;
  source: string;
  bundleId: string | null;
  bundleJobNo: number | null;
  request: Record<string, any> | null;
  dumpFiles: { name: string; bytes: number | null }[] | null;
  expected: { items: string[] | null } | null;
  logItems: unknown[] | null;
  errorSummary: string | null;
  targetDesc: string | null;
}

const EXPORT_FETCH = {
  REQUEST_JSON: { type: oracledb.STRING },
  DUMP_FILES: { type: oracledb.STRING },
  EXPECTED_ITEMS: { type: oracledb.STRING },
  LOG_ITEMS: { type: oracledb.STRING },
};

// bundleKey: 묶음 id, 또는 묶음 없는 작업은 'H<이력 id>'
async function getExportRows(dbmsId: number | string, bundleKey: string): Promise<ExportHistoryRow[]> {
  const single = /^H(\d+)$/.exec(bundleKey);
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT id, dbms_id, job_name, job_mode, status, directory_name, dumpfile, logfile, TO_CHAR(started_at, '${TS}') AS started_at,
              NVL(source, 'APP') AS source, bundle_id, bundle_job_no, request_json, dump_files, expected_items, log_items, error_summary, target_desc
         FROM system.datapump_job_history
        WHERE dbms_id = :dbmsId AND operation = 'EXPORT'
          AND ${single ? 'id = :key' : 'bundle_id = :key'}
        ORDER BY id`,
      { dbmsId: Number(dbmsId), key: single ? Number(single[1]) : bundleKey },
      { ...OBJ, fetchInfo: EXPORT_FETCH }
    );
    return (result.rows ?? []).map((row) => ({
      id: row.ID,
      dbmsId: row.DBMS_ID,
      jobName: row.JOB_NAME,
      jobMode: row.JOB_MODE,
      status: row.STATUS,
      directory: row.DIRECTORY_NAME,
      dumpfile: row.DUMPFILE ?? null,
      logfile: row.LOGFILE,
      startedAt: row.STARTED_AT,
      source: row.SOURCE,
      bundleId: row.BUNDLE_ID ?? null,
      bundleJobNo: row.BUNDLE_JOB_NO ?? null,
      request: parseJson(row.REQUEST_JSON),
      dumpFiles: parseJson(row.DUMP_FILES),
      expected: parseJson(row.EXPECTED_ITEMS),
      logItems: parseJson(row.LOG_ITEMS),
      errorSummary: row.ERROR_SUMMARY ?? null,
      targetDesc: row.TARGET_DESC ?? null,
    }));
  });
}

// 이관 화면의 Export 목록: 묶음별 (묶음 없는 작업은 한 줄씩)
async function listExportBundles(dbmsId: number | string): Promise<{ bundleKey: string; startedAt: string | null; jobs: number; statuses: string; jobNames: string; source: string; targetDesc: string | null }[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT g.*, TO_CHAR(g.first_at, '${TS}') AS started_at FROM (
           SELECT NVL(bundle_id, 'H' || id) AS bundle_key, MIN(started_at) AS first_at, COUNT(*) AS jobs,
                  LISTAGG(status, ',' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY status) AS statuses,
                  LISTAGG(job_name, ',' ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY job_name) AS job_names,
                  MAX(NVL(source, 'APP')) AS source, MAX(target_desc) KEEP (DENSE_RANK FIRST ORDER BY id) AS target_desc
             FROM (SELECT * FROM (SELECT * FROM system.datapump_job_history WHERE dbms_id = :dbmsId AND operation = 'EXPORT' ORDER BY id DESC) WHERE ROWNUM <= 500)
            GROUP BY NVL(bundle_id, 'H' || id)
         ) g
         ORDER BY g.first_at DESC
       ) WHERE ROWNUM <= 100`,
      { dbmsId: Number(dbmsId) },
      OBJ
    );
    return (result.rows ?? []).map((row) => ({
      bundleKey: row.BUNDLE_KEY,
      startedAt: row.STARTED_AT,
      jobs: Number(row.JOBS),
      statuses: [...new Set(String(row.STATUSES ?? '').split(','))].join(','),
      jobNames: String(row.JOB_NAMES ?? '').slice(0, 1000),
      source: row.SOURCE,
      targetDesc: row.TARGET_DESC ?? null,
    }));
  });
}

// ── 매핑표 ──

export interface RemapSetRow {
  id: number;
  name: string;
  schemas: unknown[];
  tablespaces: unknown[];
  updatedBy: string | null;
  updatedAt: string | null;
}

async function listRemapSets(): Promise<RemapSetRow[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT id, name, schemas_json, tablespaces_json, updated_by, TO_CHAR(updated_at, '${TS}') AS updated_at FROM system.datapump_remap_set ORDER BY name`,
      {},
      { ...OBJ, fetchInfo: { SCHEMAS_JSON: { type: oracledb.STRING }, TABLESPACES_JSON: { type: oracledb.STRING } } }
    );
    return (result.rows ?? []).map((row) => ({
      id: row.ID,
      name: row.NAME,
      schemas: parseJson<unknown[]>(row.SCHEMAS_JSON) ?? [],
      tablespaces: parseJson<unknown[]>(row.TABLESPACES_JSON) ?? [],
      updatedBy: row.UPDATED_BY ?? null,
      updatedAt: row.UPDATED_AT ?? null,
    }));
  });
}

async function saveRemapSet(name: string, schemas: unknown[], tablespaces: unknown[], updatedBy: string | null): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `MERGE INTO system.datapump_remap_set t
       USING (SELECT :name AS name FROM dual) s ON (t.name = s.name)
       WHEN MATCHED THEN UPDATE SET schemas_json = :schemas, tablespaces_json = :tablespaces, updated_by = :updatedBy, updated_at = SYSDATE
       WHEN NOT MATCHED THEN INSERT (name, schemas_json, tablespaces_json, updated_by, updated_at) VALUES (:name, :schemas, :tablespaces, :updatedBy, SYSDATE)`,
      { name, schemas: clob(schemas), tablespaces: clob(tablespaces), updatedBy },
      { autoCommit: true }
    );
  });
}

async function deleteRemapSet(id: number): Promise<void> {
  await withPool((connection) => connection.execute(`DELETE FROM system.datapump_remap_set WHERE id = :id`, { id }, { autoCommit: true }));
}

// ── 생성한 Import ──

export interface MigrationPlanRecord {
  planId: string;
  sourceDbmsId: number;
  bundleKey: string;
  targetDbmsId: number;
  totalSets: number;
  omitted: string[];
  filterExcluded: string[];
  mapping: unknown;
  options: unknown;
  createdBy: string | null;
  createdAt?: string | null;
}

export interface MigrationJobRecord {
  jobName: string;
  planId: string;
  no: number;
  exportHistoryId: number;
  exportJobName: string;
  targetDbmsId: number;
  request: Record<string, any>;
  parfile: string;
  expected: {
    baseline: Record<string, number>;
    remap: { from: string; to: string }[];
    mode: 'SCHEMA' | 'TABLE';
    schemas: string[];
    tables: string[];
    targetKeys: string[];
    waitFor?: string[];
  };
  dumpFiles: { name: string; bytes: number | null }[];
}

async function saveMigration(plan: MigrationPlanRecord, jobs: MigrationJobRecord[]): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `INSERT INTO system.datapump_migration_plan
         (plan_id, source_dbms_id, bundle_key, target_dbms_id, total_sets, omitted, filter_excluded, mapping_json, options_json, created_by, created_at)
       VALUES (:planId, :sourceDbmsId, :bundleKey, :targetDbmsId, :totalSets, :omitted, :filterExcluded, :mapping, :optionsJson, :createdBy, SYSDATE)`,
      {
        planId: plan.planId,
        sourceDbmsId: plan.sourceDbmsId,
        bundleKey: plan.bundleKey,
        targetDbmsId: plan.targetDbmsId,
        totalSets: plan.totalSets,
        omitted: clob(plan.omitted),
        filterExcluded: clob(plan.filterExcluded),
        mapping: clob(plan.mapping),
        optionsJson: clob(plan.options),
        createdBy: plan.createdBy,
      }
    );
    for (const job of jobs) {
      await connection.execute(
        `INSERT INTO system.datapump_migration_job
           (job_name, plan_id, job_no, export_history_id, export_job_name, target_dbms_id, request_json, parfile_text, expected_json, dump_files)
         VALUES (:jobName, :planId, :jobNo, :exportHistoryId, :exportJobName, :targetDbmsId, :request, :parfile, :expected, :dumpFiles)`,
        {
          jobName: job.jobName,
          planId: job.planId,
          jobNo: job.no,
          exportHistoryId: job.exportHistoryId,
          exportJobName: job.exportJobName,
          targetDbmsId: job.targetDbmsId,
          request: clob(job.request),
          parfile: { val: job.parfile, type: oracledb.CLOB },
          expected: clob(job.expected),
          dumpFiles: clob(job.dumpFiles),
        }
      );
    }
    await connection.commit();
  });
}

const JOB_FETCH = { REQUEST_JSON: { type: oracledb.STRING }, PARFILE_TEXT: { type: oracledb.STRING }, EXPECTED_JSON: { type: oracledb.STRING }, DUMP_FILES: { type: oracledb.STRING } };

function mapJob(row: Record<string, any>): MigrationJobRecord {
  return {
    jobName: row.JOB_NAME,
    planId: row.PLAN_ID,
    no: row.JOB_NO,
    exportHistoryId: row.EXPORT_HISTORY_ID,
    exportJobName: row.EXPORT_JOB_NAME,
    targetDbmsId: row.TARGET_DBMS_ID,
    request: parseJson(row.REQUEST_JSON) ?? {},
    parfile: row.PARFILE_TEXT ?? '',
    expected: parseJson(row.EXPECTED_JSON) ?? { baseline: {}, remap: [], mode: 'TABLE', schemas: [], tables: [], targetKeys: [] },
    dumpFiles: parseJson(row.DUMP_FILES) ?? [],
  };
}

const JOB_COLUMNS = 'job_name, plan_id, job_no, export_history_id, export_job_name, target_dbms_id, request_json, parfile_text, expected_json, dump_files';

async function findMigrationJob(jobName: string): Promise<MigrationJobRecord | null> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(`SELECT ${JOB_COLUMNS} FROM system.datapump_migration_job WHERE job_name = :jobName`, { jobName }, { ...OBJ, fetchInfo: JOB_FETCH });
    const row = result.rows?.[0];
    return row ? mapJob(row) : null;
  });
}

async function getMigrationJobs(planId: string): Promise<MigrationJobRecord[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(`SELECT ${JOB_COLUMNS} FROM system.datapump_migration_job WHERE plan_id = :planId ORDER BY job_no`, { planId }, { ...OBJ, fetchInfo: JOB_FETCH });
    return (result.rows ?? []).map(mapJob);
  });
}

// 이 Export 묶음으로 만든 Import 계획들 (최근 것부터)
async function listMigrationPlans(sourceDbmsId: number | string, bundleKey: string): Promise<MigrationPlanRecord[]> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT * FROM (
         SELECT plan_id, source_dbms_id, bundle_key, target_dbms_id, total_sets, omitted, filter_excluded, created_by, TO_CHAR(created_at, '${TS}') AS created_at
           FROM system.datapump_migration_plan
          WHERE source_dbms_id = :sourceDbmsId AND bundle_key = :bundleKey
          ORDER BY created_at DESC
       ) WHERE ROWNUM <= 20`,
      { sourceDbmsId: Number(sourceDbmsId), bundleKey },
      { ...OBJ, fetchInfo: { OMITTED: { type: oracledb.STRING }, FILTER_EXCLUDED: { type: oracledb.STRING } } }
    );
    return (result.rows ?? []).map((row) => ({
      planId: row.PLAN_ID,
      sourceDbmsId: row.SOURCE_DBMS_ID,
      bundleKey: row.BUNDLE_KEY,
      targetDbmsId: row.TARGET_DBMS_ID,
      totalSets: row.TOTAL_SETS,
      omitted: parseJson<string[]>(row.OMITTED) ?? [],
      filterExcluded: parseJson<string[]>(row.FILTER_EXCLUDED) ?? [],
      mapping: null,
      options: null,
      createdBy: row.CREATED_BY ?? null,
      createdAt: row.CREATED_AT,
    }));
  });
}

async function getMigrationPlan(planId: string): Promise<MigrationPlanRecord | null> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT plan_id, source_dbms_id, bundle_key, target_dbms_id, total_sets, omitted, filter_excluded, mapping_json, options_json, created_by,
              TO_CHAR(created_at, '${TS}') AS created_at
         FROM system.datapump_migration_plan WHERE plan_id = :planId`,
      { planId },
      {
        ...OBJ,
        fetchInfo: { OMITTED: { type: oracledb.STRING }, FILTER_EXCLUDED: { type: oracledb.STRING }, MAPPING_JSON: { type: oracledb.STRING }, OPTIONS_JSON: { type: oracledb.STRING } },
      }
    );
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      planId: row.PLAN_ID,
      sourceDbmsId: row.SOURCE_DBMS_ID,
      bundleKey: row.BUNDLE_KEY,
      targetDbmsId: row.TARGET_DBMS_ID,
      totalSets: row.TOTAL_SETS,
      omitted: parseJson<string[]>(row.OMITTED) ?? [],
      filterExcluded: parseJson<string[]>(row.FILTER_EXCLUDED) ?? [],
      mapping: parseJson(row.MAPPING_JSON),
      options: parseJson(row.OPTIONS_JSON),
      createdBy: row.CREATED_BY ?? null,
      createdAt: row.CREATED_AT,
    };
  });
}

// 생성한 Import 작업들의 실행 결과 (대상 DB의 작업 이력, 스키마별 하위 작업 _S1.. 포함)
async function getImportResults(targetDbmsId: number, jobNames: string[]): Promise<{ jobName: string; status: string; verifyStatus: string | null; id: number }[]> {
  if (jobNames.length === 0) return [];
  return withPool(async (connection) => {
    const binds: Record<string, string | number> = { dbmsId: targetDbmsId };
    const conditions = jobNames.map((name, i) => {
      binds[`j${i}`] = name;
      binds[`p${i}`] = `${name}\\_S%`;
      return `job_name = :j${i} OR job_name LIKE :p${i} ESCAPE '\\'`;
    });
    const result = await connection.execute<Record<string, any>>(
      `SELECT id, job_name, status, verify_status FROM system.datapump_job_history
        WHERE dbms_id = :dbmsId AND operation = 'IMPORT' AND (${conditions.join(' OR ')}) ORDER BY id`,
      binds,
      OBJ
    );
    return (result.rows ?? []).map((row) => ({ id: row.ID, jobName: row.JOB_NAME, status: row.STATUS, verifyStatus: row.VERIFY_STATUS ?? null }));
  });
}

export {
  saveBundle,
  getBundleJobs,
  findBundleJob,
  getPartitionRows,
  listPartitionExports,
  getExportRows,
  listExportBundles,
  listRemapSets,
  saveRemapSet,
  deleteRemapSet,
  saveMigration,
  findMigrationJob,
  getMigrationJobs,
  listMigrationPlans,
  getMigrationPlan,
  getImportResults,
};
