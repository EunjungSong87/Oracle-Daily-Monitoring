import express from 'express';
import * as dashboardController from '../controllers/dashboardController';
import { requireDba, requireScreen } from '../middleware/auth';

const router = express.Router();

// Dashboard (첫 화면) / Capacity — 메타데이터 DB만 읽는다
router.get('/dashboard', requireScreen('dashboard'), dashboardController.getDashboard);
router.post('/capacity', requireScreen('capacity'), dashboardController.getCapacity);
router.post('/capacity/trend', requireScreen('capacity'), dashboardController.getCapacityTrend);
router.post('/capacity/config', requireScreen('capacity'), requireDba, dashboardController.saveCapacityConfig);

export default router;
