import * as historyModel from '../models/historyModel';
import type { RunHistorySummary, RunHistoryDetail } from '../models/historyModel';

async function listRunHistory(dbmsId: number | string, fromDate?: string, toDate?: string): Promise<RunHistorySummary[]> {
  try {
    return await historyModel.listRunHistory(dbmsId, fromDate, toDate);
  } catch (error) {
    console.error('Service : 실행 이력 목록 조회 실패:', error);
    throw new Error('실행 이력 목록 조회 실패', { cause: error });
  }
}

async function getRunHistoryDetail(id: number | string): Promise<RunHistoryDetail | null> {
  try {
    return await historyModel.getRunHistoryDetail(id);
  } catch (error) {
    console.error('Service : 실행 이력 상세 조회 실패:', error);
    throw new Error('실행 이력 상세 조회 실패', { cause: error });
  }
}

export { listRunHistory, getRunHistoryDetail };
