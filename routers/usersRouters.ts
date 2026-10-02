import express from 'express';
import * as usersController from '../controllers/usersController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// 담당자 지정 드롭다운은 로그인한 사람이면 누구나 조회할 수 있어야 하므로 최고관리자 게이트 이전에 둡니다.
router.get('/users/basic', usersController.listBasic);

// 이 아래는 계정 관리 기능이라 최고관리자만 접근 가능합니다.
// 이 라우터도 server.ts에서 '/api' 전체에 마운트되므로 router.use(requireSuperAdmin)로 경로 없이 걸면 안 됩니다 —
// 그러면 이 라우터 뒤에 마운트된 다른 라우터(예: /realtime)의 요청까지 전부 최고관리자 검사에 걸립니다.
router.get('/users', requireSuperAdmin, usersController.listUsers);
router.post('/users/add', requireSuperAdmin, usersController.createUser);
router.post('/users/update', requireSuperAdmin, usersController.updateUser);

export default router;
