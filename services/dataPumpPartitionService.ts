import * as dataPumpModel from '../models/dataPumpModel';
import type { PartitionTableInfo } from '../models/dataPumpModel';
import type { DbmsIdParam } from '../models/dbmsModel';
import { buildParfile, buildPlan, fail, filename, identifier, timestamp } from './dataPumpService';
import type { DataPumpRequest } from './dataPumpService';
import { buildRanges, MANIFEST_KIND, overlaps, rangeLabel, safeFilePart, sameRange } from './partitionRanges';
import type { PartitionManifest, PartitionManifestEntry, PartitionRange } from './partitionRanges';

// Range 파티션 export/import 보조 기능 (Export 탭의 "Range 파티션" 대상, Import 탭의 "파티션 덤프" 가져오기).
//  - Export 분할 계획 자체는 dataPumpService.planExport가 다른 대상과 같은 옵션(분할 크기/PARALLEL/FILESIZE …)으로 만든다.
//  - Import는 export 때 남긴 매니페스트를 읽어 기간으로 파티션을 고르고, 덤프 하나당 작업 하나로 가져온다.
//    대상 DB 파티션은 이름이 아니라 범위로 맞춘다 (인터벌 파티션은 DB마다 SYS_P… 이름이 달라서).

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

// ── 매니페스트 해석 (순수 함수) ──

function parseManifest(text: unknown): PartitionManifest {
  if (typeof text !== 'string' || text.trim() === '') fail('매니페스트 내용이 비어 있습니다.');
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    fail('매니페스트가 JSON 형식이 아닙니다.');
  }
  if (!data || data.kind !== MANIFEST_KIND || data.version !== 1 || !Array.isArray(data.partitions)) {
    fail('DB Cockpit 파티션 export 매니페스트가 아닙니다.');
  }
  const dateOrNull = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) fail('매니페스트의 파티션 범위 형식이 올바르지 않습니다.');
    return value;
  };
  const partitions: PartitionManifestEntry[] = data.partitions.map((entry: any) => ({
    name: identifier(entry?.name, '파티션'),
    position: Number(entry?.position) || 0,
    highValue: String(entry?.highValue ?? ''),
    known: entry?.known === true,
    low: dateOrNull(entry?.low),
    high: dateOrNull(entry?.high),
    numRows: entry?.numRows === null || entry?.numRows === undefined ? null : Number(entry.numRows),
    bytes: Number(entry?.bytes) || 0,
    dumpfile: filename(entry?.dumpfile, '덤프 파일'),
  }));
  return {
    kind: MANIFEST_KIND,
    version: 1,
    createdAt: String(data.createdAt ?? ''),
    sourceDb: String(data.sourceDb ?? ''),
    owner: identifier(data.owner, '테이블 소유자'),
    table: identifier(data.table, '테이블'),
    keyColumn: String(data.keyColumn ?? ''),
    keyType: String(data.keyType ?? ''),
    interval: data.interval ? String(data.interval) : null,
    directory: String(data.directory ?? ''),
    partitions,
  };
}

// ── Import 계획 (순수 함수) ──

export interface PartitionImportOptions {
  directory: string; // 덤프와 매니페스트를 옮겨 둔 이 DB의 DIRECTORY
  logPrefix: string;
  targetOwner?: string | null; // 비우면 매니페스트의 소유자 그대로 (다르면 REMAP_SCHEMA)
  parallel: number;
  content?: 'ALL' | 'DATA_ONLY'; // DATA_ONLY = 이미 있는 테이블에 데이터만
  excludeStatistics?: boolean;
  truncateBeforeLoad?: boolean; // 같은 범위의 대상 파티션을 비우고 넣기
}

export interface PartitionImportJob {
  no: number;
  dumpfile: string;
  partitions: PartitionManifestEntry[]; // 이 덤프에 든 파티션 (전부 들어감)
  extraPartitions: string[]; // 고르지 않았지만 같은 덤프라 같이 들어가는 파티션
  truncatePartitions: string[]; // 시작 전에 비울 대상 테이블 파티션
  bytes: number;
  request: DataPumpRequest;
}

