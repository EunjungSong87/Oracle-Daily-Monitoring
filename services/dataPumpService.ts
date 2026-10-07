import * as dataPumpModel from '../models/dataPumpModel';
import type { DataPumpJob, DataPumpPlan, DbLinkInfo, DirectoryInfo, LogContent, TableSize, TargetInfo } from '../models/dataPumpModel';
import type { DbmsIdParam } from '../models/dbmsModel';
import * as historyService from './dataPumpHistoryService';
import { cached, cacheKey } from './dataPumpSizeCache';
import { buildManifest, buildRanges, manifestText, rangeLabel, safeFilePart } from './partitionRanges';
import type { PartitionManifestEntry, PartitionRange } from './partitionRanges';

// 화면이 보내는 Data Pump 작업 요청 하나. 검증을 통과하면 DataPumpPlan(model이 바인드 변수로 실행하는 형태)이 됩니다.
export interface DataPumpRequest {
  operation: 'EXPORT' | 'IMPORT';
  mode: 'SCHEMA' | 'TABLE' | 'FULL'; // FULL은 IMPORT만 (덤프에 든 것 전부)
  schemas?: string[]; // SCHEMA 모드
  tableOwner?: string | null; // TABLE 모드 (테이블이 한 스키마일 때)
  tables?: string[]; // TABLE 모드 (테이블이 한 스키마일 때)
  // TABLE 모드에서 여러 스키마의 테이블을 한 작업에 (expdp TABLES=HR.EMP,SCOTT.DEPT — 11.2부터 가능). 있으면 tableOwner/tables 대신 씀.
  qualifiedTables?: { owner: string; table: string }[];
  excludeTables?: string[]; // SCHEMA 모드(스키마 하나)에서 뺄 테이블 — 분할 시 다른 작업으로 떼어 낸 큰 테이블
  directory: string;
  dumpfile: string;
  logfile: string;
  jobName?: string | null; // 없으면 DBC_EXP_/DBC_IMP_ + 시각으로 자동
  parallel?: number;
  filesize?: string | null; // 덤프 파일 하나의 최대 크기 (예: 2G, 512M)
  content?: 'ALL' | 'METADATA_ONLY' | 'DATA_ONLY';
  excludeStatistics?: boolean;
  reuseDumpfiles?: boolean; // EXPORT
  flashbackConsistent?: boolean; // EXPORT(또는 NETWORK_LINK import) — 작업 시작 시점 SCN으로 일관성 있게
  flashbackScn?: string | null; // EXPORT — 여러 작업을 같은 시점으로 맞출 때 쓰는 지정 SCN
  tableExistsAction?: 'SKIP' | 'APPEND' | 'TRUNCATE' | 'REPLACE'; // IMPORT
  remapSchemas?: { from: string; to: string }[]; // IMPORT
  remapTablespaces?: { from: string; to: string }[]; // IMPORT
  // DB 링크 이름. EXPORT: 링크 너머 DB의 오브젝트를 이 DB의 DIRECTORY에 덤프로, IMPORT: 링크 너머 DB에서 덤프 없이 바로 가져옴.
  networkLink?: string | null;
  // 파티션 단위 EXPORT (TABLE 모드): 테이블마다 이 파티션만 내보냄 — expdp TABLES=OWNER.TAB:PART. 여기 없는 테이블은 통째로.
  tablePartitions?: { owner?: string; table: string; partitions: string[] }[]; // owner가 없으면 tableOwner
  // 테이블이 하나일 때의 줄임 표기 (= tablePartitions [{ table: tables[0], partitions }])
  partitions?: string[];
  // 파티션 단위 IMPORT (TABLE 모드, 테이블 하나): 시작 전에 대상 테이블(REMAP_SCHEMA 반영)에서 이 파티션들을 비움
  truncatePartitions?: string[];
}

export class DataPumpValidationError extends Error {}

// 따옴표 없는 일반 Oracle 식별자만 받습니다 (대문자로 바꿔서 비교). PL/SQL에는 바인드 변수로 넘기지만,
// 필터식(IN ('A','B'))을 문자열로 조립하므로 따옴표 같은 문자가 끼어들 여지를 아예 막아 둡니다.
const IDENTIFIER = /^[A-Z][A-Z0-9_$#]{0,127}$/;
// 덤프/로그 파일 이름: 영문/숫자/_ . - 와 %U(파일 번호 치환자)만. 경로 구분자는 허용하지 않습니다 (DIRECTORY 안에만 생성).
const FILENAME = /^[A-Za-z0-9_.%-]{1,200}$/;
// DB 링크 이름은 도메인이 붙을 수 있다 (예: SRC_DB.EXAMPLE.COM). 실행 전에 이 DB의 링크 목록과 한 번 더 대조한다.
const DB_LINK = /^[A-Z][A-Z0-9_$#.@]{0,127}$/;
const FILE_PREFIX = /^[A-Za-z0-9_-]{1,60}$/;
const FILESIZE = /^\d+(\.\d+)?[KMGT]?$/;
const MAX_PARALLEL = 32;
// DBMS_DATAPUMP 필터 값(VARCHAR2)에 넣을 수 있는 길이 — 테이블 목록이 이보다 길면 그룹을 더 잘게 나눠야 합니다.
const MAX_FILTER_LENGTH = 30000;
// 기존 데이터를 건드리는 TABLE_EXISTS_ACTION — 실행 전에 대상 DB명을 직접 입력해 확인받습니다.
export const DESTRUCTIVE_ACTIONS = ['APPEND', 'TRUNCATE', 'REPLACE'] as const;

function fail(message: string): never {
  throw new DataPumpValidationError(message);
}

function identifier(value: unknown, label: string): string {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!IDENTIFIER.test(upper)) fail(`${label} 이름이 올바르지 않습니다: ${String(value ?? '')}`);
  return upper;
}

function identifierList(values: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(values) || (values.length === 0 && !allowEmpty)) fail(`${label}을(를) 하나 이상 지정해주세요.`);
  return Array.from(new Set(values.map((value) => identifier(value, label))));
}

