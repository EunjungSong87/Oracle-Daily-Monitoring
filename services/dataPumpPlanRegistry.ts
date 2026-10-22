import { randomUUID } from 'crypto';
import { fail } from './dataPumpErrors';
import type { DataPumpRequest } from './dataPumpService';
import type { BundleJobRecord, PartitionRecord } from '../models/dataPumpMigrationModel';

// Export 분할 계획 기억소 (앱 서버 메모리, 단일 프로세스 앱). /exportPlan에서 등록하고 /start, /saveFiles에서 대조한다.
// 목적: "DB에 없어 빠지는 항목"과 "필터로 빠지는 테이블"을 사용자가 확인하지 않으면 서버도 실행·저장을 막는다
// (화면만 막으면 요청을 직접 보내 우회할 수 있으므로). 계획에 없는 요청/바뀐 요청도 막는다.

export interface PlanAck {
  missing: string[];
  filteredOut: string[];
}

interface PlanJob {
  request: DataPumpRequest;
  expected: string[]; // 실행 후 로그 대조용 대상 목록 (OWNER.TABLE 또는 OWNER.TABLE:PART, 정확한 이름)
}

// Export 묶음으로 메타 DB에 남길 내용 (실행하거나 parfile을 저장할 때 한 번 — Import 생성/파티션 Import의 기준)
export interface BundleDraft {
  missing: string[];
  filteredOut: string[];
  jobs: BundleJobRecord[];
  partitions: PartitionRecord[];
}

interface Entry {
  dbmsid: string;
  createdAt: number;
  missing: string[];
  filteredOut: string[];
  jobs: Map<string, { hash: string; fixedScn: string | null; expected: string[] }>;
  summaryFile: { name: string; text: string } | null;
  bundle: BundleDraft | null;
}

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PLANS = 300;
const plans = new Map<string, Entry>();

// FLASHBACK_SCN은 "전체 실행" 때 화면이 정해 붙이므로 계획에 고정 SCN이 없을 때만 비교에서 뺀다.
function requestHash(request: DataPumpRequest, ignoreScn: boolean): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as object)
              .sort()
              .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
              .map((key) => [key, sort((value as Record<string, unknown>)[key])])
          )
        : value;
  const { flashbackScn, ...rest } = request;
  return JSON.stringify(sort(ignoreScn ? rest : { ...rest, flashbackScn: flashbackScn ?? null }));
}

function registerPlan(input: {
  dbmsid: string | number;
  missing: string[];
  filteredOut: string[];
  jobs: PlanJob[];
  summaryFile: { name: string; text: string } | null;
  bundle?: BundleDraft | null;
}): string {
  const now = Date.now();
  for (const [id, entry] of plans) if (now - entry.createdAt > TTL_MS) plans.delete(id);
  while (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value as string);
  const id = randomUUID();
  plans.set(id, {
    dbmsid: String(input.dbmsid),
    createdAt: now,
    missing: [...input.missing],
    filteredOut: [...input.filteredOut],
    jobs: new Map(
      input.jobs.map((job) => {
        const fixedScn = job.request.flashbackScn ?? null;
        return [String(job.request.jobName), { hash: requestHash(job.request, fixedScn === null), fixedScn, expected: job.expected }];
      })
    ),
    summaryFile: input.summaryFile,
    bundle: input.bundle ?? null,
  });
  return id;
}

function sameSet(a: string[], b: unknown): boolean {
  if (!Array.isArray(b) || b.some((item) => typeof item !== 'string')) return false;
  const left = new Set(a);
  const right = new Set(b as string[]);
  return left.size === right.size && b.length === right.size && [...left].every((item) => right.has(item));
}

