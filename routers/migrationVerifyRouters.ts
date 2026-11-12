import express from 'express';
import * as migrationVerifyController from '../controllers/migrationVerifyController';
import { requireScreen, requireSuperAdmin } from '../middleware/auth';

const router = express.Router();

// Maintenance > 이관 검증 (기본 SUPER_ADMIN 화면). 재컴파일은 화면 권한과 별개로 최고관리자만.
router.post('/migrationVerify/plans', requireScreen('migrationVerify'), migrationVerifyController.plans);
router.post('/migrationVerify/run', requireScreen('migrationVerify'), migrationVerifyController.run);
router.post('/migrationVerify/count', requireScreen('migrationVerify'), migrationVerifyController.count);
router.post('/migrationVerify/compile', requireScreen('migrationVerify'), requireSuperAdmin, migrationVerifyController.compile);
router.post('/migrationVerify/excel', requireScreen('migrationVerify'), migrationVerifyController.excel);

export default router;
