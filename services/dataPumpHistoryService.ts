import * as dataPumpModel from '../models/dataPumpModel';
import * as historyModel from '../models/dataPumpHistoryModel';
import type { DataPumpHistoryRow, DataPumpHistoryStatus, NewHistory } from '../models/dataPumpHistoryModel';
import type { DataPumpPlan } from '../models/dataPumpModel';
import { logger } from '../utils/logger';

// Data Pump 작업 이력: 시작할 때 RUNNING으로 기록하고, 작업이 대상 DB에서 사라지면 로그를 읽어 마무리한다.
// 이력은 부가 기능이라 이력 저장/마무리가 실패해도 작업 자체(시작/취소/조회)는 막지 않는다.

// 이력 테이블(scripts/add_datapump_history.sql)이 아직 없는 환경이면 매분 에러 로그가 쌓이지 않게,
// 처음 한 번만 알리고 이 프로세스에서는 이력 기능을 쉰다.
let historyTableMissing = false;

function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && /ORA-00942|ORA-02289/.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function handleHistoryError(action: string, error: unknown): void {
  if (isMissingTable(error)) {
    if (!historyTableMissing) {
      logger.warn('DataPump', '작업 이력 테이블이 없어 이력 기능을 건너뜁니다 (scripts/add_datapump_history.sql 실행 필요)');
    }
    historyTableMissing = true;
    return;
  }
  logger.warn('DataPump', `작업 이력 ${action} 실패 (작업 자체에는 영향 없음)`, error);
}

// ── 로그 해석 (DB 접근 없는 순수 함수, 단위 테스트로 검증) ──

export interface ParsedLog {
  status: DataPumpHistoryStatus;
  elapsedSec: number | null;
  errorCount: number | null;
  resultMessage: string | null;
  dumpFiles: string[]; // 덤프 파일 이름 (경로 제외)
}

// expdp/impdp 로그의 마지막 결과 줄과 "Dump file set ... is:" 목록을 읽는다. 예:
//   Job "SYSTEM"."DBC_EXP_..." successfully completed at Fri Oct 2 07:49:21 2026 elapsed 0 00:00:35
//   Job "SYSTEM"."DBC_IMP_..." completed with 1 error(s) at Fri Oct 2 07:49:33 2026 elapsed 0 00:00:08
//   Job "SYSTEM"."X" stopped due to fatal error at ...
function parseDataPumpLog(text: string): ParsedLog {
  const lines = text.split(/\r?\n/);
  const resultLine = [...lines].reverse().find((line) => /^Job ".+"\.".+" .+ at /.test(line.trim()))?.trim() ?? null;

  let status: DataPumpHistoryStatus = 'UNKNOWN';
  let errorCount: number | null = null;
  if (resultLine) {
    const withErrors = resultLine.match(/completed with (\d+) error/);
    if (/successfully completed/.test(resultLine)) {
      status = 'COMPLETED';
      errorCount = 0;
    } else if (withErrors) {
      status = 'COMPLETED_WITH_ERRORS';
      errorCount = Number(withErrors[1]);
    } else if (/stopped due to fatal error/.test(resultLine)) {
      status = 'FAILED';
    } else if (/stopped|killed/i.test(resultLine)) {
      status = 'CANCELLED';
    }
  }

  let elapsedSec: number | null = null;
  const elapsed = resultLine?.match(/elapsed (\d+) (\d{1,2}):(\d{2}):(\d{2})/);
  if (elapsed) {
    elapsedSec = Number(elapsed[1]) * 86400 + Number(elapsed[2]) * 3600 + Number(elapsed[3]) * 60 + Number(elapsed[4]);
  }

  // "Dump file set for X is:" 다음 줄들(들여쓴 파일 경로)이 실제로 만들어진 덤프 파일.
  const dumpFiles: string[] = [];
  const start = lines.findIndex((line) => /^Dump file set for .+ is:/.test(line.trim()));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const path = line.trim();
      if (!path || path.startsWith('Job ') || path.startsWith('*')) break;
      const name = path.split(/[\\/]/).pop();
      if (name) dumpFiles.push(name);
    }
  }

  return { status, elapsedSec, errorCount, resultMessage: resultLine, dumpFiles };
}

