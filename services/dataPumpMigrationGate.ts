import * as dataPumpModel from '../models/dataPumpModel';
import type { DataPumpPlan } from '../models/dataPumpModel';
import * as migrationModel from '../models/dataPumpMigrationModel';
import type { MigrationJobRecord } from '../models/dataPumpMigrationModel';
import type { DbmsIdParam } from '../models/dbmsModel';
import { fail } from './dataPumpErrors';
import { assertImportExecution, checkDumpFiles } from './dataPumpMigration';
import type { DataPumpRequest } from './dataPumpService';

// 이관 Import(datapump_migration_job에 있는 작업)는 생성 때의 기준으로만 실행·저장한다 — 서버에서 막는다 (화면만 막으면 우회 가능).
//  - 실행: 요청이 생성한 것과 같고, 사전 점검(대상 DB)이 차단 없이 최근에 통과했고, 덤프 파일이 다 있고 크기가 같고,
//          실행 필터(SCHEMA_EXPR/NAME_EXPR/REMAP)가 기준과 같아야 한다 (불변식 5).
//  - parfile 저장: 생성한 parfile 원문과 같아야 한다.

const PRECHECK_TTL_MS = 60 * 60 * 1000;
const prechecks = new Map<string, { at: number; blocked: boolean }>();

function recordPrecheck(planId: string, blocked: boolean): void {
  for (const [id, entry] of prechecks) if (Date.now() - entry.at > PRECHECK_TTL_MS) prechecks.delete(id);
  prechecks.set(planId, { at: Date.now(), blocked });
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item as object)
              .sort()
              .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
              .map((key) => [key, sort((item as Record<string, unknown>)[key])])
          )
        : item;
  return JSON.stringify(sort(value));
}

// 이관 Import 작업이면 그 기록, 아니면 null. 이관 테이블이 없는 환경은 이관 작업이 있을 수 없으므로 null.
async function findJob(jobName: string): Promise<MigrationJobRecord | null> {
  try {
    return await migrationModel.findMigrationJob(jobName);
  } catch (error) {
    if (migrationModel.isMissingTable(error)) return null;
    throw new Error('이관 Import 기록 조회 실패', { cause: error });
  }
}

async function checkMigrationStart(dbmsid: DbmsIdParam, request: DataPumpRequest, plan: DataPumpPlan, runs: DataPumpPlan[]): Promise<void> {
  const job = await findJob(plan.jobName);
  if (!job) return;
  if (String(job.targetDbmsId) !== String(dbmsid.dbmsid)) fail(`이 Import(${plan.jobName})는 다른 대상 DB용으로 만든 작업입니다.`);
  if (stableJson(request) !== stableJson(job.request)) fail(`요청이 생성한 Import(${plan.jobName})와 다릅니다. "Import 만들기"로 다시 만들어 주세요.`);
  // 같은 테이블의 다른 파티션 덤프를 먼저 넣은 작업이 끝나야 한다 (그 작업이 테이블을 만든다)
  const waitFor = job.expected.waitFor ?? [];
  if (waitFor.length > 0) {
    const results = await migrationModel.getImportResults(job.targetDbmsId, waitFor);
    const pending = waitFor.filter((name) => !results.some((row) => (row.jobName === name || row.jobName.startsWith(`${name}_S`)) && ['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(row.status)));
    if (pending.length > 0) fail(`같은 테이블의 다른 파티션 덤프를 넣는 작업이 먼저 끝나야 합니다: ${pending.join(', ')}`, pending);
  }
  const precheck = prechecks.get(job.planId);
  if (!precheck || Date.now() - precheck.at > PRECHECK_TTL_MS) fail('Import 전 사전 점검(대상 DB)을 먼저 실행해 주세요 (1시간 안에 한 결과만 인정).');
  if (precheck.blocked) fail('사전 점검에 "차단" 항목이 있어 실행할 수 없습니다. 고친 뒤 사전 점검을 다시 실행해 주세요.');
  let sizes: Record<string, number>;
  try {
    sizes = await dataPumpModel.getFileSizes(dbmsid, plan.directory, job.dumpFiles.map((file) => file.name));
  } catch (error) {
    throw new Error('덤프 파일 확인 실패', { cause: error });
  }
  const files = checkDumpFiles([{ jobName: plan.jobName, files: job.dumpFiles }], sizes);
  if (files.blocked) {
    fail(
      `덤프 파일이 없거나 크기가 달라 실행할 수 없습니다 (${plan.directory}).`,
      files.rows.filter((row) => row.status !== 'OK' && row.status !== 'NO_SIZE').map((row) => `${row.name}: ${row.status === 'MISSING' ? '없음' : `크기 다름 (기대 ${row.expected} / 실제 ${row.actual})`}`)
    );
  }
  assertImportExecution(plan, runs, { mode: job.expected.mode, schemas: job.expected.schemas, tables: job.expected.tables, remap: job.expected.remap });
}

const JOB_LINE = /^JOB_NAME=(DBC_IMP_\S+)$/m;

async function checkMigrationFiles(dbmsid: DbmsIdParam, files: { name: string; content: string }[]): Promise<void> {
  for (const file of files.filter((item) => /\.par$/i.test(item.name))) {
    const name = file.content.match(JOB_LINE)?.[1];
    if (!name) continue;
    const job = await findJob(name);
    if (!job) continue;
    if (String(job.targetDbmsId) !== String(dbmsid.dbmsid)) fail(`${file.name}: 다른 대상 DB용으로 만든 이관 Import parfile입니다.`);
    if (file.content.trim() !== job.parfile.trim()) fail(`${file.name}: 생성한 이관 Import parfile과 내용이 다릅니다. 고친 parfile은 저장하지 않습니다 (다시 생성해 주세요).`);
  }
}

export { checkMigrationStart, checkMigrationFiles, recordPrecheck, stableJson };
