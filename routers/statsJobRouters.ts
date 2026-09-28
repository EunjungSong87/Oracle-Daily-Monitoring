import express from 'express';
import * as statsJobController from '../controllers/statsJobController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// 이 라우터도 '/api' 전체에 마운트되므로, router.use(requireSuperAdmin)처럼 경로 없이 걸면
// 같이 마운트된 다른 라우터의 요청까지 가로챕니다 — 반드시 라우트별로 겁니다
// (tableSpecRouters.ts, dbmsRouters.ts와 동일한 이유).
// 이 화면은 최고관리자 전용으로 두기로 했으므로(Table Spec의 DBA 이상보다 더 좁음) 전부 requireSuperAdmin.
router.post('/statsJob/status', requireSuperAdmin, statsJobController.getJobStatus);
router.post('/statsJob/staleStats', requireSuperAdmin, statsJobController.getStaleStats);
router.post('/statsJob/run', requireSuperAdmin, statsJobController.runJob);

export default router;
