import express from 'express';
import * as realtimeController from '../controllers/realtimeController';

const router = express.Router();

// 조회 전용 기능이라 로그인한 사용자면 누구나(VIEWER 포함) 접근 가능합니다.
router.post('/realtime/sessions', realtimeController.getSessions);
router.post('/realtime/sessionDetail', realtimeController.getSessionDetail);

export default router;
