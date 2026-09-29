import * as statsJobModel from '../models/statsJobModel';
import type { JobStatus, StaleStatsRow } from '../models/statsJobModel';
import type { DbmsIdParam } from '../models/dbmsModel';

async function getJobStatus(dbmsid: DbmsIdParam): Promise<JobStatus[]> {
  try {
    return await statsJobModel.getJobStatus(dbmsid);
  } catch (error) {
    throw new Error('통계 잡 현황 조회 실패', { cause: error });
  }
}

async function getStaleStats(dbmsid: DbmsIdParam, thresholdDays: number): Promise<StaleStatsRow[]> {
  try {
    return await statsJobModel.getStaleStats(dbmsid, thresholdDays);
  } catch (error) {
    throw new Error('통계 미수집 테이블 조회 실패', { cause: error });
  }
}

async function runJob(dbmsid: DbmsIdParam, jobName: string): Promise<void> {
  try {
    await statsJobModel.runJob(dbmsid, jobName);
  } catch (error) {
    throw new Error('통계 잡 수동 실행 실패', { cause: error });
  }
}

export { getJobStatus, getStaleStats, runJob };
