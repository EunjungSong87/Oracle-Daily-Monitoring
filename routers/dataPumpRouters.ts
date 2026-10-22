import express from 'express';
import * as dataPumpController from '../controllers/dataPumpController';
import { requireScreen } from '../middleware/auth';

const router = express.Router();

// Data Pump(EXPDP/IMPDP)는 대상 DB에 작업을 걸고 데이터를 덮어쓸 수도 있어서 기본은 최고관리자 화면입니다
// (계정 관리 > 화면 권한에서 사용자별로 열 수 있음).
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로 반드시 라우트별로 겁니다 (router.use 금지).
router.post('/dataPump/meta', requireScreen('dataPump'), dataPumpController.getMeta);
router.post('/dataPump/linkSchemas', requireScreen('dataPump'), dataPumpController.linkSchemas);
router.post('/dataPump/views', requireScreen('dataPump'), dataPumpController.views);
router.post('/dataPump/exportPlan', requireScreen('dataPump'), dataPumpController.exportPlan);
router.post('/dataPump/currentScn', requireScreen('dataPump'), dataPumpController.currentScn);
router.post('/dataPump/preview', requireScreen('dataPump'), dataPumpController.preview);
router.post('/dataPump/start', requireScreen('dataPump'), dataPumpController.start);
router.post('/dataPump/jobs', requireScreen('dataPump'), dataPumpController.getJobs);
router.post('/dataPump/cancel', requireScreen('dataPump'), dataPumpController.cancel);
router.post('/dataPump/saveFiles', requireScreen('dataPump'), dataPumpController.saveFiles);
router.post('/dataPump/history', requireScreen('dataPump'), dataPumpController.getHistory);
router.post('/dataPump/log', requireScreen('dataPump'), dataPumpController.readLog);
router.post('/dataPump/partition/tables', requireScreen('dataPump'), dataPumpController.partitionTables);
router.post('/dataPump/partition/list', requireScreen('dataPump'), dataPumpController.partitionList);
router.post('/dataPump/partition/manifest', requireScreen('dataPump'), dataPumpController.partitionManifest);
router.post('/dataPump/partition/importPlan', requireScreen('dataPump'), dataPumpController.partitionImportPlan);
router.post('/dataPump/partition/historyList', requireScreen('dataPump'), dataPumpController.partitionHistoryList);
router.post('/dataPump/partition/historyManifest', requireScreen('dataPump'), dataPumpController.partitionHistoryManifest);
// 이관 Import: Export 이력(묶음) → Import 생성 → 덤프 파일 확인 → 사전 점검. 실행은 /dataPump/start(대상 DB)가 생성 기록과 대조해 막는다.
router.post('/dataPump/migration/bundles', requireScreen('dataPump'), dataPumpController.migrationBundles);
router.post('/dataPump/migration/bundle', requireScreen('dataPump'), dataPumpController.migrationBundle);
router.post('/dataPump/migration/generate', requireScreen('dataPump'), dataPumpController.migrationGenerate);
router.post('/dataPump/migration/plan', requireScreen('dataPump'), dataPumpController.migrationPlan);
router.post('/dataPump/migration/files', requireScreen('dataPump'), dataPumpController.migrationFiles);
router.post('/dataPump/migration/precheck', requireScreen('dataPump'), dataPumpController.migrationPrecheck);
router.post('/dataPump/remapSets', requireScreen('dataPump'), dataPumpController.remapSets);
router.post('/dataPump/remapSets/save', requireScreen('dataPump'), dataPumpController.remapSetSave);
router.post('/dataPump/remapSets/delete', requireScreen('dataPump'), dataPumpController.remapSetDelete);

export default router;
