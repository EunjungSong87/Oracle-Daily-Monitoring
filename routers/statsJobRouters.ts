import express from 'express';
import * as statsJobController from '../controllers/statsJobController';
import { requireScreen } from '../middleware/auth';

const router = express.Router();

// 이 라우터도 '/api' 전체에 마운트되므로, router.use(...)처럼 경로 없이 걸면
// 같이 마운트된 다른 라우터의 요청까지 가로챕니다 — 반드시 라우트별로 겁니다
// (tableSpecRouters.ts, dbmsRouters.ts와 동일한 이유).
// 기본은 최고관리자 화면 (계정 관리 > 화면 권한에서 사용자별로 열 수 있음).
router.post('/statsJob/status', requireScreen('statsJob'), statsJobController.getJobStatus);
router.post('/statsJob/run', requireScreen('statsJob'), statsJobController.runJob);

export default router;
