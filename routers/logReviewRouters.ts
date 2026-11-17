import express from 'express';
import * as logReviewController from '../controllers/logReviewController';
import { requireScreen } from '../middleware/auth';

const router = express.Router();

// Maintenance > 로그 업로드 검토 (기본 VIEWER 화면, DB 접속 없음 — 업로드한 텍스트만 분석, 저장 안 함)
router.post('/logReview/analyze', requireScreen('logReview'), logReviewController.analyze);
router.post('/logReview/excel', requireScreen('logReview'), logReviewController.excel);

export default router;