// TABLE 모드 요청의 (소유자, 테이블) 목록. qualifiedTables가 있으면 그것, 없으면 tableOwner + tables.
function tablePairs(request: DataPumpRequest): { owner: string; table: string }[] {
  if (Array.isArray(request.qualifiedTables) && request.qualifiedTables.length > 0) {
    const seen = new Set<string>();
    const pairs: { owner: string; table: string }[] = [];
    for (const entry of request.qualifiedTables) {
      const pair = { owner: identifier(entry?.owner, '테이블 소유자'), table: identifier(entry?.table, '테이블') };
      const key = `${pair.owner}.${pair.table}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push(pair);
      }
    }
    return pairs;
  }
  const owner = identifier(request.tableOwner, '테이블 소유자');
  return identifierList(request.tables, '테이블').map((table) => ({ owner, table }));
}

// 비어 있으면 링크를 안 쓰는 것. 실제로 있는 링크인지는 DB를 거치는 단계에서 ensureDbLink로 확인한다.
function dbLink(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const name = String(value).trim().toUpperCase();
  if (!DB_LINK.test(name)) fail(`DB 링크 이름이 올바르지 않습니다: ${String(value)}`);
  return name;
}

function filename(value: unknown, label: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!FILENAME.test(name) || name.startsWith('.')) {
    fail(`${label} 이름이 올바르지 않습니다 (영문/숫자/_ . - %U만 사용, 경로 없이 파일 이름만).`);
  }
  return name;
}

function filterExpr(operator: 'IN' | 'NOT IN', values: string[], label: string): string {
  const expr = `${operator} (${values.map((value) => `'${value}'`).join(',')})`;
  if (expr.length > MAX_FILTER_LENGTH) fail(`${label} 목록이 너무 깁니다 (${values.length}개). 분할 크기를 줄여 작업을 더 나눠주세요.`);
  return expr;
}

function remapList(values: unknown, label: string): { from: string; to: string }[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) fail(`${label} 형식이 올바르지 않습니다.`);
  const pairs = values
    .filter((pair) => pair && (pair.from || pair.to))
    .map((pair) => ({ from: identifier(pair.from, `${label} 원본`), to: identifier(pair.to, `${label} 대상`) }));
  const froms = pairs.map((pair) => pair.from);
  if (new Set(froms).size !== froms.length) fail(`${label}에 같은 원본이 두 번 있습니다.`);
  return pairs;
}

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// ── 크기 ──

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

// '1T', '500G', '512M' → 바이트. 단위가 없으면 바이트.
function parseSize(value: unknown, label: string): number {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : String(value ?? '');
  const match = text.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/);
  if (!match) fail(`${label} 형식이 올바르지 않습니다 (예: 1T, 500G).`);
  const bytes = Number(match[1]) * (match[2] ? UNIT[match[2]] : 1);
  if (!(bytes > 0)) fail(`${label}은(는) 0보다 커야 합니다.`);
  return bytes;
}

// 그룹 하나를 PARALLEL로 동시에 쓸 때 덤프 파일 하나의 크기(FILESIZE): 그룹 크기 ÷ PARALLEL에 5% 여유를 두고,
// 1G 이상이면 G 단위, 그 아래면 100M 단위로 올림합니다. 결과적으로 덤프가 대략 PARALLEL 개수의 파일로 나뉩니다.
function suggestFilesize(bytes: number, parallel: number): string | null {
  if (bytes <= 0) return null;
  const perFileMb = Math.ceil((bytes / Math.max(1, parallel)) * 1.05 / UNIT.M);
  if (perFileMb >= 1024) return `${Math.ceil(perFileMb / 1024)}G`;
  return `${Math.max(100, Math.ceil(perFileMb / 100) * 100)}M`;
}

// FILESIZE로 쪼갰을 때 대략 몇 개의 덤프 파일이 생기는지 (PARALLEL보다 적게는 안 나뉨).
function expectedFileCount(bytes: number, parallel: number, filesize: string | null): number {
  if (!filesize) return Math.max(1, parallel);
  return Math.max(parallel, Math.ceil(bytes / parseSize(filesize, 'FILESIZE')));
}

// ── 요청 → 실행 계획 (DB 접근 없는 순수 함수, 단위 테스트로 검증) ──

function buildPlan(request: DataPumpRequest, now: Date = new Date()): DataPumpPlan {
  const operation = request.operation;
  if (operation !== 'EXPORT' && operation !== 'IMPORT') fail('operation은 EXPORT 또는 IMPORT여야 합니다.');
  const isExport = operation === 'EXPORT';

  const mode = request.mode;
  if (!['SCHEMA', 'TABLE', 'FULL'].includes(mode)) fail('모드가 올바르지 않습니다.');
  if (isExport && mode === 'FULL') fail('전체(FULL) Export는 지원하지 않습니다. 스키마나 테이블을 골라주세요.');

  const networkLink = dbLink(request.networkLink);
  // 링크로 바로 가져오는 import는 덤프 파일이 없다. FULL이면 링크 너머 DB 전체가 되므로 막는다.
  const networkImport = !isExport && networkLink !== null;
  if (networkImport && mode === 'FULL') fail('DB 링크로 가져올 때는 스키마나 테이블을 지정해주세요 (원본 DB 전체 가져오기는 지원하지 않음).');

  let schemaExpr: string | null = null;
  let nameExpr: string | null = null;
  let excludeTableExpr: string | null = null;
  const partitionFilters: DataPumpPlan['partitionFilters'] = [];
  let multiSchemaTables = false;
  let truncateTarget: DataPumpPlan['truncateTarget'] = null;
  const shortPartitions = identifierList(request.partitions ?? [], '파티션', true);
  const requested = Array.isArray(request.tablePartitions) ? request.tablePartitions : [];
  const hasPartitions = shortPartitions.length > 0 || requested.length > 0;
  const truncateList = identifierList(request.truncatePartitions ?? [], '비울 파티션', true);
  if (mode === 'SCHEMA') {
    const schemas = identifierList(request.schemas, '스키마');
    schemaExpr = filterExpr('IN', schemas, '스키마');
    const excluded = identifierList(request.excludeTables ?? [], '제외 테이블', true);
    if (excluded.length > 0) {
      if (schemas.length !== 1) fail('제외 테이블은 스키마를 하나만 고른 작업에서만 지정할 수 있습니다.');
      excludeTableExpr = filterExpr('NOT IN', excluded, '제외 테이블');
    }
  } else if (mode === 'TABLE') {
    const pairs = tablePairs(request);
    // DBMS_DATAPUMP는 스키마 목록 × 테이블 이름 목록으로 거른다. 여러 스키마를 섞으면 목록에 없는 같은 이름 테이블까지
    // 걸릴 수 있어서, 섞어도 되는 조합인지는 분할 계획(planExportGroups)이 실제 테이블 목록과 대조해 정한다.
    const owners = [...new Set(pairs.map((pair) => pair.owner))];
    multiSchemaTables = owners.length > 1;
    schemaExpr = filterExpr('IN', owners, '스키마');
    nameExpr = filterExpr('IN', [...new Set(pairs.map((pair) => pair.table))], '테이블');
    if (shortPartitions.length > 0 && pairs.length !== 1) fail('partitions는 테이블을 하나만 지정한 작업에서만 씁니다 (여러 테이블이면 tablePartitions).');
    if (truncateList.length > 0 && pairs.length !== 1) fail('파티션 비우기는 테이블을 하나만 지정한 작업에서만 쓸 수 있습니다.');
    const byTable = new Map<string, string[]>(); // OWNER.TABLE → 파티션
    const keyOf = (owner: string, table: string) => `${owner}.${table}`;
    if (shortPartitions.length > 0) byTable.set(keyOf(pairs[0].owner, pairs[0].table), shortPartitions);
    for (const entry of requested) {
      const table = identifier(entry?.table, '테이블');
      const owner = entry?.owner ? identifier(entry.owner, '테이블 소유자') : owners.length === 1 ? owners[0] : fail('여러 스키마 작업의 파티션에는 owner가 필요합니다.');
      const key = keyOf(owner, table);
      if (!pairs.some((pair) => keyOf(pair.owner, pair.table) === key)) fail(`파티션을 지정한 테이블 ${key}이(가) 작업의 테이블 목록에 없습니다.`);
      const names = identifierList(entry?.partitions, '파티션');
      byTable.set(key, [...new Set([...(byTable.get(key) ?? []), ...names])]);
    }
    for (const [key, names] of byTable) {
      const [owner, table] = key.split('.');
      partitionFilters.push({ owner, table, partitions: names });
    }
    if (truncateList.length > 0) {
      // REMAP_SCHEMA가 있으면 실제로 데이터가 들어가는 쪽(대상 스키마)의 테이블을 비운다.
      const { owner, table } = pairs[0];
      const remapped = remapList(request.remapSchemas, 'REMAP_SCHEMA').find((pair) => pair.from === owner)?.to ?? owner;
      truncateTarget = { owner: remapped, name: table };
    }
  }
  if (hasPartitions) {
    if (!isExport) fail('파티션 지정은 Export에서만 합니다 (파티션 덤프는 덤프 전체를 가져오면 됩니다).');
    if (networkLink) fail('파티션 단위 export는 DB 링크 없이 이 DB에서만 지원합니다.');
    if (mode !== 'TABLE') fail('파티션 지정은 테이블 모드에서만 할 수 있습니다.');
    const encodedLength = partitionFilters.reduce((sum, filter) => sum + filter.owner.length + filter.table.length + filter.partitions.join(',').length + 3, 0);
    if (encodedLength > MAX_FILTER_LENGTH) fail('한 작업의 파티션 목록이 너무 깁니다. 분할 크기를 줄여 작업을 나눠주세요.');
  }
  if (truncateList.length > 0) {
    if (isExport || networkImport) fail('파티션 비우기는 덤프 파일 Import에서만 할 수 있습니다.');
    if (mode !== 'TABLE') fail('파티션 비우기는 테이블 모드에서만 할 수 있습니다.');
  }

  const parallel = request.parallel === undefined ? 1 : Number(request.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) fail(`PARALLEL은 1~${MAX_PARALLEL} 사이 정수여야 합니다.`);

  let filesize: string | null = null;
  if (request.filesize !== undefined && request.filesize !== null && String(request.filesize).trim() !== '') {
    filesize = String(request.filesize).trim().toUpperCase();
    if (!FILESIZE.test(filesize)) fail('FILESIZE 형식이 올바르지 않습니다 (예: 2G, 512M).');
    if (!isExport) fail('FILESIZE는 Export에서만 지정합니다.');
  }

  const dumpfile = networkImport ? null : filename(request.dumpfile, '덤프 파일');
  const logfile = filename(request.logfile, '로그 파일');
  if (/%U/i.test(logfile)) fail('로그 파일 이름에는 %U를 쓸 수 없습니다.');
  // 여러 파일로 나눠 쓰려면(PARALLEL로 동시에 쓰거나 FILESIZE로 쪼갤 때) 파일 번호가 들어갈 자리가 있어야 합니다.
  if (isExport && dumpfile && (parallel > 1 || filesize) && !/%U/i.test(dumpfile)) {
    fail('PARALLEL이 2 이상이거나 FILESIZE를 지정하면 덤프 파일 이름에 %U가 있어야 합니다 (예: exp_%U.dmp).');
  }

  const content = request.content ?? 'ALL';
  if (!['ALL', 'METADATA_ONLY', 'DATA_ONLY'].includes(content)) fail('CONTENT 값이 올바르지 않습니다.');

  const tableExistsAction = isExport ? null : (request.tableExistsAction ?? 'SKIP');
  if (tableExistsAction && !['SKIP', 'APPEND', 'TRUNCATE', 'REPLACE'].includes(tableExistsAction)) {
    fail('TABLE_EXISTS_ACTION 값이 올바르지 않습니다.');
  }

  let flashbackScn: string | null = null;
  if (isExport && request.flashbackScn !== undefined && request.flashbackScn !== null && request.flashbackScn !== '') {
    flashbackScn = String(request.flashbackScn).trim();
    if (!/^\d{1,30}$/.test(flashbackScn)) fail('FLASHBACK_SCN 형식이 올바르지 않습니다.');
  }

  const jobName = request.jobName
    ? identifier(request.jobName, '작업')
    : `DBC_${isExport ? 'EXP' : 'IMP'}_${timestamp(now)}`;
  if (jobName.length > 30) fail('작업 이름은 30자 이하여야 합니다.');

  return {
    operation,
    jobMode: mode,
    jobName,
    directory: identifier(request.directory, 'DIRECTORY'),
    dumpfile,
    logfile,
    filesize,
    parallel,
    schemaExpr,
    nameExpr,
    excludeTableExpr,
    content,
    excludeStatistics: !!request.excludeStatistics,
    reuseDumpfiles: isExport && !!request.reuseDumpfiles,
    // 덤프 import는 덤프가 이미 한 시점의 데이터라 의미가 없고, 링크 import는 원본 DB 쪽 SCN으로 맞춘다.
    flashbackConsistent: (isExport || networkImport) && (!!request.flashbackConsistent || flashbackScn !== null),
    flashbackScn,
    tableExistsAction,
    remapSchemas: isExport ? [] : remapList(request.remapSchemas, 'REMAP_SCHEMA'),
    remapTablespaces: isExport ? [] : remapList(request.remapTablespaces, 'REMAP_TABLESPACE'),
    networkLink,
    partitionFilters,
    multiSchemaTables,
    truncateTarget,
    truncatePartitions: truncateList,
  };
}

function isDestructive(plan: DataPumpPlan): boolean {
  if (plan.truncatePartitions.length > 0) return true;
  return plan.tableExistsAction !== null && (DESTRUCTIVE_ACTIONS as readonly string[]).includes(plan.tableExistsAction);
}

// 같은 계획을 DB 서버에서 직접 돌릴 때 쓸 expdp/impdp parfile과 명령어. 비밀번호는 넣지 않습니다 (실행 시 프롬프트로 입력).
function buildParfile(
  plan: DataPumpPlan,
  request: DataPumpRequest,
  target: TargetInfo,
  comment?: string
): { parfile: string; command: string; parfileName: string } {
  const lines: string[] = [];
  if (comment) lines.push(`# ${comment}`);
  if (plan.truncateTarget && plan.truncatePartitions.length > 0) {
    lines.push('# 실행 전에 SQL*Plus에서 대상 파티션을 먼저 비우세요 (화면에서 실행하면 자동으로 합니다):');
    for (const partition of plan.truncatePartitions) {
      lines.push(`#   ALTER TABLE ${plan.truncateTarget.owner}.${plan.truncateTarget.name} TRUNCATE PARTITION ${partition} UPDATE INDEXES;`);
    }
  }
  lines.push(`DIRECTORY=${plan.directory}`);
  if (plan.dumpfile) lines.push(`DUMPFILE=${plan.dumpfile}`);
  lines.push(`LOGFILE=${plan.logfile}`);
  if (plan.networkLink) lines.push(`NETWORK_LINK=${plan.networkLink}`);
  if (plan.jobMode === 'SCHEMA') {
    lines.push(`SCHEMAS=${identifierList(request.schemas, '스키마').join(',')}`);
    const excluded = identifierList(request.excludeTables ?? [], '제외 테이블', true);
    if (excluded.length > 0) lines.push(`EXCLUDE=TABLE:"IN (${excluded.map((name) => `'${name}'`).join(',')})"`);
  } else if (plan.jobMode === 'TABLE') {
    // 파티션을 고른 테이블은 OWNER.TABLE:PART로 파티션마다, 나머지는 OWNER.TABLE로 통째. 스키마가 여럿이어도 한 줄에.
    const entries = tablePairs(request).flatMap(({ owner, table }) => {
      const filter = plan.partitionFilters.find((item) => item.owner === owner && item.table === table);
      return filter ? filter.partitions.map((partition) => `${owner}.${table}:${partition}`) : [`${owner}.${table}`];
    });
    lines.push(`TABLES=${entries.join(',')}`);
  } else {
    lines.push('FULL=Y');
  }
  if (plan.content !== 'ALL') lines.push(`CONTENT=${plan.content}`);
  if (plan.excludeStatistics) lines.push('EXCLUDE=STATISTICS');
  if (plan.parallel > 1) lines.push(`PARALLEL=${plan.parallel}`);
  if (plan.filesize) lines.push(`FILESIZE=${plan.filesize}`);
  if (plan.reuseDumpfiles) lines.push('REUSE_DUMPFILES=YES');
  if (plan.flashbackScn) lines.push(`FLASHBACK_SCN=${plan.flashbackScn}`);
  else if (plan.flashbackConsistent) lines.push('FLASHBACK_TIME=SYSTIMESTAMP');
  for (const pair of plan.remapSchemas) lines.push(`REMAP_SCHEMA=${pair.from}:${pair.to}`);
  for (const pair of plan.remapTablespaces) lines.push(`REMAP_TABLESPACE=${pair.from}:${pair.to}`);
  if (plan.tableExistsAction) lines.push(`TABLE_EXISTS_ACTION=${plan.tableExistsAction}`);
  lines.push(`JOB_NAME=${plan.jobName}`);

  const parfileName = `${plan.jobName.toLowerCase()}.par`;
  const tool = plan.operation === 'EXPORT' ? 'expdp' : 'impdp';
  const command = `${tool} ${target.user}@${target.host}:${target.port}/${target.sid} parfile=${parfileName}`;
  return { parfile: lines.join('\n') + '\n', command, parfileName };
}

// ── 크기 기준 자동 분할 ──

export interface ExportSplitOptions {
  directory: string;
  filePrefix: string; // 덤프/로그 파일 이름 앞부분, 예: exp_20261002
  chunkSize: string; // 작업 하나의 목표 최대 크기, 예: 1T (NONE이면 나누지 않음, PARTITION이면 파티션마다 작업 하나 — 파티션 대상만)
  parallel: number;
  filesizeMode: 'AUTO' | 'NONE' | 'CUSTOM'; // AUTO = 그룹 크기 ÷ PARALLEL
  customFilesize?: string | null;
  content?: DataPumpRequest['content'];
  excludeStatistics?: boolean;
  flashbackConsistent?: boolean;
  reuseDumpfiles?: boolean;
  networkLink?: string | null; // 링크 너머 DB의 오브젝트를 export (크기/스키마도 그 DB 기준)
}

// 어느 테이블의 파티션인지까지 붙인 파티션 (한 작업에 여러 테이블의 파티션이 섞일 수 있어서)
export type TablePartition = PartitionRange & { owner: string; table: string };

export interface TableListItem {
  owner: string;
  name: string;
  partition?: string; // "OWNER.TABLE:PARTITION" 줄
}

// 파티션들을 기간 순서대로 분할 크기까지 채워 묶는다 (같은 테이블은 되도록 한 작업 = 한 parfile에).
// 파티션 하나가 분할 크기보다 크면 혼자 한 작업, perPartition이면 무조건 파티션마다 하나.
function packPartitions(partitions: PartitionRange[], limit: number, perPartition: boolean): PartitionRange[][] {
  const bins: PartitionRange[][] = [];
  let binBytes = 0;
  for (const partition of [...partitions].sort((a, b) => a.position - b.position)) {
    const current = bins[bins.length - 1];
    if (!perPartition && current && binBytes + partition.bytes <= limit) {
      current.push(partition);
      binBytes += partition.bytes;
    } else {
      bins.push([partition]);
      binBytes = partition.bytes;
    }
  }
  return bins;
}

export type ExportSource =
  | { kind: 'SCHEMAS'; schemas: string[] }
  // 올린 목록. partition이 있는 줄은 그 테이블의 그 파티션만 (partitionRanges는 planExport가 DB에서 읽어 채움, 키 OWNER.TABLE)
  // existingTables: 목록의 스키마들 × 목록의 테이블 이름 중 DB에 실제로 있는 OWNER.TABLE (여러 스키마를 한 작업에 묶어도 되는지 판단용).
  // 없으면 sizes에 있는 테이블로 판단한다.
  | { kind: 'TABLES'; tables: TableListItem[]; partitionRanges?: Record<string, PartitionRange[]>; existingTables?: string[] }
  // Range 파티션 테이블 하나에서 고른 파티션들 (planExport가 DB에서 범위/크기를 읽어 채움)
  | { kind: 'PARTITIONS'; owner: string; table: string; partitions: PartitionRange[] };

export interface ExportGroup {
  no: number;
  owners: string[]; // SCHEMA 작업은 여러 스키마를 묶을 수 있음, TABLE 작업은 소유자 하나
  mode: 'SCHEMA' | 'TABLE';
  tables: TableSize[]; // 이 작업에 들어가는 테이블 (SCHEMA 모드면 스키마의 나머지 테이블)
  excludedTables: string[]; // SCHEMA 모드에서 다른 작업으로 떼어 낸 테이블
  partitions: TablePartition[]; // 파티션 단위로 내보내는 테이블의 파티션 (테이블별 기간 순), 없으면 빈 배열
  bytes: number;
  oversize: boolean; // 테이블 하나가 분할 크기보다 커서 기준을 넘는 그룹
  filesize: string | null;
  expectedFiles: number;
  request: DataPumpRequest; // 그대로 /dataPump/start에 보내면 되는 요청
}

// 큰 것부터 넣을 수 있는 첫 그룹에 넣는다 (First-Fit Decreasing). 분할 크기보다 큰 테이블은 혼자 한 그룹.
function packTables(tables: TableSize[], chunkBytes: number): TableSize[][] {
  const bins: { bytes: number; tables: TableSize[] }[] = [];
  for (const table of [...tables].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))) {
    const bin = bins.find((candidate) => candidate.bytes + table.bytes <= chunkBytes);
    if (bin) {
      bin.bytes += table.bytes;
      bin.tables.push(table);
    } else {
      bins.push({ bytes: table.bytes, tables: [table] });
    }
  }
  return bins.map((bin) => bin.tables);
}

