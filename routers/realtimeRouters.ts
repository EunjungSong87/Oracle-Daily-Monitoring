import express from 'express';
import * as realtimeController from '../controllers/realtimeController';
import { requireScreen } from '../middleware/auth';

const router = express.Router();

// 조회 전용이라 기본은 누구나(VIEWER 포함) — 계정 관리에서 사용자별로 숨기면 막힙니다.
router.post('/realtime/sessions', requireScreen('realtime'), realtimeController.getSessions);
router.post('/realtime/sessionDetail', requireScreen('realtime'), realtimeController.getSessionDetail);

export default router;