// 이력 목록의 "대상" 칸에 남길 요약.
function describeTarget(plan: DataPumpPlan): string {
  const list = (expr: string | null) => (expr ?? '').replace(/^(NOT )?IN \(|\)$/g, '').replace(/'/g, '');
  const parts: string[] = [];
  if (plan.jobMode === 'SCHEMA') {
    parts.push(`SCHEMAS=${list(plan.schemaExpr)}`);
    if (plan.excludeTableExpr) parts.push(`제외 테이블 ${list(plan.excludeTableExpr).split(',').length}개`);
  } else if (plan.jobMode === 'TABLE') {
    const tables = list(plan.nameExpr).split(',');
    parts.push(`${list(plan.schemaExpr)} 테이블 ${tables.length}개: ${tables.slice(0, 10).join(', ')}${tables.length > 10 ? ' …' : ''}`);
  } else {
    parts.push('덤프 전체');
  }
  for (const pair of plan.remapSchemas) parts.push(`REMAP_SCHEMA ${pair.from}→${pair.to}`);
  for (const pair of plan.remapTablespaces) parts.push(`REMAP_TABLESPACE ${pair.from}→${pair.to}`);
  return parts.join(' / ');
}

// ── DB를 거치는 기능 ──

async function recordStart(
  dbmsId: number | string,
  target: { dbname: string; user: string },
  plan: DataPumpPlan,
  startedBy: string | null,
  estimatedBytes: number | null
): Promise<void> {
  if (historyTableMissing) return;
  const row: NewHistory = {
    dbmsId,
    dbname: target.dbname,
    jobOwner: target.user.toUpperCase(),
    jobName: plan.jobName,
    operation: plan.operation,
    jobMode: plan.jobMode,
    targetDesc: describeTarget(plan),
    directory: plan.directory,
    dumpfile: plan.dumpfile,
    logfile: plan.logfile,
    parallel: plan.parallel,
    tableExistsAction: plan.tableExistsAction,
    estimatedBytes,
    startedBy,
  };
  try {
    await historyModel.insertHistory(row);
  } catch (error) {
    handleHistoryError('기록', error);
  }
}

async function recordCancel(dbmsId: number | string, owner: string, jobName: string): Promise<void> {
  if (historyTableMissing) return;
  try {
    await historyModel.markCancelled(dbmsId, owner, jobName);
  } catch (error) {
    handleHistoryError('취소 표시', error);
  }
}

// 덤프 파일 이름에 %U가 있으면 로그의 "Dump file set" 목록이 실제 이름이고, 없으면 지정한 이름 그대로다.
async function dumpBytesOf(row: DataPumpHistoryRow, parsed: ParsedLog): Promise<number | null> {
  const names = parsed.dumpFiles.length > 0 ? parsed.dumpFiles : /%U/i.test(row.dumpfile) ? [] : [row.dumpfile];
  if (names.length === 0) return null;
  const sizes = await dataPumpModel.getFileSizes({ dbmsid: row.dbmsId }, row.directory, names);
  const values = Object.values(sizes);
  return values.length > 0 ? values.reduce((sum, size) => sum + size, 0) : null;
}

// RUNNING으로 남아 있는 이력 중, 대상 DB에서 이미 사라진(끝난) 작업을 로그로 마무리한다.
// 같은 DB를 동시에 두 번 마무리하지 않도록 진행 중인 것은 건너뛴다.
const syncing = new Set<string>();

async function syncRunning(dbmsId: number | string | null): Promise<void> {
  if (historyTableMissing) return;
  const key = String(dbmsId ?? 'ALL');
  if (syncing.has(key)) return;
  syncing.add(key);
  try {
    const running = await historyModel.listRunning(dbmsId);
    for (const row of running) {
      try {
        if (await dataPumpModel.jobExists({ dbmsid: row.dbmsId }, row.jobOwner ?? '', row.jobName)) continue;
        const log = await dataPumpModel.readLog({ dbmsid: row.dbmsId }, row.directory, row.logfile);
        const parsed = log.exists
          ? parseDataPumpLog(log.text)
          : { status: 'UNKNOWN' as const, elapsedSec: null, errorCount: null, resultMessage: '로그 파일을 찾을 수 없음', dumpFiles: [] };
        const dumpBytes = row.operation === 'EXPORT' && parsed.status !== 'UNKNOWN' ? await dumpBytesOf(row, parsed) : null;
        await historyModel.finishHistory(row.id, {
          status: parsed.status,
          elapsedSec: parsed.elapsedSec,
          errorCount: parsed.errorCount,
          resultMessage: parsed.resultMessage,
          dumpBytes,
        });
      } catch (error) {
        // 대상 DB에 잠깐 못 붙는 경우 등 — 다음 확인 때 다시 시도한다.
        logger.warn('DataPump', `작업 이력 마무리 보류 (${row.dbname} ${row.jobName})`, error);
      }
    }
  } catch (error) {
    handleHistoryError('마무리', error);
  } finally {
    syncing.delete(key);
  }
}

export interface HistoryResponse {
  available: boolean; // 이력 테이블이 없으면 false
  rows: DataPumpHistoryRow[];
  throughput: { exportBytesPerSec: number | null; samples: number };
}

async function getHistory(dbmsId: number | string, limit = 100): Promise<HistoryResponse> {
  const empty: HistoryResponse = { available: false, rows: [], throughput: { exportBytesPerSec: null, samples: 0 } };
  if (historyTableMissing) return empty;
  await syncRunning(dbmsId);
  try {
    const [rows, exportSpeed] = await Promise.all([historyModel.listHistory(dbmsId, limit), historyModel.getExportThroughput(dbmsId)]);
    return { available: true, rows, throughput: { exportBytesPerSec: exportSpeed.bytesPerSec, samples: exportSpeed.samples } };
  } catch (error) {
    handleHistoryError('조회', error);
    if (historyTableMissing) return empty;
    throw new Error('Data Pump 작업 이력 조회 실패', { cause: error });
  }
}

export { parseDataPumpLog, describeTarget, recordStart, recordCancel, syncRunning, getHistory };