// 스키마 하나를 분할 크기 이하의 작업들로 나눕니다.
//  - 전체가 분할 크기 이하면 SCHEMA 모드 작업 하나.
//  - 넘으면 큰 테이블부터 떼어 내 TABLE 모드 작업들로 묶고, 남은 테이블 + 테이블이 아닌 오브젝트(뷰/프로시저/시퀀스/권한 등)는
//    떼어 낸 테이블만 EXCLUDE한 SCHEMA 모드 작업 하나에 담습니다. 이렇게 하면 오브젝트가 빠지지 않고, 작업마다 들어가는
//    테이블 목록도 (큰 테이블 위주라) 짧게 유지됩니다.
function splitSchema(tables: TableSize[], chunkBytes: number): { carved: TableSize[][]; rest: TableSize[] } {
  const sorted = [...tables].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  let remaining = sorted.reduce((sum, table) => sum + table.bytes, 0);
  const carvedTables: TableSize[] = [];
  let index = 0;
  while (remaining > chunkBytes && index < sorted.length) {
    carvedTables.push(sorted[index]);
    remaining -= sorted[index].bytes;
    index++;
  }
  return { carved: packTables(carvedTables, chunkBytes), rest: sorted.slice(index) };
}

function planExportGroups(
  source: ExportSource,
  sizes: TableSize[],
  options: ExportSplitOptions,
  now: Date = new Date()
): { groups: ExportGroup[]; totalBytes: number; chunkBytes: number | null; missing: string[] } {
  const directory = identifier(options.directory, 'DIRECTORY');
  const prefix = typeof options.filePrefix === 'string' ? options.filePrefix.trim() : '';
  if (!FILE_PREFIX.test(prefix)) fail('파일 이름 접두어는 영문/숫자/_ - 만 쓸 수 있습니다.');
  const chunkText = String(options.chunkSize ?? '').trim().toUpperCase();
  const perPartition = chunkText === 'PARTITION';
  if (perPartition && source.kind === 'SCHEMAS') fail('"파티션마다 하나"는 Range 파티션 대상이나 테이블 목록에서만 고를 수 있습니다.');
  const chunkBytes = chunkText === 'NONE' || perPartition ? null : parseSize(chunkText, '분할 크기');
  const limit = chunkBytes ?? Number.POSITIVE_INFINITY;
  const parallel = Number(options.parallel ?? 1);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) fail(`PARALLEL은 1~${MAX_PARALLEL} 사이 정수여야 합니다.`);
  if (options.filesizeMode === 'CUSTOM' && !FILESIZE.test(String(options.customFilesize ?? '').trim().toUpperCase())) {
    fail('FILESIZE 형식이 올바르지 않습니다 (예: 2G, 512M).');
  }

  type Draft = Omit<ExportGroup, 'no' | 'filesize' | 'expectedFiles' | 'request' | 'partitions'> & { partitions?: TablePartition[] };
  const drafts: Draft[] = [];
  const missing: string[] = [];

  if (source.kind === 'SCHEMAS') {
    // 1) 분할 크기 이하인 스키마들은 통째로 여러 개를 한 작업(SCHEMAS=A,B,C)에 묶는다 (큰 것부터 First-Fit).
    // 2) 혼자서도 분할 크기를 넘는 스키마만 큰 테이블을 떼어 내 나눈다. 이 스키마의 "나머지" 작업은 떼어 낸 테이블을
    //    이름으로 EXCLUDE하는데, EXCLUDE는 스키마를 구분하지 않아서 다른 스키마와 섞으면 그쪽의 같은 이름 테이블까지
    //    빠질 수 있으므로 따로 둔다.
    const whole: { owner: string; tables: TableSize[]; bytes: number }[] = [];
    const splitDrafts: Draft[] = [];
    for (const owner of identifierList(source.schemas, '스키마')) {
      const tables = sizes.filter((table) => table.owner === owner);
      const bytes = tables.reduce((sum, table) => sum + table.bytes, 0);
      if (bytes <= limit) {
        whole.push({ owner, tables, bytes });
        continue;
      }
      const { carved, rest } = splitSchema(tables, limit);
      splitDrafts.push({
        owners: [owner],
        mode: 'SCHEMA',
        tables: rest,
        excludedTables: carved.flat().map((table) => table.name),
        bytes: rest.reduce((sum, table) => sum + table.bytes, 0),
        oversize: false,
      });
      for (const bin of carved) {
        const binBytes = bin.reduce((sum, table) => sum + table.bytes, 0);
        splitDrafts.push({ owners: [owner], mode: 'TABLE', tables: bin, excludedTables: [], bytes: binBytes, oversize: binBytes > limit });
      }
    }
    const schemaBins: { owners: string[]; tables: TableSize[]; bytes: number }[] = [];
    for (const schema of [...whole].sort((a, b) => b.bytes - a.bytes || a.owner.localeCompare(b.owner))) {
      const bin = schemaBins.find((candidate) => candidate.bytes + schema.bytes <= limit);
      if (bin) {
        bin.owners.push(schema.owner);
        bin.tables.push(...schema.tables);
        bin.bytes += schema.bytes;
      } else {
        schemaBins.push({ owners: [schema.owner], tables: [...schema.tables], bytes: schema.bytes });
      }
    }
    for (const bin of schemaBins) {
      drafts.push({ owners: [...bin.owners].sort(), mode: 'SCHEMA', tables: bin.tables, excludedTables: [], bytes: bin.bytes, oversize: false });
    }
    drafts.push(...splitDrafts);
  } else if (source.kind === 'PARTITIONS') {
    // 파티션은 기간 순서를 지켜 앞에서부터 분할 크기까지 채운다 (작업마다 연속된 기간이 되어 import 때 고르기 쉬움).
    const owner = identifier(source.owner, '테이블 소유자');
    const table = identifier(source.table, '테이블');
    if (source.partitions.length === 0) fail('파티션을 하나 이상 골라주세요.');
    for (const bin of packPartitions(source.partitions, limit, perPartition)) {
      const bytes = bin.reduce((sum, partition) => sum + partition.bytes, 0);
      drafts.push({
        owners: [owner],
        mode: 'TABLE',
        tables: [{ owner, name: table, bytes }],
        excludedTables: [],
        partitions: bin.map((partition) => ({ ...partition, owner, table })),
        bytes,
        oversize: bytes > limit,
      });
    }
  } else {
    // 올린 목록을 DB의 실제 테이블/파티션과 맞춰 보고, 없는 건 따로 알려줍니다. 소유자가 다르면 작업을 따로 만듭니다.
    // 같은 스키마는 분할 크기 안에서 되도록 한 작업(= 한 parfile)에 모읍니다. 통째로 적은 테이블과 파티션을 적은 테이블이
    // 섞여도 같은 작업에 담고(TABLES=O.T1,O.T2:P1,O.T2:P2), 한 테이블의 파티션은 그 테이블 혼자 분할 크기를 넘을 때만
    // 기간 순서로 나눕니다. 같은 테이블을 통째로도 적었으면 통째로 내보냅니다.
    const byKey = new Map(sizes.map((table) => [`${table.owner}.${table.name}`, table]));
    const partitionsByTable = new Map<string, Set<string>>();
    const wholeKeys: string[] = [];
    for (const item of source.tables) {
      const key = `${identifier(item.owner, '테이블 소유자')}.${identifier(item.name, '테이블')}`;
      if (item.partition) {
        partitionsByTable.set(key, (partitionsByTable.get(key) ?? new Set()).add(identifier(item.partition, '파티션')));
      } else if (!wholeKeys.includes(key)) {
        wholeKeys.push(key);
      }
    }

    // 묶음 단위: 통째 테이블 하나, 또는 한 테이블의 파티션 묶음(분할 크기를 넘으면 기간 순서로 여러 개).
    type Unit = { owner: string; table: TableSize; partitions: TablePartition[] };
    const units: Unit[] = [];
    for (const key of wholeKeys) {
      const table = byKey.get(key);
      if (!table) missing.push(key);
      else units.push({ owner: table.owner, table, partitions: [] });
    }
    for (const [key, names] of partitionsByTable) {
      if (wholeKeys.includes(key)) continue; // 통째로 내보내는 테이블
      const ranges = source.partitionRanges?.[key];
      if (!ranges) {
        missing.push(...[...names].map((name) => `${key}:${name}`));
        continue;
      }
      missing.push(...[...names].filter((name) => !ranges.some((range) => range.name === name)).map((name) => `${key}:${name}`));
      const picked = ranges.filter((range) => names.has(range.name));
      if (picked.length === 0) continue;
      const [owner, name] = key.split('.');
      for (const bin of packPartitions(picked, limit, perPartition)) {
        const bytes = bin.reduce((sum, partition) => sum + partition.bytes, 0);
        units.push({ owner, table: { owner, name, bytes }, partitions: bin.map((partition) => ({ ...partition, owner, table: name })) });
      }
    }

    // 스키마가 달라도 분할 크기 안이면 한 작업(parfile)에 묶는다 (큰 것부터 First-Fit Decreasing). 다만 실행(DBMS_DATAPUMP)은
    // "스키마 목록 × 테이블 이름 목록"으로 거르므로, 묶었을 때 목록에 없는 테이블(다른 스키마의 같은 이름 테이블 등)이
    // 딸려 들어가는 조합은 묶지 않는다. 실제로 있는 테이블은 sizes(목록에 나온 스키마의 전체 테이블)로 판단한다.
    const existing = new Set(source.existingTables ?? byKey.keys());
    const bins: { bytes: number; units: Unit[]; owners: Set<string>; names: Set<string>; keys: Set<string> }[] = [];
    const fitsWithoutStrays = (bin: (typeof bins)[number], unit: Unit): boolean => {
      const owners = new Set([...bin.owners, unit.owner]);
      const names = new Set([...bin.names, unit.table.name]);
      const keys = new Set([...bin.keys, `${unit.owner}.${unit.table.name}`]);
      for (const owner of owners) {
        for (const name of names) {
          const key = `${owner}.${name}`;
          if (existing.has(key) && !keys.has(key)) return false;
        }
      }
      return true;
    };
    for (const unit of [...units].sort((a, b) => b.table.bytes - a.table.bytes || a.owner.localeCompare(b.owner) || a.table.name.localeCompare(b.table.name))) {
      const key = `${unit.owner}.${unit.table.name}`;
      // "파티션마다 하나"면 묶지 않고, 같은 테이블의 다른 파티션 묶음과도 한 작업에 넣지 않는다.
      const bin = perPartition
        ? undefined
        : bins.find((candidate) => candidate.bytes + unit.table.bytes <= limit && !candidate.keys.has(key) && fitsWithoutStrays(candidate, unit));
      if (bin) {
        bin.bytes += unit.table.bytes;
        bin.units.push(unit);
        bin.owners.add(unit.owner);
        bin.names.add(unit.table.name);
        bin.keys.add(key);
      } else {
        bins.push({ bytes: unit.table.bytes, units: [unit], owners: new Set([unit.owner]), names: new Set([unit.table.name]), keys: new Set([key]) });
      }
    }
    for (const bin of bins) {
      drafts.push({
        owners: [...bin.owners].sort(),
        mode: 'TABLE',
        tables: bin.units.map((unit) => unit.table),
        excludedTables: [],
        partitions: bin.units.flatMap((unit) => unit.partitions),
        bytes: bin.bytes,
        oversize: bin.bytes > limit,
      });
    }
  }

  const stamp = timestamp(now);
  const digits = Math.max(2, String(drafts.length).length);
  const groups = drafts.map((draft, index): ExportGroup => {
    const no = index + 1;
    const nn = String(no).padStart(digits, '0');
    const partitions = draft.partitions ?? [];
    // 파티션 하나짜리 작업은 덤프 이름에 파티션 이름을 넣는다 (예: exp_20261006_P202401_%U.dmp). 테이블 목록은 여러 테이블에
    // 같은 파티션 이름이 있을 수 있어 테이블 이름도 넣는다 (exp_20261006_ORDERS_P202401_%U.dmp).
    const base =
      partitions.length !== 1 || draft.tables.length !== 1
        ? `${prefix}_${nn}`
        : source.kind === 'PARTITIONS'
          ? `${prefix}_${safeFilePart(partitions[0].name)}`
          : `${prefix}_${safeFilePart(draft.tables[0].name)}_${safeFilePart(partitions[0].name)}`;
    const filesize =
      options.filesizeMode === 'NONE'
        ? null
        : options.filesizeMode === 'CUSTOM'
          ? String(options.customFilesize).trim().toUpperCase()
          : suggestFilesize(draft.bytes, parallel);
    const request: DataPumpRequest = {
      operation: 'EXPORT',
      mode: draft.mode,
      ...(draft.mode === 'SCHEMA'
        ? { schemas: draft.owners, excludeTables: draft.excludedTables }
        : draft.owners.length === 1
          ? { tableOwner: draft.owners[0], tables: draft.tables.map((table) => table.name) }
          : { qualifiedTables: draft.tables.map((table) => ({ owner: table.owner, table: table.name })) }),
      ...(partitions.length > 0
        ? {
            tablePartitions: draft.tables
              .map((table) => ({
                owner: table.owner,
                table: table.name,
                partitions: partitions.filter((p) => p.owner === table.owner && p.table === table.name).map((p) => p.name),
              }))
              .filter((entry) => entry.partitions.length > 0),
          }
        : {}),
      directory,
      dumpfile: `${base}_%U.dmp`,
      logfile: `${base}.log`,
      jobName: `DBC_EXP_${stamp}_${nn}`,
      parallel,
      filesize,
      content: options.content ?? 'ALL',
      excludeStatistics: !!options.excludeStatistics,
      flashbackConsistent: !!options.flashbackConsistent,
      reuseDumpfiles: !!options.reuseDumpfiles,
      networkLink: options.networkLink ?? null,
    };
    buildPlan(request, now); // 그룹마다 실제로 실행 가능한 요청인지 미리 확인 (목록이 너무 길면 여기서 걸림)
    return { ...draft, partitions, no, filesize, expectedFiles: expectedFileCount(draft.bytes, parallel, filesize), request };
  });

  const dumpNames = groups.map((group) => group.request.dumpfile);
  if (new Set(dumpNames).size !== dumpNames.length) fail('덤프 파일 이름이 겹치는 파티션이 있습니다 (특수문자만 다른 이름). 분할 크기로 묶어 주세요.');
  return { groups, totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0), chunkBytes, missing };
}

