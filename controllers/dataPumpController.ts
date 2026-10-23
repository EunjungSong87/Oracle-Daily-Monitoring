import type { Request, Response } from 'express';
import * as dataPumpService from '../services/dataPumpService';
import { DataPumpValidationError } from '../services/dataPumpService';
import * as historyService from '../services/dataPumpHistoryService';
import * as partitionService from '../services/dataPumpPartitionService';
import * as migrationService from '../services/dataPumpMigrationService';
import * as importDraftService from '../services/dataPumpImportDraftService';
import { logger } from '../utils/logger';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Oracle이 돌려준 원래 에러(ORA-39001 등)까지 보여줘야 원인을 알 수 있어서, 감싼 에러의 cause 메시지를 이어 붙입니다.
function detailMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    messages.push(errMsg(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(' ← ');
}

// 검증 실패는 400(사용자가 고칠 수 있는 입력 문제), 그 외는 500으로 응답합니다.
function handleError(res: Response, error: unknown, logMessage: string): void {
  if (error instanceof DataPumpValidationError) {
    res.status(400).json({ message: error.message, ...(error.items.length > 0 ? { items: error.items } : {}) });
    return;
  }
  logger.error('DataPump', logMessage, error);
  res.status(500).json({ message: detailMessage(error) });
}

function requireDbmsid(req: Request, res: Response): string | number | null {
  const { dbmsid } = req.body ?? {};
  if (!dbmsid) {
    res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    return null;
  }
  return dbmsid;
}

async function getMeta(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await dataPumpService.getMeta({ dbmsid }));
  } catch (error) {
    handleError(res, error, `기본 정보 조회 오류 (dbmsid=${dbmsid})`);
  }
}

// 스키마의 뷰 목록 (VIEWS_AS_TABLES 고르기용, networkLink면 링크 너머).
async function views(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json({ views: await dataPumpService.getViews({ dbmsid }, req.body.owner, req.body.networkLink) });
  } catch (error) {
    handleError(res, error, `뷰 목록 조회 오류 (dbmsid=${dbmsid})`);
  }
}

// DB 링크 너머 DB의 스키마 목록 (링크로 export할 때).
async function linkSchemas(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json({ schemas: await dataPumpService.getLinkSchemas({ dbmsid }, req.body.networkLink) });
  } catch (error) {
    handleError(res, error, `DB 링크 스키마 조회 오류 (dbmsid=${dbmsid})`);
  }
}

// 스키마 선택 / 테이블 목록 / Range 파티션(기간) → 분할 크기(기본 1T) 이하의 export 작업들과 각 parfile.
async function exportPlan(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    const { schemas, tableList, partitionSource, refreshSizes, options } = req.body;
    res.json(await dataPumpService.planExport({ dbmsid }, { schemas, tableList, partitionSource, refreshSizes }, options ?? {}, req.session.role ?? null));
  } catch (error) {
    handleError(res, error, `분할 계획 생성 오류 (dbmsid=${dbmsid})`);
  }
}

