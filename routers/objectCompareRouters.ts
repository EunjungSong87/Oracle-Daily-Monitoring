import express from 'express';
import * as objectCompareController from '../controllers/objectCompareController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// 오브젝트 비교 화면은 최고관리자 전용입니다 (Stats Job / ILM 화면과 동일한 기준).
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로, router.use(requireSuperAdmin)처럼 경로
// 없이 걸면 같이 마운트된 다른 라우터의 요청까지 가로챕니다 — 반드시 라우트별로 겁니다.
router.post('/objectCompare/schemas', requireSuperAdmin, objectCompareController.getSchemas);
router.post('/objectCompare/run', requireSuperAdmin, objectCompareController.compare);
router.post('/objectCompare/sourceDiff', requireSuperAdmin, objectCompareController.getSourceDiff);

export default router;