// "OWNER.TABLE" (또는 OWNER TABLE / OWNER,TABLE) 한 줄에 하나씩 붙여 넣거나 올린 목록을 읽습니다.
// 파티션만 내보낼 때는 "OWNER.TABLE:PARTITION" (또는 OWNER TABLE PARTITION / OWNER,TABLE,PARTITION) — expdp TABLES= 형식과 같음.
function parseTableList(text: unknown): TableListItem[] {
  if (typeof text !== 'string') fail('테이블 목록이 비어 있습니다.');
  const items: TableListItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/["']/g, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('--')) continue;
    const parts = line.split(/[.\s,\t;:]+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 3) {
      fail(`"${raw.trim()}" — 소유자.테이블 또는 소유자.테이블:파티션 형식이어야 합니다 (예: HR.EMP, SALES.ORDERS:P202601).`);
    }
    items.push({
      owner: identifier(parts[0], '테이블 소유자'),
      name: identifier(parts[1], '테이블'),
      ...(parts[2] ? { partition: identifier(parts[2], '파티션') } : {}),
    });
  }
  if (items.length === 0) fail('테이블 목록이 비어 있습니다.');
  return items;
}

// ── DB를 거치는 기능 ──

async function getMeta(dbmsid: DbmsIdParam): Promise<{
  target: TargetInfo;
  edition: { banner: string; parallelSupported: boolean };
  directories: DirectoryInfo[];
  schemas: string[];
  dbLinks: DbLinkInfo[];
}> {
  try {
    const [target, edition, directories, schemas, dbLinks] = await Promise.all([
      dataPumpModel.getTargetInfo(dbmsid),
      dataPumpModel.getEdition(dbmsid),
      dataPumpModel.getDirectories(dbmsid),
      dataPumpModel.getSchemas(dbmsid),
      dataPumpModel.getDbLinks(dbmsid),
    ]);
    return { target, edition, directories, schemas, dbLinks };
  } catch (error) {
    throw new Error('Data Pump 기본 정보 조회 실패', { cause: error });
  }
}

