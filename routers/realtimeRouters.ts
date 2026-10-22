import express from 'express';
import * as realtimeController from '../controllers/realtimeController';
import { requireScreen, requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// 조회 전용이라 기본은 누구나(VIEWER 포함) — 계정 관리에서 사용자별로 숨기면 막힙니다.
router.post('/realtime/sessions', requireScreen('realtime'), realtimeController.getSessions);
router.post('/realtime/sessionDetail', requireScreen('realtime'), realtimeController.getSessionDetail);
// Blocking 체인의 세션 Kill — 최고관리자만, 대상 DB명을 직접 입력해야 하고 메타 DB에 기록이 남는다.
router.post('/realtime/killSession', requireScreen('realtime'), requireSuperAdmin, realtimeController.killSession);

export default router;
