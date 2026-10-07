import express from 'express';
import * as objectCompareController from '../controllers/objectCompareController';
import { requireScreen } from '../middleware/auth';

const router = express.Router();

// 오브젝트 비교 화면은 기본이 최고관리자 화면입니다 (계정 관리 > 화면 권한에서 사용자별로 열 수 있음).
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로, router.use(...)처럼 경로
// 없이 걸면 같이 마운트된 다른 라우터의 요청까지 가로챕니다 — 반드시 라우트별로 겁니다.
router.post('/objectCompare/schemas', requireScreen('objectCompare'), objectCompareController.getSchemas);
router.post('/objectCompare/run', requireScreen('objectCompare'), objectCompareController.compare);
router.post('/objectCompare/sourceDiff', requireScreen('objectCompare'), objectCompareController.getSourceDiff);
router.post('/objectCompare/security/lists', requireScreen('objectCompare'), objectCompareController.getSecurityLists);
router.post('/objectCompare/security/run', requireScreen('objectCompare'), objectCompareController.compareSecurity);

export default router;
