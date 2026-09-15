import express from 'express';
import * as usersController from '../controllers/usersController';
import { requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// 담당자 지정 드롭다운은 로그인한 사람이면 누구나 조회할 수 있어야 하므로 최고관리자 게이트 이전에 둡니다.
router.get('/users/basic', usersController.listBasic);

// 이 아래는 계정 관리 기능이라 최고관리자만 접근 가능합니다.
router.use(requireSuperAdmin);
router.get('/users', usersController.listUsers);
router.post('/users/add', usersController.createUser);
router.post('/users/update', usersController.updateUser);

export default router;
