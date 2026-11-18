import express from 'express';
import * as notifyController from '../controllers/notifyController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// 계정 > 알림 설정 — 최고관리자만. '/api' 전체에 마운트되므로 router.use()로 걸지 말고 라우트마다 건다.
router.get('/notify/config', requireSuperAdmin, notifyController.getConfig);
router.post('/notify/config/save', requireSuperAdmin, notifyController.saveConfig);
router.post('/notify/test', requireSuperAdmin, notifyController.sendTest);
router.post('/notify/telegram/chats', requireSuperAdmin, notifyController.telegramChats);

export default router;
