import express from 'express';
import * as dataPumpController from '../controllers/dataPumpController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// Data Pump(EXPDP/IMPDP)는 대상 DB에 작업을 걸고 데이터를 덮어쓸 수도 있어서 최고관리자 전용입니다.
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로 반드시 라우트별로 겁니다 (router.use 금지).
router.post('/dataPump/meta', requireSuperAdmin, dataPumpController.getMeta);
router.post('/dataPump/exportPlan', requireSuperAdmin, dataPumpController.exportPlan);
router.post('/dataPump/currentScn', requireSuperAdmin, dataPumpController.currentScn);
router.post('/dataPump/preview', requireSuperAdmin, dataPumpController.preview);
router.post('/dataPump/start', requireSuperAdmin, dataPumpController.start);
router.post('/dataPump/jobs', requireSuperAdmin, dataPumpController.getJobs);
router.post('/dataPump/cancel', requireSuperAdmin, dataPumpController.cancel);
router.post('/dataPump/saveFiles', requireSuperAdmin, dataPumpController.saveFiles);
router.post('/dataPump/history', requireSuperAdmin, dataPumpController.getHistory);
router.post('/dataPump/log', requireSuperAdmin, dataPumpController.readLog);

export default router;
