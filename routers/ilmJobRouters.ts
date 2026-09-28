import express from 'express';
import * as ilmJobController from '../controllers/ilmJobController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// 조회/등록/수정 모두 SUPER_ADMIN 전용입니다 (Stats Job 화면과 동일한 기준).
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로, router.use(requireSuperAdmin)처럼 경로
// 없이 걸면 같이 마운트된 다른 라우터의 요청까지 가로챕니다 — 반드시 라우트별로 겁니다.
router.post('/ilmJob/list', requireSuperAdmin, ilmJobController.getPartitionRetentionList);
router.post('/ilmJob/add', requireSuperAdmin, ilmJobController.addPartitionRetention);
router.post('/ilmJob/update', requireSuperAdmin, ilmJobController.updatePartitionRetention);

export default router;
