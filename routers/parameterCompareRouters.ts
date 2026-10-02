import express from 'express';
import * as parameterCompareController from '../controllers/parameterCompareController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// Compare 메뉴(오브젝트/파라미터 비교)는 최고관리자 전용입니다.
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로 반드시 라우트별로 겁니다 (router.use 금지).
router.post('/parameterCompare/run', requireSuperAdmin, parameterCompareController.compare);

export default router;