export interface PartitionImportPlan {
  jobs: PartitionImportJob[];
  targetOwner: string;
  targetTableExists: boolean;
  createsTable: boolean; // 대상 테이블이 없어 첫 작업이 테이블을 만든다 → 첫 작업은 혼자 돌려야 함
  notes: string[];
}

// target = 대상 DB에 있는 같은 테이블(대상 스키마 기준)의 파티션 범위, 테이블이 없으면 null.
function planPartitionImportJobs(
  manifest: PartitionManifest,
  selected: unknown,
  options: PartitionImportOptions,
  target: PartitionRange[] | null,
  now: Date = new Date()
): PartitionImportPlan {
  if (!Array.isArray(selected) || selected.length === 0) fail('가져올 파티션을 하나 이상 골라주세요.');
  const names = new Set(selected.map((name) => identifier(name, '파티션')));
  const unknown = [...names].filter((name) => !manifest.partitions.some((entry) => entry.name === name));
  if (unknown.length > 0) fail(`매니페스트에 없는 파티션입니다: ${unknown.slice(0, 10).join(', ')}`);

  const directory = identifier(options.directory, 'DIRECTORY');
  const prefix = typeof options.logPrefix === 'string' ? options.logPrefix.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(prefix)) fail('로그 파일 접두어는 영문/숫자/_ - 만 쓸 수 있습니다 (60자 이하).');
  const parallel = Number(options.parallel ?? 1);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 32) fail('PARALLEL은 1~32 사이 정수여야 합니다.');
  const targetOwner = options.targetOwner && String(options.targetOwner).trim() ? identifier(options.targetOwner, '대상 스키마') : manifest.owner;
  const content = options.content === 'ALL' ? 'ALL' : 'DATA_ONLY';
  const tableExists = target !== null;
  const notes: string[] = [];

  if (!tableExists && content === 'DATA_ONLY') {
    fail(`대상 DB에 ${targetOwner}.${manifest.table} 테이블이 없습니다. 테이블까지 만들려면 CONTENT를 "구조 + 데이터"로 골라주세요.`);
  }
  if (tableExists && content === 'ALL') {
    notes.push('테이블이 이미 있어 테이블 DDL은 건너뛰고, 인덱스/제약조건 등 이미 있는 오브젝트는 "already exists" 오류로 남습니다 (데이터는 들어감).');
  }

  // 고른 파티션이 든 덤프 단위로 작업을 만든다 (덤프 하나에 파티션 여러 개를 묶어 export했으면 같이 들어감).
  const byDump = new Map<string, PartitionManifestEntry[]>();
  for (const entry of [...manifest.partitions].sort((a, b) => a.position - b.position)) {
    byDump.set(entry.dumpfile, [...(byDump.get(entry.dumpfile) ?? []), entry]);
  }
  const dumps = [...byDump.entries()].filter(([, entries]) => entries.some((entry) => names.has(entry.name)));

  // 비울 대상 파티션: 대상 테이블에서 원본 파티션 범위와 겹치는 파티션이
  //   없음 → 비울 게 없음 (인터벌 파티션이면 넣을 때 새로 생김)
  //   범위가 똑같은 파티션 하나 → 그 파티션을 비움
  //   그 외(범위가 더 넓거나 여러 개에 걸침) → 다른 기간 데이터까지 지워지므로 거부
  const truncateMap = new Map<string, string | null>();
  if (options.truncateBeforeLoad && target) {
    const problems: string[] = [];
    const unknownTarget = target.filter((range) => !range.known).map((range) => range.name);
    if (unknownTarget.length > 0) problems.push(`대상 테이블에 범위를 해석할 수 없는 파티션이 있음 (${unknownTarget.slice(0, 5).join(', ')})`);
    for (const entry of problems.length > 0 ? [] : dumps.flatMap(([, entries]) => entries)) {
      if (!entry.known) {
        problems.push(`${entry.name}(범위를 알 수 없음)`);
        continue;
      }
      const hits = target.filter((range) => overlaps(range, entry.low, entry.high));
      if (hits.length === 0) truncateMap.set(entry.name, null);
      else if (hits.length === 1 && sameRange(hits[0], entry)) truncateMap.set(entry.name, hits[0].name);
      else problems.push(`${entry.name} → 대상 ${hits.map((hit) => hit.name).join(', ')}`);
    }
    if (problems.length > 0) {
      fail(
        `대상 테이블의 파티션 범위가 원본과 달라 비우기를 할 수 없습니다 (비우면 다른 기간 데이터까지 지워짐): ${problems.slice(0, 10).join('; ')}` +
          `${problems.length > 10 ? ' …' : ''}. 비우기 없이(APPEND) 가져오거나 대상 파티션을 직접 정리해주세요.`
      );
    }
  }

  const stamp = timestamp(now);
  const digits = Math.max(2, String(dumps.length).length);
  const jobs = dumps.map(([dumpfile, entries], index): PartitionImportJob => {
    const no = index + 1;
    const nn = String(no).padStart(digits, '0');
    const truncatePartitions = entries.map((entry) => truncateMap.get(entry.name)).filter((name): name is string => !!name);
    const request: DataPumpRequest = {
      operation: 'IMPORT',
      mode: 'TABLE',
      tableOwner: manifest.owner,
      tables: [manifest.table],
      directory,
      dumpfile,
      logfile: entries.length === 1 ? `${prefix}_${safeFilePart(entries[0].name)}.log` : `${prefix}_${nn}.log`,
      jobName: `DBC_IMP_${stamp}_${nn}`,
      parallel,
      content,
      excludeStatistics: options.excludeStatistics !== false,
      // 파티션 덤프를 기존 테이블에 넣으려면 APPEND (TRUNCATE는 파티션이 아니라 테이블 전체를 비울 수 있어서 쓰지 않음)
      tableExistsAction: 'APPEND',
      remapSchemas: targetOwner !== manifest.owner ? [{ from: manifest.owner, to: targetOwner }] : [],
      truncatePartitions,
    };
    buildPlan(request, now);
    return {
      no,
      dumpfile,
      partitions: entries,
      extraPartitions: entries.filter((entry) => !names.has(entry.name)).map((entry) => entry.name),
      truncatePartitions,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      request,
    };
  });
  const extras = jobs.flatMap((job) => job.extraPartitions);
  if (extras.length > 0) notes.push(`고르지 않았지만 같은 덤프에 들어 있어 같이 들어가는 파티션 ${extras.length}개: ${extras.slice(0, 10).join(', ')}${extras.length > 10 ? ' …' : ''}`);

  return { jobs, targetOwner, targetTableExists: tableExists, createsTable: !tableExists, notes };
}

