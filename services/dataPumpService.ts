import * as dataPumpModel from '../models/dataPumpModel';
import type { DataPumpJob, DataPumpPlan, DirectoryInfo, LogContent, TableSize, TargetInfo } from '../models/dataPumpModel';
import type { DbmsIdParam } from '../models/dbmsModel';
import * as historyService from './dataPumpHistoryService';

// 화면이 보내는 Data Pump 작업 요청 하나. 검증을 통과하면 DataPumpPlan(model이 바인드 변수로 실행하는 형태)이 됩니다.
export interface DataPumpRequest {
  operation: 'EXPORT' | 'IMPORT';
  mode: 'SCHEMA' | 'TABLE' | 'FULL'; // FULL은 IMPORT만 (덤프에 든 것 전부)
  schemas?: string[]; // SCHEMA 모드
  tableOwner?: string | null; // TABLE 모드
  tables?: string[]; // TABLE 모드
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
  flashbackConsistent?: boolean; // EXPORT — 작업 시작 시점 SCN으로 일관성 있게
  flashbackScn?: string | null; // EXPORT — 여러 작업을 같은 시점으로 맞출 때 쓰는 지정 SCN
  tableExistsAction?: 'SKIP' | 'APPEND' | 'TRUNCATE' | 'REPLACE'; // IMPORT
  remapSchemas?: { from: string; to: string }[]; // IMPORT
  remapTablespaces?: { from: string; to: string }[]; // IMPORT
}

export class DataPumpValidationError extends Error {}

// 따옴표 없는 일반 Oracle 식별자만 받습니다 (대문자로 바꿔서 비교). PL/SQL에는 바인드 변수로 넘기지만,
// 필터식(IN ('A','B'))을 문자열로 조립하므로 따옴표 같은 문자가 끼어들 여지를 아예 막아 둡니다.
const IDENTIFIER = /^[A-Z][A-Z0-9_$#]{0,127}$/;
// 덤프/로그 파일 이름: 영문/숫자/_ . - 와 %U(파일 번호 치환자)만. 경로 구분자는 허용하지 않습니다 (DIRECTORY 안에만 생성).
const FILENAME = /^[A-Za-z0-9_.%-]{1,200}$/;
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

  let schemaExpr: string | null = null;
  let nameExpr: string | null = null;
  let excludeTableExpr: string | null = null;
  if (mode === 'SCHEMA') {
    const schemas = identifierList(request.schemas, '스키마');
    schemaExpr = filterExpr('IN', schemas, '스키마');
    const excluded = identifierList(request.excludeTables ?? [], '제외 테이블', true);
    if (excluded.length > 0) {
      if (schemas.length !== 1) fail('제외 테이블은 스키마를 하나만 고른 작업에서만 지정할 수 있습니다.');
      excludeTableExpr = filterExpr('NOT IN', excluded, '제외 테이블');
    }
  } else if (mode === 'TABLE') {
    schemaExpr = filterExpr('IN', [identifier(request.tableOwner, '테이블 소유자')], '스키마');
    nameExpr = filterExpr('IN', identifierList(request.tables, '테이블'), '테이블');
  }

  const parallel = request.parallel === undefined ? 1 : Number(request.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) fail(`PARALLEL은 1~${MAX_PARALLEL} 사이 정수여야 합니다.`);

  let filesize: string | null = null;
  if (request.filesize !== undefined && request.filesize !== null && String(request.filesize).trim() !== '') {
    filesize = String(request.filesize).trim().toUpperCase();
    if (!FILESIZE.test(filesize)) fail('FILESIZE 형식이 올바르지 않습니다 (예: 2G, 512M).');
    if (!isExport) fail('FILESIZE는 Export에서만 지정합니다.');
  }

  const dumpfile = filename(request.dumpfile, '덤프 파일');
  const logfile = filename(request.logfile, '로그 파일');
  if (/%U/i.test(logfile)) fail('로그 파일 이름에는 %U를 쓸 수 없습니다.');
  // 여러 파일로 나눠 쓰려면(PARALLEL로 동시에 쓰거나 FILESIZE로 쪼갤 때) 파일 번호가 들어갈 자리가 있어야 합니다.
  if (isExport && (parallel > 1 || filesize) && !/%U/i.test(dumpfile)) {
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
    flashbackConsistent: isExport && (!!request.flashbackConsistent || flashbackScn !== null),
    flashbackScn,
    tableExistsAction,
    remapSchemas: isExport ? [] : remapList(request.remapSchemas, 'REMAP_SCHEMA'),
    remapTablespaces: isExport ? [] : remapList(request.remapTablespaces, 'REMAP_TABLESPACE'),
  };
}

