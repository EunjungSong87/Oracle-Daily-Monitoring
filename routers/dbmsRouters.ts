import express from 'express';
import * as dbmsController from '../controllers/dbmsController'; // 컨트롤러 가져오기
import { requireDba, requireScreen } from '../middleware/auth';

const router = express.Router();

// 화면별 API는 그 화면이 보이는 사용자만 (역할 기본 + 계정 관리의 사용자별 예외, services/screenAccessService.ts).
// 그중 변경(DBMS 등록/수정/삭제, Scripts/Thresholds 변경, 예약 실행 설정 저장)은 화면이 보여도 DBA 이상만.
// DBMS 목록은 거의 모든 화면이 DB 선택용으로 쓰므로 로그인한 사용자 누구나.
router.get('/dbmslist', dbmsController.getAllDbmses);

// Databases
router.post('/addDbms', requireScreen('databases'), requireDba, dbmsController.addDbms);
router.post('/modifyDbms', requireScreen('databases'), requireDba, dbmsController.modifyDbms);
router.post('/deleteDbms', requireScreen('databases'), requireDba, dbmsController.deleteDbms);
router.post('/testDbmsConnection', requireScreen('databases'), requireDba, dbmsController.testDbmsConnection);

// Daily Monitoring (수동 점검 실행, 예약 실행 설정)
router.post('/dbmslist/monResult', requireScreen('dailyMonitoring'), dbmsController.getMonResult);
router.get('/schedule', requireScreen('dailyMonitoring'), dbmsController.getScheduleConfig);
router.post('/schedule', requireScreen('dailyMonitoring'), requireDba, dbmsController.saveScheduleConfig);

// Scripts (스크립트 목록은 Thresholds 화면도 씀)
router.get('/scriptlist', requireScreen('scripts', 'thresholds'), dbmsController.getScripts);
router.post('/getSqlText', requireScreen('scripts'), dbmsController.getSqlText);
router.post('/modifyScript', requireScreen('scripts'), requireDba, dbmsController.modifyScript);
router.post('/addScript', requireScreen('scripts'), requireDba, dbmsController.addScript);
router.post('/deleteScript', requireScreen('scripts'), requireDba, dbmsController.deleteScript);

// Thresholds
router.get('/thresholdlist', requireScreen('thresholds'), dbmsController.getThresholds);
router.post('/addThreshold', requireScreen('thresholds'), requireDba, dbmsController.addThreshold);
router.post('/modifyThreshold', requireScreen('thresholds'), requireDba, dbmsController.modifyThreshold);
router.post('/deleteThreshold', requireScreen('thresholds'), requireDba, dbmsController.deleteThreshold);

// Run History
router.post('/history/list', requireScreen('history'), dbmsController.getRunHistoryList);
router.post('/history/detail', requireScreen('history'), dbmsController.getRunHistoryDetail);

// Issues (티켓 처리는 화면이 보이면 역할 무관)
router.get('/issues', requireScreen('issues'), dbmsController.listIssues);
router.post('/issues/detail', requireScreen('issues'), dbmsController.getIssueDetail);
router.post('/issues/acknowledge', requireScreen('issues'), dbmsController.acknowledgeIssue);
router.post('/issues/resolve', requireScreen('issues'), dbmsController.resolveIssue);
router.post('/issues/reopen', requireScreen('issues'), dbmsController.reopenIssue);
router.post('/issues/assign', requireScreen('issues'), dbmsController.assignIssue);
router.post('/issues/comment', requireScreen('issues'), dbmsController.addIssueComment);
export default router; // 라우터 내보내기