// ── DB를 거치는 기능 ──

async function getTables(dbmsid: DbmsIdParam, owner: unknown): Promise<PartitionTableInfo[]> {
  const name = identifier(owner, '스키마');
  try {
    return await dataPumpModel.getRangePartitionedTables(dbmsid, name);
  } catch (error) {
    throw new Error('파티션 테이블 목록 조회 실패', { cause: error });
  }
}

async function loadRanges(dbmsid: DbmsIdParam, owner: string, table: string): Promise<{ table: PartitionTableInfo | null; ranges: PartitionRange[] }> {
  try {
    const result = await dataPumpModel.getTablePartitions(dbmsid, owner, table);
    return { table: result.table, ranges: buildRanges(result.partitions) };
  } catch (error) {
    throw new Error(`파티션 목록 조회 실패 (${owner}.${table})`, { cause: error });
  }
}

// 파티션별 범위와 크기 (Export 탭에서 기간으로 고를 때).
async function getPartitions(dbmsid: DbmsIdParam, owner: unknown, table: unknown): Promise<{ table: PartitionTableInfo; partitions: PartitionRange[] }> {
  const ownerName = identifier(owner, '스키마');
  const tableName = identifier(table, '테이블');
  const result = await loadRanges(dbmsid, ownerName, tableName);
  if (!result.table) fail(`${ownerName}.${tableName}은(는) 파티션 키가 컬럼 하나인 RANGE 파티션 테이블이 아닙니다.`);
  return { table: result.table, partitions: result.ranges };
}

