import * as realtimeModel from '../models/realtimeModel';
import type { RealtimeSnapshot, SessionDetailResult, TimeRange } from '../models/realtimeModel';
import type { DbmsIdParam } from '../models/dbmsModel';

async function getSnapshot(dbmsid: DbmsIdParam, since: string | null): Promise<RealtimeSnapshot> {
  try {
    return await realtimeModel.getSnapshot(dbmsid, since);
  } catch (error) {
    throw new Error('실시간 세션 조회 실패', { cause: error });
  }
}

async function getSessionDetail(
  dbmsid: DbmsIdParam,
  sid: number,
  serial: number | null,
  sqlId: string | null,
  range: TimeRange | null
): Promise<SessionDetailResult> {
  try {
    return await realtimeModel.getSessionDetail(dbmsid, sid, serial, sqlId, range);
  } catch (error) {
    throw new Error('세션 상세 조회 실패', { cause: error });
  }
}

export { getSnapshot, getSessionDetail };