// 넘어온 링크 이름이 이 DB에서 실제로 쓸 수 있는 링크인지 확인 (SQL에 이름을 그대로 붙이는 곳이 있어서 허용 목록으로 막는다).
async function ensureDbLink(dbmsid: DbmsIdParam, value: unknown): Promise<string | null> {
  const link = dbLink(value);
  if (!link) return null;
  let links: DbLinkInfo[];
  try {
    links = await dataPumpModel.getDbLinks(dbmsid);
  } catch (error) {
    throw new Error('DB 링크 목록 조회 실패', { cause: error });
  }
  if (!links.some((item) => item.name.toUpperCase() === link)) fail(`이 DB에서 쓸 수 있는 DB 링크가 아닙니다: ${link}`);
  return link;
}

// 링크 너머 DB의 스키마 목록 (링크로 export할 때 스키마 선택용).
async function getLinkSchemas(dbmsid: DbmsIdParam, value: unknown): Promise<string[]> {
  const link = await ensureDbLink(dbmsid, value);
  if (!link) fail('DB 링크를 골라주세요.');
  try {
    return await dataPumpModel.getSchemas(dbmsid, link);
  } catch (error) {
    throw new Error(`DB 링크 ${link} 너머 스키마 조회 실패 (링크 접속 계정에 DBA_USERS 조회 권한 필요)`, { cause: error });
  }
}

