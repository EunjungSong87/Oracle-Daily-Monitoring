import express from 'express';
import * as alertLogController from '../controllers/alertLogController';
import { requireDba, requireScreen } from '../middleware/auth';

const router = express.Router();

// Monitoring > Alert Log (기본 VIEWER 화면, 메타데이터 DB만 읽음). 보관 기간 변경만 DBA 이상.
router.post('/alertLog/search', requireScreen('alertLog'), alertLogController.search);
router.post('/alertLog/trend', requireScreen('alertLog'), alertLogController.trend);
router.get('/alertLog/config', requireScreen('alertLog'), alertLogController.getConfig);
router.post('/alertLog/config', requireScreen('alertLog'), requireDba, alertLogController.saveConfig);

export default router;
