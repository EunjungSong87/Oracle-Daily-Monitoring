import * as realtimeModel from '../models/realtimeModel';
import type { SessionRow } from '../models/realtimeModel';
import type { DbmsIdParam } from '../models/dbmsModel';

async function getSessions(dbmsid: DbmsIdParam): Promise<SessionRow[]> {
  try {
    return await realtimeModel.getSessions(dbmsid);
  } catch (error) {
    console.error('Service : 실시간 세션 조회 실패:', error);
    throw new Error('실시간 세션 조회 실패', { cause: error });
  }
}

export { getSessions };