export interface ExportPlanResponse {
  totalBytes: number;
  chunkBytes: number | null;
  missing: string[];
  groups: (ExportGroup & { jobName: string; parfile: string; parfileName: string; command: string })[];
  // 파티션을 내보내는 테이블마다 하나: 덤프와 같은 DIRECTORY에 둘 매니페스트 ("파티션 Import" 화면이 읽어서 기간으로 고름)
  manifests: { name: string; text: string }[];
  // 크기를 대상 DB에서 읽은 시각 (10분간 재사용 — 화면에 표시)
  sizesReadAt: string;
}

const MAX_PARTITIONS_PER_PLAN = 1000;

// 파티션 범위/크기 (캐시 공유: 파티션 선택 화면에서 읽은 것을 계획 만들 때 다시 읽지 않는다).
async function cachedTablePartitions(
  dbmsid: DbmsIdParam,
  owner: string,
  table: string,
  refresh = false
): Promise<{ value: Awaited<ReturnType<typeof dataPumpModel.getTablePartitions>>; readAt: Date }> {
  try {
    return await cached(cacheKey(dbmsid.dbmsid, 'partitions', [`${owner}.${table}`]), () => dataPumpModel.getTablePartitions(dbmsid, owner, table), refresh);
  } catch (error) {
    throw new Error(`파티션 목록 조회 실패 (${owner}.${table})`, { cause: error });
  }
}

// 파티션 대상: 고른 파티션 이름 → DB에서 범위/크기를 읽어 채운다.
async function resolvePartitionSource(
  dbmsid: DbmsIdParam,
  input: unknown,
  refresh: boolean
): Promise<{ source: Extract<ExportSource, { kind: 'PARTITIONS' }>; table: dataPumpModel.PartitionTableInfo; readAt: Date }> {
  const value = (input ?? {}) as { owner?: unknown; table?: unknown; partitions?: unknown };
  const owner = identifier(value.owner, '테이블 소유자');
  const table = identifier(value.table, '테이블');
  const names = identifierList(value.partitions, '파티션');
  if (names.length > MAX_PARTITIONS_PER_PLAN) fail(`한 번에 ${MAX_PARTITIONS_PER_PLAN}개 파티션까지 만들 수 있습니다 (${names.length}개 선택). 기간을 나눠주세요.`);
  const { value: result, readAt } = await cachedTablePartitions(dbmsid, owner, table, refresh);
  if (!result.table) fail(`${owner}.${table}은(는) 파티션 키가 컬럼 하나인 RANGE 파티션 테이블이 아닙니다.`);
  const ranges = buildRanges(result.partitions);
  const missing = names.filter((name) => !ranges.some((range) => range.name === name));
  if (missing.length > 0) fail(`${owner}.${table}에 없는 파티션입니다: ${missing.slice(0, 10).join(', ')}`);
  const picked = new Set(names);
  return {
    source: { kind: 'PARTITIONS', owner, table, partitions: ranges.filter((range) => picked.has(range.name)) },
    table: result.table,
    readAt,
  };
}

