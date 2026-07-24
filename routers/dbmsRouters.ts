import express from 'express';
import * as dbmsController from '../controllers/dbmsController'; // 컨트롤러 가져오기

const router = express.Router();

// 모든 DBMS 조회 (GET 요청)
router.get('/dbmslist', dbmsController.getAllDbmses); // api/dbmslist 엔드포인드 생성
router.get('/scriptlist', dbmsController.getScripts);
router.post('/dbmslist/monResult', dbmsController.getMonResult);
router.post('/addDbms', dbmsController.addDbms);
router.post('/modifyDbms', dbmsController.modifyDbms);
router.post('/deleteDbms', dbmsController.deleteDbms);
router.post('/getSqlText', dbmsController.getSqlText);
router.post('/modifyScript', dbmsController.modifyScript);
router.post('/addScript', dbmsController.addScript);
router.post('/deleteScript', dbmsController.deleteScript);
router.get('/thresholdlist', dbmsController.getThresholds);
router.post('/addThreshold', dbmsController.addThreshold);
router.post('/modifyThreshold', dbmsController.modifyThreshold);
router.post('/deleteThreshold', dbmsController.deleteThreshold);
router.get('/schedule', dbmsController.getScheduleConfig);
router.post('/schedule', dbmsController.saveScheduleConfig);
router.post('/history/list', dbmsController.getRunHistoryList);
router.post('/history/detail', dbmsController.getRunHistoryDetail);
export default router; // 라우터 내보내기