// DB 서버 DIRECTORY에 있는 매니페스트를 읽는다.
async function readManifest(dbmsid: DbmsIdParam, directory: unknown, file: unknown): Promise<{ manifest: PartitionManifest; text: string }> {
  const dir = identifier(directory, 'DIRECTORY');
  const name = filename(file, '매니페스트 파일');
  if (!/\.json$/i.test(name)) fail('매니페스트 파일은 .json 이어야 합니다.');
  let content;
  try {
    content = await dataPumpModel.readLog(dbmsid, dir, name, MAX_MANIFEST_BYTES);
  } catch (error) {
    throw new Error('매니페스트 파일 읽기 실패', { cause: error });
  }
  if (!content.exists) fail(`${dir}에 ${name} 파일이 없습니다.`);
  if (content.truncated) fail('매니페스트 파일이 너무 큽니다.');
  return { manifest: parseManifest(content.text), text: content.text };
}

export interface PartitionImportJobView extends PartitionImportJob {
  jobName: string;
  parfile: string;
  parfileName: string;
  command: string;
}

async function planImport(
  dbmsid: DbmsIdParam,
  manifestInput: unknown,
  selected: unknown,
  options: PartitionImportOptions
): Promise<Omit<PartitionImportPlan, 'jobs'> & { jobs: PartitionImportJobView[]; totalBytes: number }> {
  const manifest = parseManifest(manifestInput);
  const targetOwner = options.targetOwner && String(options.targetOwner).trim() ? identifier(options.targetOwner, '대상 스키마') : manifest.owner;
  const [target, targetInfo] = await Promise.all([loadRanges(dbmsid, targetOwner, manifest.table), dataPumpModel.getTargetInfo(dbmsid)]);
  if (!target.table) {
    // 같은 이름의 테이블이 있는데 (키 하나짜리) RANGE 파티션 테이블이 아니면 구조가 다른 것이라 막는다.
    let sizes: { name: string }[];
    try {
      sizes = await dataPumpModel.getTableSizes(dbmsid, [targetOwner]);
    } catch (error) {
      throw new Error('대상 테이블 확인 실패', { cause: error });
    }
    if (sizes.some((row) => row.name === manifest.table)) {
      fail(`대상 ${targetOwner}.${manifest.table}이(가) 있지만 같은 형태의 RANGE 파티션 테이블이 아닙니다. 테이블 구조를 확인해주세요.`);
    }
  }
  const now = new Date();
  const plan = planPartitionImportJobs(manifest, selected, { ...options, targetOwner }, target.table ? target.ranges : null, now);
  return {
    ...plan,
    totalBytes: plan.jobs.reduce((sum, job) => sum + job.bytes, 0),
    jobs: plan.jobs.map((job) => {
      const built = buildPlan(job.request, now);
      const first = job.partitions[0];
      const last = job.partitions[job.partitions.length - 1];
      const label = `${manifest.owner}.${manifest.table} 파티션 ${job.partitions.map((p) => p.name).join(', ')} (${rangeLabel({ ...first, high: last.high, known: job.partitions.every((p) => p.known) })})`;
      return { ...job, jobName: built.jobName, ...buildParfile(built, job.request, targetInfo, `작업 ${job.no}/${plan.jobs.length}: ${label}`) };
    }),
  };
}

export { parseManifest, planPartitionImportJobs, getTables, getPartitions, readManifest, planImport };
