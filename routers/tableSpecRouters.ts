import express from 'express';
import * as tableSpecController from '../controllers/tableSpecController';
import { requireDba } from '../middleware/auth';

const router = express.Router();

// 이 페이지의 유일한 기능이 추출이라, 목록 조회까지 포함해 전부 DBA 이상만 접근 가능합니다.
// (이 라우터는 server.ts에서 '/api' 전체에 마운트되므로, router.use(requireDba)처럼 경로
// 없이 걸면 /api로 들어오는 다른 라우터의 요청까지 가로채게 됩니다 — 반드시 라우트별로 겁니다.)
router.post('/tableSpec/schemas', requireDba, tableSpecController.getSchemas);
router.post('/tableSpec/tables', requireDba, tableSpecController.getTables);
router.post('/tableSpec/download', requireDba, tableSpecController.downloadTableSpec);

export default router;
