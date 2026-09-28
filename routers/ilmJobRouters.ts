import express from 'express';
import * as ilmJobController from '../controllers/ilmJobController';
import { requireDba } from '../middleware/auth';

const router = express.Router();

// 조회/등록/수정 모두 DBA 이상이면 충분합니다 (dbmslist/thresholds와 동일한 기준).
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로, router.use(requireDba)처럼 경로
// 없이 걸면 같이 마운트된 다른 라우터의 요청까지 가로챕니다 — 반드시 라우트별로 겁니다.
router.post('/ilmJob/list', requireDba, ilmJobController.getPartitionRetentionList);
router.post('/ilmJob/add', requireDba, ilmJobController.addPartitionRetention);
router.post('/ilmJob/update', requireDba, ilmJobController.updatePartitionRetention);

export default router;
