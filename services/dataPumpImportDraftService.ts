import * as historyModel from '../models/dataPumpHistoryModel';
import type { DbmsIdParam } from '../models/dbmsModel';
import { fail } from './dataPumpErrors';
import { draftFromHistory, draftFromRequest, parseExportLog, parseParfile, type ImportDraft } from './dataPumpParfileParse';
import { readLog } from './dataPumpService';
import type { DataPumpRequest } from './dataPumpService';

// Import 탭 "기존 Export에서 가져오기". 출처는 작업 이력(메타 DB), 붙여넣은 parfile, 기존 로그 읽기 API뿐 — 대상 DB에 새 조회를 하지 않는다.

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /ORA-00942/.test(error.message);
}

async function listExports(dbmsid: DbmsIdParam) {
  try {
    return (await historyModel.listCompletedExports(dbmsid.dbmsid)).map((row) => ({
      id: row.id,
      jobName: row.jobName,
      jobMode: row.jobMode,
      status: row.status,
      startedAt: row.startedAt,
      dumpfile: row.dumpfile,
      targetDesc: row.targetDesc,
      hasRequest: row.request !== null,
      bundleKey: row.bundleId,
      bundleJobs: row.bundleJobs,
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw new Error('Export 이력 조회 실패', { cause: error });
  }
}

export interface DraftInput {
  source: 'HISTORY' | 'PARFILE' | 'LOG';
  historyId?: unknown;
  text?: unknown;
  directory?: unknown;
  logfile?: unknown;
}

// 폼에 채울 값 + 항목 목록(스키마/테이블) — 화면은 채운 뒤 이 목록과 폼의 항목을 다시 대조한다.
async function draft(dbmsid: DbmsIdParam, input: DraftInput, sqlAllowed: boolean): Promise<ImportDraft & { items: string[] }> {
  let result: ImportDraft;
  if (input.source === 'HISTORY') {
    const id = Number(input.historyId);
    if (!Number.isInteger(id)) fail('Export 이력을 골라주세요.');
    let rows;
    try {
      rows = await historyModel.listCompletedExports(dbmsid.dbmsid, id);
    } catch (error) {
      throw new Error('Export 이력 조회 실패', { cause: error });
    }
    const row = rows[0];
    if (!row) fail('이 DB에서 끝난(COMPLETED) Export 이력이 아닙니다.');
    // 분할 묶음의 작업 하나만 Import 폼에 채우면 나머지 덤프의 항목이 빠진다 — 묶음 전체는 "이관 Import" 탭에서 (빠짐·중복·파일·사전 점검)
    if (row.bundleJobs > 1) fail(`이 Export는 작업 ${row.bundleJobs}개로 나눈 묶음입니다. 하나만 가져오면 나머지 덤프의 항목이 빠지므로 "이관 Import" 탭에서 묶음 전체로 만드세요.`);
    if (row.request) {
      // 스키마별로 나눠 실행한 하위 작업(_S1 …)은 그 스키마 것만 — 이력의 대상 목록이 그 스키마로 걸러져 있다
      const runOwners = /_S\d+$/.test(row.jobName) && row.expected ? new Set(row.expected.map((key) => key.split('.')[0])) : null;
      result = draftFromRequest(row.request as DataPumpRequest, { directory: row.directory, dumpfile: row.dumpfile }, runOwners, sqlAllowed);
    } else {
      result = draftFromHistory({ directory: row.directory, dumpfile: row.dumpfile, jobMode: row.jobMode, targetDesc: row.targetDesc, expected: row.expected }, sqlAllowed);
    }
    result.source = `작업 이력 ${row.jobName} (${row.startedAt ?? ''})`;
  } else if (input.source === 'PARFILE') {
    if (typeof input.text !== 'string' || input.text.length > 4 * 1024 * 1024) fail('parfile 내용이 없거나 너무 큽니다.');
    result = parseParfile(input.text, sqlAllowed);
  } else if (input.source === 'LOG') {
    const log = await readLog(dbmsid, String(input.directory ?? ''), String(input.logfile ?? ''));
    if (!log.exists) fail('로그 파일이 없습니다.');
    if (log.truncated && !/Starting ".+"\.".+":/.test(log.text)) fail('로그가 너무 커서 앞부분(헤더)을 읽지 못했습니다. parfile로 가져오세요.');
    result = parseExportLog(log.text, sqlAllowed);
    result.source = `로그 ${String(input.directory)}/${String(input.logfile)}`;
  } else {
    fail('가져올 곳을 골라주세요.');
  }
  return { ...result, items: result.mode === 'SCHEMA' ? result.schemas : result.mode === 'TABLE' ? result.tables : [] };
}

export { listExports, draft };