// 빠지는 항목이 있으면, 사용자가 확인한 목록이 계획의 목록과 정확히 같아야 한다.
function assertAcknowledged(entry: { missing: string[]; filteredOut: string[] }, ack: Partial<PlanAck> | undefined | null): void {
  if (entry.missing.length > 0 && !sameSet(entry.missing, ack?.missing)) {
    fail(`DB에 없어 빠지는 항목 ${entry.missing.length}개를 화면에서 확인("이 ${entry.missing.length}개를 빼고 진행")해야 실행·저장할 수 있습니다. 계획을 다시 만들었다면 다시 확인해주세요.`);
  }
  if (entry.filteredOut.length > 0 && !sameSet(entry.filteredOut, ack?.filteredOut)) {
    fail(`필터로 제외되는 테이블 ${entry.filteredOut.length}개를 화면에서 확인해야 실행·저장할 수 있습니다.`);
  }
}

function lookup(planId: unknown, dbmsid: string | number): Entry {
  const entry = typeof planId === 'string' ? plans.get(planId) : undefined;
  if (!entry || Date.now() - entry.createdAt > TTL_MS) fail('분할 계획을 찾을 수 없습니다 (서버 재시작 또는 오래됨). "분할 계획 만들기"로 다시 만들어 주세요.');
  if (entry.dbmsid !== String(dbmsid)) fail('다른 DB의 계획입니다. 계획을 다시 만들어 주세요.');
  return entry;
}

// Export 실행: 계획에 있는 작업 그대로인지 + 빠지는 항목 확인
function checkPlanStart(
  planId: unknown,
  dbmsid: string | number,
  request: DataPumpRequest,
  ack: Partial<PlanAck> | undefined | null
): { expected: string[]; ack: PlanAck; bundle: { id: string; jobNo: number | null; draft: BundleDraft } | null } {
  const entry = lookup(planId, dbmsid);
  const job = entry.jobs.get(String(request.jobName));
  if (!job || job.hash !== requestHash(request, job.fixedScn === null) || (job.fixedScn !== null && request.flashbackScn !== job.fixedScn)) {
    fail('요청이 분할 계획과 다릅니다. 계획을 다시 만들어 주세요.');
  }
  assertAcknowledged(entry, ack);
  const bundle = entry.bundle ? { id: String(planId), jobNo: entry.bundle.jobs.find((item) => item.jobName === String(request.jobName))?.no ?? null, draft: entry.bundle } : null;
  return { expected: job.expected, ack: { missing: entry.missing, filteredOut: entry.filteredOut }, bundle };
}

const PLAN_JOB = /^JOB_NAME=(DBC_EXP_\S+)$/m;

// parfile 저장: Export 계획의 parfile(JOB_NAME=DBC_EXP_…)이 들어 있으면 계획과 대조하고 확인을 요구한다.
// 돌려주는 summaryFile은 서버가 만든 요약(빠진 목록 포함)이라 함께 저장한다.
function checkPlanFiles(
  planId: unknown,
  dbmsid: string | number,
  files: { name: string; content: string }[],
  ack: Partial<PlanAck> | undefined | null
): { summaryFile: { name: string; text: string } | null; ack: PlanAck | null; bundle: { id: string; draft: BundleDraft } | null } {
  const planJobs = files.filter((file) => /\.par$/i.test(file.name)).map((file) => file.content.match(PLAN_JOB)?.[1]).filter((name): name is string => !!name);
  if (planJobs.length === 0 && (planId === undefined || planId === null)) return { summaryFile: null, ack: null, bundle: null };
  const entry = lookup(planId, dbmsid);
  const foreign = planJobs.filter((name) => !entry.jobs.has(name));
  if (foreign.length > 0) fail(`계획에 없는 작업의 parfile입니다: ${foreign.slice(0, 5).join(', ')}. 계획을 다시 만들어 주세요.`);
  assertAcknowledged(entry, ack);
  return {
    summaryFile: entry.summaryFile,
    ack: { missing: entry.missing, filteredOut: entry.filteredOut },
    bundle: entry.bundle && planJobs.length > 0 ? { id: String(planId), draft: entry.bundle } : null,
  };
}

export { registerPlan, assertAcknowledged, checkPlanStart, checkPlanFiles };
