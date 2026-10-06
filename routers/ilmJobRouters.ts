import express from 'express';
import * as ilmJobController from '../controllers/ilmJobController';
import { requireDba, requireScreen } from '../middleware/auth';

const router = express.Router();

// 기본은 SUPER_ADMIN 화면 (계정 관리에서 사용자별로 열 수 있음). 등록/수정은 화면이 보여도 DBA 이상만 (화면의 버튼 기준과 같음).
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로, router.use(...)처럼 경로
// 없이 걸면 같이 마운트된 다른 라우터의 요청까지 가로챕니다 — 반드시 라우트별로 겁니다.
router.post('/ilmJob/list', requireScreen('ilmJob'), ilmJobController.getPartitionRetentionList);
router.post('/ilmJob/add', requireScreen('ilmJob'), requireDba, ilmJobController.addPartitionRetention);
router.post('/ilmJob/update', requireScreen('ilmJob'), requireDba, ilmJobController.updatePartitionRetention);

export default router;