// 여러 작업을 같은 시점으로 맞춰 실행할 때 모든 작업에 걸 SCN.
async function currentScn(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json({ scn: await dataPumpService.getCurrentScn({ dbmsid }, req.body.networkLink) });
  } catch (error) {
    handleError(res, error, `현재 SCN 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function preview(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await dataPumpService.preview({ dbmsid }, req.body.request ?? {}, req.session.role ?? null));
  } catch (error) {
    handleError(res, error, `parfile 생성 오류 (dbmsid=${dbmsid})`);
  }
}

// 실제로 DB에 작업을 거는 요청이라, 누가 무엇을 시작했는지 로그로 남깁니다 (감사 목적).
async function start(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    const { jobName, jobNames, plan } = await dataPumpService.start(
      { dbmsid },
      req.body.request ?? {},
      req.body.confirmDbname,
      req.session.username ?? null,
      req.body.estimatedBytes,
      req.session.role ?? null,
      req.body.planId ?? null,
      req.body.acknowledged ?? null
    );
    logger.info(
      'DataPump',
      `${req.session.username} 작업 시작: ${jobName} (dbmsid=${dbmsid}, ${plan.operation} ${plan.jobMode}` +
        `${plan.tableExistsAction ? `, TABLE_EXISTS_ACTION=${plan.tableExistsAction}` : ''}, ${plan.directory}/${plan.dumpfile})` +
        `${jobNames.length > 1 ? ` — 스키마별 ${jobNames.length}개로 나눠 실행: ${jobNames.join(', ')}` : ''}`
    );
    // 필터·옵션 감사: QUERY/서브쿼리 원문, SAMPLE, DATA_OPTIONS, VIEWS_AS_TABLES
    if (plan.filters.audit.length > 0) {
      logger.info('DataPump', `${req.session.username} 작업 ${jobName} 필터: ${plan.filters.audit.join(' / ')}`);
    }
    res.json({ jobName, jobNames });
  } catch (error) {
    handleError(res, error, `작업 시작 오류 (dbmsid=${dbmsid})`);
  }
}

async function getJobs(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await dataPumpService.getJobs({ dbmsid }));
  } catch (error) {
    handleError(res, error, `작업 목록 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function cancel(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  const { owner, jobName, confirmDbname } = req.body;
  try {
    await dataPumpService.cancel({ dbmsid }, owner, jobName, confirmDbname, req.session.username ?? null);
    logger.info('DataPump', `${req.session.username} 작업 취소: ${owner}.${jobName} (dbmsid=${dbmsid})`);
    res.json({ message: '작업을 취소했습니다.' });
  } catch (error) {
    handleError(res, error, `작업 취소 오류 (dbmsid=${dbmsid}, ${owner}.${jobName})`);
  }
}

// parfile/실행 스크립트를 DB 서버 DIRECTORY에 저장 (덮어쓰기는 화면에서 확인받은 뒤 overwrite=true로 다시 호출).
async function saveFiles(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  const { directory, files, overwrite, planId, acknowledged } = req.body;
  try {
    const result = await dataPumpService.saveFiles({ dbmsid }, directory, files, overwrite === true, planId ?? null, acknowledged ?? null, req.session.username ?? null);
    if (result.written.length > 0) {
      logger.info('DataPump', `${req.session.username} 파일 저장: ${directory}/${result.written.join(', ')} (dbmsid=${dbmsid})`);
    }
    res.json(result);
  } catch (error) {
    handleError(res, error, `파일 저장 오류 (dbmsid=${dbmsid}, ${directory})`);
  }
}

// 작업 이력 (메타데이터 DB). 조회할 때 끝난 작업을 로그로 마무리한 뒤 돌려준다.
async function getHistory(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await historyService.getHistory(dbmsid, 100, req.body.includeExternal === true));
  } catch (error) {
    handleError(res, error, `작업 이력 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function readLog(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await dataPumpService.readLog({ dbmsid }, req.body.directory, req.body.logfile));
  } catch (error) {
    handleError(res, error, `로그 읽기 오류 (dbmsid=${dbmsid})`);
  }
}


// ── Range 파티션 (날짜 기간으로 파티션 단위 export/import) ──

async function partitionTables(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json({ tables: await partitionService.getTables({ dbmsid }, req.body.owner) });
  } catch (error) {
    handleError(res, error, `파티션 테이블 목록 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function partitionList(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await partitionService.getPartitions({ dbmsid }, req.body.owner, req.body.table));
  } catch (error) {
    handleError(res, error, `파티션 목록 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function partitionManifest(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await partitionService.readManifest({ dbmsid }, req.body.directory, req.body.file));
  } catch (error) {
    handleError(res, error, `매니페스트 읽기 오류 (dbmsid=${dbmsid})`);
  }
}

async function partitionImportPlan(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    const { manifest, partitions, options } = req.body;
    res.json(await partitionService.planImport({ dbmsid }, manifest, partitions, options ?? {}, req.session.role ?? null));
  } catch (error) {
    handleError(res, error, `파티션 import 계획 생성 오류 (dbmsid=${dbmsid})`);
  }
}

// ── Import 탭 "기존 Export에서 가져오기" (작업 이력 / parfile / 로그) ──

async function importDraftExports(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json({ rows: await importDraftService.listExports({ dbmsid }) });
  } catch (error) {
    handleError(res, error, `Export 이력 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function importDraft(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    // QUERY/서브쿼리 조건은 DBA 이상만 채운다 (화면과 같은 기준)
    const sqlAllowed = req.session.role === 'DBA' || req.session.role === 'SUPER_ADMIN';
    res.json(await importDraftService.draft({ dbmsid }, req.body ?? {}, sqlAllowed));
  } catch (error) {
    handleError(res, error, `기존 Export 가져오기 오류 (dbmsid=${dbmsid})`);
  }
}

// ── 이관 Import (Export 이력 → Import 생성 → 사전 점검) ──

async function migrationBundles(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json({ rows: await migrationService.listBundles({ dbmsid }) });
  } catch (error) {
    handleError(res, error, `Export 묶음 목록 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function migrationBundle(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await migrationService.getBundle({ dbmsid }, req.body.bundleKey));
  } catch (error) {
    handleError(res, error, `Export 묶음 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function migrationGenerate(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    const { bundleKey, targetDbmsId, directory, mapping, selected, options, ack } = req.body;
    const result = await migrationService.generate(
      { dbmsid },
      bundleKey,
      { targetDbmsId, directory, mapping, selected, options: options ?? {}, ack: ack ?? null },
      { name: req.session.username ?? null, role: req.session.role ?? null }
    );
    logger.info(
      'DataPump',
      `${req.session.username} 이관 Import 생성: ${result.jobs.length}개 (원본 dbmsid=${dbmsid} 묶음 ${bundleKey} → 대상 ${result.targetDbname}${result.omitted.length > 0 ? `, 확인하고 뺀 항목 ${result.omitted.length}개` : ''})`
    );
    res.json(result);
  } catch (error) {
    handleError(res, error, `이관 Import 생성 오류 (dbmsid=${dbmsid})`);
  }
}

async function migrationPlan(req: Request, res: Response): Promise<void> {
  try {
    res.json(await migrationService.getPlan(req.body?.planId));
  } catch (error) {
    handleError(res, error, '이관 Import 조회 오류');
  }
}

async function migrationFiles(req: Request, res: Response): Promise<void> {
  try {
    res.json(await migrationService.recheckFiles(req.body?.planId));
  } catch (error) {
    handleError(res, error, '이관 Import 덤프 파일 확인 오류');
  }
}

async function migrationPrecheck(req: Request, res: Response): Promise<void> {
  try {
    res.json(await migrationService.precheck(req.body?.planId));
  } catch (error) {
    handleError(res, error, '이관 Import 사전 점검 오류');
  }
}

async function remapSets(_req: Request, res: Response): Promise<void> {
  try {
    res.json({ rows: await migrationService.listRemapSets() });
  } catch (error) {
    handleError(res, error, '매핑표 조회 오류');
  }
}

async function remapSetSave(req: Request, res: Response): Promise<void> {
  try {
    await migrationService.saveRemapSet(req.body?.name, req.body?.mapping, req.session.username ?? null);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, '매핑표 저장 오류');
  }
}

async function remapSetDelete(req: Request, res: Response): Promise<void> {
  try {
    await migrationService.deleteRemapSet(req.body?.id);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error, '매핑표 삭제 오류');
  }
}

async function partitionHistoryList(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json({ rows: await migrationService.listPartitionExports({ dbmsid }) });
  } catch (error) {
    handleError(res, error, `파티션 Export 이력 조회 오류 (dbmsid=${dbmsid})`);
  }
}

async function partitionHistoryManifest(req: Request, res: Response): Promise<void> {
  const dbmsid = requireDbmsid(req, res);
  if (dbmsid === null) return;
  try {
    res.json(await migrationService.partitionManifestFromHistory({ dbmsid }, req.body.bundleId, req.body.owner, req.body.table));
  } catch (error) {
    handleError(res, error, `파티션 이력 읽기 오류 (dbmsid=${dbmsid})`);
  }
}

export {
  importDraftExports,
  importDraft,
  migrationBundles,
  migrationBundle,
  migrationGenerate,
  migrationPlan,
  migrationFiles,
  migrationPrecheck,
  remapSets,
  remapSetSave,
  remapSetDelete,
  partitionHistoryList,
  partitionHistoryManifest,
  getMeta,
  views,
  linkSchemas,
  exportPlan,
  currentScn,
  preview,
  start,
  getJobs,
  cancel,
  saveFiles,
  getHistory,
  readLog,
  partitionTables,
  partitionList,
  partitionManifest,
  partitionImportPlan,
};
