import express from 'express';
import * as parameterCompareController from '../controllers/parameterCompareController';
import { requireScreen } from '../middleware/auth';

const router = express.Router();

// Compare 메뉴(오브젝트/파라미터 비교)는 기본이 최고관리자 화면입니다 (계정 관리 > 화면 권한에서 사용자별로 열 수 있음).
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로 반드시 라우트별로 겁니다 (router.use 금지).
router.post('/parameterCompare/run', requireScreen('parameterCompare'), parameterCompareController.compare);

export default router;
