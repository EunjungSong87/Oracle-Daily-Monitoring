import * as ilmJobModel from '../models/ilmJobModel';
import type { PartitionRetentionRow, PartitionRetentionUpdate, PartitionRetentionAdd } from '../models/ilmJobModel';
import type { DbmsIdParam } from '../models/dbmsModel';

async function getPartitionRetentionList(dbmsid: DbmsIdParam): Promise<PartitionRetentionRow[]> {
  try {
    return await ilmJobModel.getPartitionRetentionList(dbmsid);
  } catch (error) {
    console.error('Service : 파티션 보관주기(ILM) 목록 조회 실패:', error);
    throw new Error('파티션 보관주기(ILM) 목록 조회 실패', { cause: error });
  }
}

async function updatePartitionRetention(input: PartitionRetentionUpdate): Promise<number> {
  try {
    return await ilmJobModel.updatePartitionRetention(input);
  } catch (error) {
    console.error('Service : 파티션 보관주기(ILM) 수정 실패:', error);
    throw new Error('파티션 보관주기(ILM) 수정 실패', { cause: error });
  }
}

async function addPartitionRetention(input: PartitionRetentionAdd): Promise<number> {
  try {
    return await ilmJobModel.addPartitionRetention(input);
  } catch (error) {
    console.error('Service : 파티션 보관주기(ILM) 등록 실패:', error);
    throw new Error('파티션 보관주기(ILM) 등록 실패', { cause: error });
  }
}

export { getPartitionRetentionList, updatePartitionRetention, addPartitionRetention };
