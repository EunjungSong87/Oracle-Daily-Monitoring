import express from 'express';
import * as dbmsController from '../controllers/dbmsController'; // 컨트롤러 가져오기
import { requireDba } from '../middleware/auth';

const router = express.Router();

// 모든 DBMS 조회 (GET 요청)
router.get('/dbmslist', dbmsController.getAllDbmses); // api/dbmslist 엔드포인드 생성
router.get('/scriptlist', dbmsController.getScripts);
router.post('/dbmslist/monResult', dbmsController.getMonResult);
// DBMS 등록/수정/삭제, Scripts/Thresholds 변경, 예약실행 설정 저장은 DBA 이상만.
// 조회(GET)와 수동 점검 실행(RUN), Issues 티켓 처리는 로그인한 사용자 누구나 가능합니다.
router.post('/addDbms', requireDba, dbmsController.addDbms);
router.post('/modifyDbms', requireDba, dbmsController.modifyDbms);
router.post('/deleteDbms', requireDba, dbmsController.deleteDbms);
router.post('/testDbmsConnection', requireDba, dbmsController.testDbmsConnection);
router.post('/getSqlText', dbmsController.getSqlText);
router.post('/modifyScript', requireDba, dbmsController.modifyScript);
router.post('/addScript', requireDba, dbmsController.addScript);
router.post('/deleteScript', requireDba, dbmsController.deleteScript);
router.get('/thresholdlist', dbmsController.getThresholds);
router.post('/addThreshold', requireDba, dbmsController.addThreshold);
router.post('/modifyThreshold', requireDba, dbmsController.modifyThreshold);
router.post('/deleteThreshold', requireDba, dbmsController.deleteThreshold);
router.get('/schedule', dbmsController.getScheduleConfig);
router.post('/schedule', requireDba, dbmsController.saveScheduleConfig);
router.post('/history/list', dbmsController.getRunHistoryList);
router.post('/history/detail', dbmsController.getRunHistoryDetail);
router.get('/issues', dbmsController.listIssues);
router.post('/issues/detail', dbmsController.getIssueDetail);
router.post('/issues/acknowledge', dbmsController.acknowledgeIssue);
router.post('/issues/resolve', dbmsController.resolveIssue);
router.post('/issues/reopen', dbmsController.reopenIssue);
router.post('/issues/assign', dbmsController.assignIssue);
router.post('/issues/comment', dbmsController.addIssueComment);
export default router; // 라우터 내보내기
