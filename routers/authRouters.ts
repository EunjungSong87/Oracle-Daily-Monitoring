import express from 'express';
import * as authController from '../controllers/authController';

// 이 라우터는 server.ts에서 requireAuth 게이트보다 먼저 마운트됩니다 (로그인 자체는
// 비인증 상태에서 이뤄져야 하므로).
const router = express.Router();

router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/me', authController.me);

export default router;