function isDestructive(plan: DataPumpPlan): boolean {
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
  lines.push(`DIRECTORY=${plan.directory}`, `DUMPFILE=${plan.dumpfile}`, `LOGFILE=${plan.logfile}`);
  if (plan.jobMode === 'SCHEMA') {
    lines.push(`SCHEMAS=${identifierList(request.schemas, '스키마').join(',')}`);
    const excluded = identifierList(request.excludeTables ?? [], '제외 테이블', true);
    if (excluded.length > 0) lines.push(`EXCLUDE=TABLE:"IN (${excluded.map((name) => `'${name}'`).join(',')})"`);
  } else if (plan.jobMode === 'TABLE') {
    const owner = identifier(request.tableOwner, '테이블 소유자');
    lines.push(`TABLES=${identifierList(request.tables, '테이블').map((table) => `${owner}.${table}`).join(',')}`);
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
  chunkSize: string; // 작업 하나의 목표 최대 크기, 예: 1T (NONE이면 나누지 않음)
  parallel: number;
  filesizeMode: 'AUTO' | 'NONE' | 'CUSTOM'; // AUTO = 그룹 크기 ÷ PARALLEL
  customFilesize?: string | null;
  content?: DataPumpRequest['content'];
  excludeStatistics?: boolean;
  flashbackConsistent?: boolean;
  reuseDumpfiles?: boolean;
}

export type ExportSource = { kind: 'SCHEMAS'; schemas: string[] } | { kind: 'TABLES'; tables: { owner: string; name: string }[] };

export interface ExportGroup {
  no: number;
  owners: string[]; // SCHEMA 작업은 여러 스키마를 묶을 수 있음, TABLE 작업은 소유자 하나
  mode: 'SCHEMA' | 'TABLE';
  tables: TableSize[]; // 이 작업에 들어가는 테이블 (SCHEMA 모드면 스키마의 나머지 테이블)
  excludedTables: string[]; // SCHEMA 모드에서 다른 작업으로 떼어 낸 테이블
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
  const chunkBytes = chunkText === 'NONE' ? null : parseSize(chunkText, '분할 크기');
  const limit = chunkBytes ?? Number.POSITIVE_INFINITY;
  const parallel = Number(options.parallel ?? 1);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) fail(`PARALLEL은 1~${MAX_PARALLEL} 사이 정수여야 합니다.`);
  if (options.filesizeMode === 'CUSTOM' && !FILESIZE.test(String(options.customFilesize ?? '').trim().toUpperCase())) {
    fail('FILESIZE 형식이 올바르지 않습니다 (예: 2G, 512M).');
  }

  type Draft = Omit<ExportGroup, 'no' | 'filesize' | 'expectedFiles' | 'request'>;
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
  } else {
    // 올린 목록을 DB의 실제 테이블과 맞춰 보고, 없는 건 따로 알려줍니다. 소유자가 다르면 작업을 따로 만듭니다.
    const byKey = new Map(sizes.map((table) => [`${table.owner}.${table.name}`, table]));
    const byOwner = new Map<string, TableSize[]>();
    const seen = new Set<string>();
    for (const item of source.tables) {
      const key = `${identifier(item.owner, '테이블 소유자')}.${identifier(item.name, '테이블')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const table = byKey.get(key);
      if (!table) {
        missing.push(key);
        continue;
      }
      byOwner.set(table.owner, [...(byOwner.get(table.owner) ?? []), table]);
    }
    for (const [owner, tables] of byOwner) {
      for (const bin of packTables(tables, limit)) {
        const bytes = bin.reduce((sum, table) => sum + table.bytes, 0);
        drafts.push({ owners: [owner], mode: 'TABLE', tables: bin, excludedTables: [], bytes, oversize: bytes > limit });
      }
    }
  }

  const stamp = timestamp(now);
  const digits = Math.max(2, String(drafts.length).length);
  const groups = drafts.map((draft, index): ExportGroup => {
    const no = index + 1;
    const nn = String(no).padStart(digits, '0');
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
        : { tableOwner: draft.owners[0], tables: draft.tables.map((table) => table.name) }),
      directory,
      dumpfile: `${prefix}_${nn}_%U.dmp`,
      logfile: `${prefix}_${nn}.log`,
      jobName: `DBC_EXP_${stamp}_${nn}`,
      parallel,
      filesize,
      content: options.content ?? 'ALL',
      excludeStatistics: !!options.excludeStatistics,
      flashbackConsistent: !!options.flashbackConsistent,
      reuseDumpfiles: !!options.reuseDumpfiles,
    };
    buildPlan(request, now); // 그룹마다 실제로 실행 가능한 요청인지 미리 확인 (목록이 너무 길면 여기서 걸림)
    return { ...draft, no, filesize, expectedFiles: expectedFileCount(draft.bytes, parallel, filesize), request };
  });

  return { groups, totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0), chunkBytes, missing };
}

// "OWNER.TABLE" (또는 OWNER TABLE / OWNER,TABLE) 한 줄에 하나씩 붙여 넣거나 올린 목록을 읽습니다.
function parseTableList(text: unknown): { owner: string; name: string }[] {
  if (typeof text !== 'string') fail('테이블 목록이 비어 있습니다.');
  const items: { owner: string; name: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/["']/g, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('--')) continue;
    const parts = line.split(/[.\s,\t;]+/).filter(Boolean);
    if (parts.length < 2) fail(`"${raw.trim()}" — 소유자.테이블 형식이어야 합니다 (예: HR.EMP).`);
    items.push({ owner: identifier(parts[0], '테이블 소유자'), name: identifier(parts[1], '테이블') });
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
}> {
  try {
    const [target, edition, directories, schemas] = await Promise.all([
      dataPumpModel.getTargetInfo(dbmsid),
      dataPumpModel.getEdition(dbmsid),
      dataPumpModel.getDirectories(dbmsid),
      dataPumpModel.getSchemas(dbmsid),
    ]);
    return { target, edition, directories, schemas };
  } catch (error) {
    throw new Error('Data Pump 기본 정보 조회 실패', { cause: error });
  }
}

export interface ExportPlanResponse {
  totalBytes: number;
  chunkBytes: number | null;
  missing: string[];
  groups: (ExportGroup & { jobName: string; parfile: string; parfileName: string; command: string })[];
}

// 스키마 선택 또는 테이블 목록 → 테이블 크기를 보고 분할 크기 이하의 export 작업들 + 각 작업의 parfile.
async function planExport(
  dbmsid: DbmsIdParam,
  input: { schemas?: unknown; tableList?: unknown },
  options: ExportSplitOptions
): Promise<ExportPlanResponse> {
  const source: ExportSource =
    typeof input.tableList === 'string' && input.tableList.trim() !== ''
      ? { kind: 'TABLES', tables: parseTableList(input.tableList) }
      : { kind: 'SCHEMAS', schemas: identifierList(input.schemas, '스키마') };
  const owners =
    source.kind === 'SCHEMAS' ? source.schemas.map((schema) => schema.toUpperCase()) : Array.from(new Set(source.tables.map((t) => t.owner)));

  let sizes: TableSize[];
  let target: TargetInfo;
  try {
    [sizes, target] = await Promise.all([dataPumpModel.getTableSizes(dbmsid, owners), dataPumpModel.getTargetInfo(dbmsid)]);
  } catch (error) {
    throw new Error('테이블 크기 조회 실패', { cause: error });
  }

  const now = new Date();
  const { groups, totalBytes, chunkBytes, missing } = planExportGroups(source, sizes, options, now);
  return {
    totalBytes,
    chunkBytes,
    missing,
    groups: groups.map((group) => {
      const plan = buildPlan(group.request, now);
      const what =
        group.mode === 'SCHEMA'
          ? `스키마 ${group.owners.join(', ')} (테이블 ${group.tables.length}개${group.excludedTables.length ? `, 큰 테이블 ${group.excludedTables.length}개는 다른 작업으로 분리` : ''})`
          : `${group.owners[0]} 테이블 ${group.tables.length}개`;
      const comment = `작업 ${group.no}/${groups.length}: ${what}, 예상 약 ${(group.bytes / UNIT.G).toFixed(1)} GB`;
      return { ...group, jobName: plan.jobName, ...buildParfile(plan, group.request, target, comment) };
    }),
  };
}

async function getCurrentScn(dbmsid: DbmsIdParam): Promise<string> {
  try {
    return await dataPumpModel.getCurrentScn(dbmsid);
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
  const target = await dataPumpModel.getTargetInfo(dbmsid);
  if (isDestructive(plan)) {
    const typed = typeof confirmDbname === 'string' ? confirmDbname.trim() : '';
    if (typed.toUpperCase() !== String(target.dbname).trim().toUpperCase()) {
      fail(`TABLE_EXISTS_ACTION=${plan.tableExistsAction}는 기존 데이터를 바꿉니다. 확인을 위해 대상 DB명(${target.dbname})을 정확히 입력해주세요.`);
    }
  }
  try {
    await dataPumpModel.startJob(dbmsid, plan);
  } catch (error) {
    throw new Error('Data Pump 작업 시작 실패', { cause: error });
  }
  const estimate = Number(estimatedBytes);
  await historyService.recordStart(dbmsid.dbmsid, target, plan, startedBy, Number.isFinite(estimate) && estimate > 0 ? estimate : null);
  return { jobName: plan.jobName, plan };
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
const SAVABLE_FILE = /^[A-Za-z0-9_.-]{1,200}\.(par|sh)$/;
const MAX_SAVE_FILES = 500;
const MAX_FILE_LENGTH = 1024 * 1024;

function validateFiles(files: unknown): { name: string; content: string }[] {
  if (!Array.isArray(files) || files.length === 0) fail('저장할 파일이 없습니다.');
  if (files.length > MAX_SAVE_FILES) fail(`한 번에 ${MAX_SAVE_FILES}개까지 저장할 수 있습니다.`);
  const names = new Set<string>();
  return files.map((file) => {
    const name = typeof file?.name === 'string' ? file.name.trim() : '';
    const content = typeof file?.content === 'string' ? file.content : '';
    if (!SAVABLE_FILE.test(name) || name.startsWith('.')) fail(`파일 이름이 올바르지 않습니다 (.par/.sh, 경로 없이): ${name}`);
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
  buildPlan,
  buildParfile,
  isDestructive,
  parseSize,
  suggestFilesize,
  expectedFileCount,
  planExportGroups,
  parseTableList,
  getMeta,
  planExport,
  getCurrentScn,
  preview,
  start,
  getJobs,
  cancel,
  saveFiles,
  readLog,
};