// 테이블 목록: 목록에 나온 테이블만, 접속 한 번에 크기 + 같은 이름 테이블 존재 여부 + 파티션 정보를 읽는다 (캐시).
// RANGE 파티션 테이블이 아닌 테이블의 파티션 줄은 범위를 몰라 "없는 파티션"으로 알린다.
async function resolveTableList(
  dbmsid: DbmsIdParam,
  tables: TableListItem[],
  partitionTables: Map<string, dataPumpModel.PartitionTableInfo>,
  link: string | null,
  refresh: boolean
): Promise<{ source: Extract<ExportSource, { kind: 'TABLES' }>; sizes: TableSize[]; readAt: Date }> {
  const pairKeys = [...new Set(tables.map((item) => `${item.owner}.${item.name}`))].sort();
  const pairs = pairKeys.map((key) => {
    const [owner, table] = key.split('.');
    return { owner, table };
  });
  const whole = new Set(tables.filter((item) => !item.partition).map((item) => `${item.owner}.${item.name}`));
  const partitionKeys = [...new Set(tables.filter((item) => item.partition).map((item) => `${item.owner}.${item.name}`))].filter((key) => !whole.has(key)).sort();
  if (partitionKeys.length > 0 && link) fail('파티션 단위 export는 DB 링크 없이 이 DB에서만 지원합니다.');
  let sizing: { value: dataPumpModel.ListSizing; readAt: Date };
  try {
    sizing = await cached(
      cacheKey(dbmsid.dbmsid, 'list', [link, pairKeys.join(','), partitionKeys.join(',')]),
      () => dataPumpModel.getListSizing(dbmsid, pairs, partitionKeys, link),
      refresh
    );
  } catch (error) {
    throw new Error('테이블 크기 조회 실패', { cause: error });
  }
  const partitionRanges: Record<string, PartitionRange[]> = {};
  for (const [key, result] of Object.entries(sizing.value.partitions)) {
    if (!result.table) continue;
    partitionTables.set(key, result.table);
    partitionRanges[key] = buildRanges(result.partitions);
  }
  return {
    source: { kind: 'TABLES', tables, partitionRanges, existingTables: sizing.value.existing },
    sizes: sizing.value.sizes,
    readAt: sizing.readAt,
  };
}

// 스키마 선택 / 테이블 목록 / Range 파티션 → 테이블(파티션) 크기를 보고 분할 크기 이하의 export 작업들 + 각 작업의 parfile.
// 크기는 대상 DB 딕셔너리에서 읽고 10분간 재사용한다 (refreshSizes면 새로 읽음) — 옵션만 바꿔 다시 만들 때 대상 DB를 다시 조회하지 않게.
async function planExport(
  dbmsid: DbmsIdParam,
  input: { schemas?: unknown; tableList?: unknown; partitionSource?: unknown; refreshSizes?: unknown },
  options: ExportSplitOptions
): Promise<ExportPlanResponse> {
  const now = new Date();
  const refresh = input.refreshSizes === true;
  let source: ExportSource;
  let sizes: TableSize[] = [];
  let sizesReadAt: Date;
  // 파티션을 내보내는 테이블 (OWNER.TABLE → 정보) — 매니페스트용
  const partitionTables = new Map<string, dataPumpModel.PartitionTableInfo>();

  if (input.partitionSource) {
    if (options.networkLink) fail('Range 파티션 export는 DB 링크 없이 이 DB에서만 지원합니다.');
    const resolved = await resolvePartitionSource(dbmsid, input.partitionSource, refresh);
    source = resolved.source;
    sizesReadAt = resolved.readAt;
    partitionTables.set(`${resolved.table.owner}.${resolved.table.name}`, resolved.table);
  } else {
    const link = await ensureDbLink(dbmsid, options.networkLink);
    options = { ...options, networkLink: link };
    if (typeof input.tableList === 'string' && input.tableList.trim() !== '') {
      const resolved = await resolveTableList(dbmsid, parseTableList(input.tableList), partitionTables, link, refresh);
      source = resolved.source;
      sizes = resolved.sizes;
      sizesReadAt = resolved.readAt;
    } else {
      const schemas = identifierList(input.schemas, '스키마');
      source = { kind: 'SCHEMAS', schemas };
      try {
        const result = await cached(
          cacheKey(dbmsid.dbmsid, 'schemas', [link, [...schemas].sort().join(',')]),
          () => dataPumpModel.getTableSizes(dbmsid, schemas, link),
          refresh
        );
        sizes = result.value;
        sizesReadAt = result.readAt;
      } catch (error) {
        throw new Error('테이블 크기 조회 실패', { cause: error });
      }
    }
  }
  const target = await dataPumpModel.getTargetInfo(dbmsid); // 메타데이터 DB (대상 DB 아님)

  const { groups, totalBytes, chunkBytes, missing } = planExportGroups(source, sizes, options, now);

  // 파티션을 내보내는 테이블마다 매니페스트 하나. Range 파티션 대상은 테이블이 하나라 <접두어>_manifest.json,
  // 테이블 목록은 여러 테이블일 수 있어 <접두어>_<테이블>_manifest.json. 한 덤프에 여러 테이블이 들어 있어도
  // Import는 테이블을 지정해 가져오므로 그 테이블만 들어간다.
  const manifests: ExportPlanResponse['manifests'] = [];
  const prefix = String(options.filePrefix).trim();
  for (const info of partitionTables.values()) {
    const entries: PartitionManifestEntry[] = groups.flatMap((group) =>
      group.partitions
        .filter((partition) => partition.owner === info.owner && partition.table === info.name)
        .map(({ owner: _owner, table: _table, ...partition }) => ({ ...partition, dumpfile: group.request.dumpfile }))
    );
    if (entries.length === 0) continue;
    // 테이블 목록은 여러 스키마에 같은 이름 테이블이 있을 수 있어, 스키마가 둘 이상이면 이름에 스키마도 넣는다.
    const multiOwner = new Set([...partitionTables.values()].map((table) => table.owner)).size > 1;
    const name =
      source.kind === 'PARTITIONS'
        ? `${prefix}_manifest.json`
        : `${prefix}_${multiOwner ? `${safeFilePart(info.owner)}_` : ''}${safeFilePart(info.name)}_manifest.json`;
    manifests.push({ name, text: manifestText(buildManifest(info, target.dbname, groups[0].request.directory, entries, now)) });
  }

  // parfile 첫 줄 설명: 작업에 든 테이블/파티션 요약 (스키마가 여럿이면 테이블마다 OWNER.TABLE)
  const describe = (group: ExportGroup): string => {
    if (group.mode === 'SCHEMA') {
      return `스키마 ${group.owners.join(', ')} (테이블 ${group.tables.length}개${group.excludedTables.length ? `, 큰 테이블 ${group.excludedTables.length}개는 다른 작업으로 분리` : ''})`;
    }
    if (group.partitions.length === 0) return `${group.owners.join(', ')} 테이블 ${group.tables.length}개`;
    const qualified = group.owners.length > 1;
    const perTable = group.tables.map((table) => {
      const label = qualified ? `${table.owner}.${table.name}` : table.name;
      const parts = group.partitions.filter((partition) => partition.owner === table.owner && partition.table === table.name);
      if (parts.length === 0) return `${label}(통째)`;
      const range = rangeLabel({ ...parts[0], high: parts[parts.length - 1].high, known: parts.every((p) => p.known) });
      return `${label} 파티션 ${parts.length}개(${parts.length === 1 ? parts[0].name : `${parts[0].name} … ${parts[parts.length - 1].name}`}, ${range})`;
    });
    return qualified ? perTable.join(', ') : `${group.owners[0]}.${perTable.join(', ')}`;
  };

  return {
    totalBytes,
    chunkBytes,
    missing,
    manifests,
    sizesReadAt: sizesReadAt.toISOString(),
    groups: groups.map((group) => {
      const plan = buildPlan(group.request, now);
      const comment = `작업 ${group.no}/${groups.length}: ${describe(group)}, 예상 약 ${(group.bytes / UNIT.G).toFixed(1)} GB`;
      return { ...group, jobName: plan.jobName, ...buildParfile(plan, group.request, target, comment) };
    }),
  };
}

// link가 있으면 링크 너머(데이터를 읽는) DB의 SCN.
async function getCurrentScn(dbmsid: DbmsIdParam, networkLink: unknown = null): Promise<string> {
  const link = await ensureDbLink(dbmsid, networkLink);
  try {
    return await dataPumpModel.getCurrentScn(dbmsid, link);
  } catch (error) {
    throw new Error('현재 SCN 조회 실패', { cause: error });
  }
}

async function preview(dbmsid: DbmsIdParam, request: DataPumpRequest): Promise<{ jobName: string; parfile: string; command: string; parfileName: string }> {
  const plan = buildPlan(request);
  const target = await dataPumpModel.getTargetInfo(dbmsid);
  return { jobName: plan.jobName, ...buildParfile(plan, request, target) };
}

// 작업 시작. 기존 데이터를 건드리는 Import는 화면에서 대상 DB명을 직접 입력해 보낸 값과 실제 DB명이 맞아야 실행합니다.
// 시작에 성공하면 작업 이력에 RUNNING으로 남깁니다 (startedBy = 로그인 사용자, estimatedBytes = 계획 시 예상 크기).
async function start(
  dbmsid: DbmsIdParam,
  request: DataPumpRequest,
  confirmDbname: unknown,
  startedBy: string | null = null,
  estimatedBytes: unknown = null
): Promise<{ jobName: string; plan: DataPumpPlan }> {
  const plan = buildPlan(request);
  await ensureDbLink(dbmsid, plan.networkLink);
  const target = await dataPumpModel.getTargetInfo(dbmsid);
  if (isDestructive(plan)) {
    const typed = typeof confirmDbname === 'string' ? confirmDbname.trim() : '';
    if (typed.toUpperCase() !== String(target.dbname).trim().toUpperCase()) {
      const what =
        plan.truncatePartitions.length > 0 ? `파티션 비우기(${plan.truncatePartitions.join(', ')})` : `TABLE_EXISTS_ACTION=${plan.tableExistsAction}`;
      fail(`${what}는 기존 데이터를 바꿉니다. 확인을 위해 대상 DB명(${target.dbname})을 정확히 입력해주세요.`);
    }
  }
  if (plan.truncateTarget && plan.truncatePartitions.length > 0) {
    await truncateBeforeImport(dbmsid, plan.truncateTarget, plan.truncatePartitions);
  }
  try {
    await dataPumpModel.startJob(dbmsid, plan);
  } catch (error) {
    const truncated = plan.truncatePartitions.length > 0 ? ` (파티션 ${plan.truncatePartitions.join(', ')}은(는) 이미 비웠습니다)` : '';
    throw new Error(`Data Pump 작업 시작 실패${truncated}`, { cause: error });
  }
  const estimate = Number(estimatedBytes);
  await historyService.recordStart(dbmsid.dbmsid, target, plan, startedBy, Number.isFinite(estimate) && estimate > 0 ? estimate : null);
  return { jobName: plan.jobName, plan };
}

// 비울 파티션이 대상 테이블에 실제로 있는지 다시 확인하고 비운다 (화면 계획 이후 파티션이 바뀌었을 수도 있음).
async function truncateBeforeImport(dbmsid: DbmsIdParam, target: { owner: string; name: string }, partitions: string[]): Promise<void> {
  let existing: string[];
  try {
    existing = (await dataPumpModel.getTablePartitions(dbmsid, target.owner, target.name)).partitions.map((row) => row.name);
  } catch (error) {
    throw new Error('대상 테이블 파티션 조회 실패', { cause: error });
  }
  const missing = partitions.filter((partition) => !existing.includes(partition));
  if (missing.length > 0) fail(`${target.owner}.${target.name}에 없는 파티션이라 비울 수 없습니다: ${missing.join(', ')}`);
  try {
    await dataPumpModel.truncatePartitions(dbmsid, target.owner, target.name, partitions);
  } catch (error) {
    throw new Error(`파티션 비우기 실패 (${target.owner}.${target.name})`, { cause: error });
  }
}

async function getJobs(dbmsid: DbmsIdParam): Promise<DataPumpJob[]> {
  try {
    return await dataPumpModel.getJobs(dbmsid);
  } catch (error) {
    throw new Error('Data Pump 작업 목록 조회 실패', { cause: error });
  }
}

async function cancel(dbmsid: DbmsIdParam, owner: string, jobName: string): Promise<void> {
  const ownerName = identifier(owner, '작업 소유자');
  const name = identifier(jobName, '작업');
  try {
    await dataPumpModel.cancelJob(dbmsid, ownerName, name);
  } catch (error) {
    throw new Error('Data Pump 작업 취소 실패', { cause: error });
  }
  await historyService.recordCancel(dbmsid.dbmsid, ownerName, name);
}

// DB 서버 DIRECTORY에 저장할 수 있는 파일: parfile(.par)과 실행 스크립트(.sh)만, 경로 없이 이름만.
// 파티션 export 매니페스트(.json)도 덤프와 같은 곳에 둔다 (import 화면이 이걸 읽음).
const SAVABLE_FILE = /^[A-Za-z0-9_.-]{1,200}\.(par|sh|json)$/;
const MAX_SAVE_FILES = 1100;
const MAX_FILE_LENGTH = 4 * 1024 * 1024; // 파티션 수천 개짜리 매니페스트도 들어가게

function validateFiles(files: unknown): { name: string; content: string }[] {
  if (!Array.isArray(files) || files.length === 0) fail('저장할 파일이 없습니다.');
  if (files.length > MAX_SAVE_FILES) fail(`한 번에 ${MAX_SAVE_FILES}개까지 저장할 수 있습니다.`);
  const names = new Set<string>();
  return files.map((file) => {
    const name = typeof file?.name === 'string' ? file.name.trim() : '';
    const content = typeof file?.content === 'string' ? file.content : '';
    if (!SAVABLE_FILE.test(name) || name.startsWith('.')) fail(`파일 이름이 올바르지 않습니다 (.par/.sh/.json, 경로 없이): ${name}`);
    if (names.has(name)) fail(`같은 파일 이름이 두 번 있습니다: ${name}`);
    if (content.length === 0 || content.length > MAX_FILE_LENGTH) fail(`파일 내용이 비었거나 너무 큽니다: ${name}`);
    names.add(name);
    return { name, content };
  });
}

// parfile/실행 스크립트를 DB 서버 DIRECTORY에 저장. overwrite가 아니면 이미 있는 파일은 건너뛰고 skipped로 알려줍니다.
async function saveFiles(dbmsid: DbmsIdParam, directory: unknown, files: unknown, overwrite: boolean): Promise<{ written: string[]; skipped: string[] }> {
  const dir = identifier(directory, 'DIRECTORY');
  const valid = validateFiles(files);
  try {
    return await dataPumpModel.writeFiles(dbmsid, dir, valid, overwrite);
  } catch (error) {
    throw new Error('DIRECTORY에 파일 저장 실패', { cause: error });
  }
}

async function readLog(dbmsid: DbmsIdParam, directory: string, logfile: string): Promise<LogContent> {
  const dir = identifier(directory, 'DIRECTORY');
  const file = filename(logfile, '로그 파일');
  try {
    return await dataPumpModel.readLog(dbmsid, dir, file);
  } catch (error) {
    throw new Error('로그 파일 읽기 실패', { cause: error });
  }
}

export {
  identifier,
  filename,
  fail,
  timestamp,
  buildPlan,
  buildParfile,
  isDestructive,
  parseSize,
  suggestFilesize,
  expectedFileCount,
  planExportGroups,
  parseTableList,
  getMeta,
  cachedTablePartitions,
  getLinkSchemas,
  planExport,
  getCurrentScn,
  preview,
  start,
  getJobs,
  cancel,
  saveFiles,
  readLog,
};
