import { logger } from '../utils/logger';
import type { Request, Response } from 'express';
import * as ilmJobService from '../services/ilmJobService';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getPartitionRetentionList(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbmsid } = req.body;
    if (!dbmsid) {
      return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    }
    const rows = await ilmJobService.getPartitionRetentionList({ dbmsid });
    res.status(200).json(rows);
  } catch (error) {
    logger.error('ILM', '파티션 보관주기(ILM) 목록 조회 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

// 정책성 컬럼만 수정합니다 (모델 쪽 PartitionRetentionUpdate 주석 참고). 대상 테이블이
// 존재하지 않아 0건 반영되는 경우도 있을 수 있어, 잡 수동실행과 동일하게 200 + {success,message}로
// 응답하고 실패 사유를 그대로 클라이언트에 전달합니다.
async function updatePartitionRetention(req: Request, res: Response): Promise<Response | void> {
  try {
    const { dbmsid, tableOwner, tableName, comments, workGroup, deleteCycle, status, oggSyncYn, memo } = req.body;
    if (!dbmsid || !tableOwner || !tableName) {
      return res.status(400).json({ message: 'dbmsid, tableOwner, tableName 정보가 필요합니다.' });
    }
    const rowsAffected = await ilmJobService.updatePartitionRetention({
      dbmsid,
      tableOwner,
      tableName,
      comments: comments ?? null,
      workGroup: workGroup ?? null,
      deleteCycle: deleteCycle ?? null,
      status: status ?? null,
      oggSyncYn: oggSyncYn ?? null,
      memo: memo ?? null,
    });
    if (rowsAffected === 0) {
      return res.status(200).json({ success: false, message: '대상 행을 찾을 수 없습니다.' });
    }
    res.status(200).json({ success: true, message: '수정되었습니다.' });
  } catch (error) {
    logger.error('ILM', '파티션 보관주기(ILM) 수정 오류', error);
    res.status(200).json({ success: false, message: errMsg(error) });
  }
}

// 신규 등록. TABLE_OWNER+TABLE_NAME 중복은 모델에서 걸러 에러를 던지므로, 서버 오류와
// 구분 없이 동일하게 {success:false, message}로 알려줍니다.
async function addPartitionRetention(req: Request, res: Response): Promise<Response | void> {
  try {
    const {
      dbmsid,
      tableOwner,
      tableName,
      comments,
      workGroup,
      stdColumn,
      startHighvalue,
      endHighvalue,
      deleteCycle,
      rangeType,
      partitionYn,
      partitionType,
      oggSyncYn,
      status,
      stdDate,
      memo,
    } = req.body;
    if (!dbmsid || !tableOwner || !tableName) {
      return res.status(400).json({ message: 'dbmsid, tableOwner, tableName 정보가 필요합니다.' });
    }
    await ilmJobService.addPartitionRetention({
      dbmsid,
      tableOwner,
      tableName,
      comments: comments ?? null,
      workGroup: workGroup ?? null,
      stdColumn: stdColumn ?? null,
      startHighvalue: startHighvalue ?? null,
      endHighvalue: endHighvalue ?? null,
      deleteCycle: deleteCycle ?? null,
      rangeType: rangeType ?? null,
      partitionYn: partitionYn ?? null,
      partitionType: partitionType ?? null,
      oggSyncYn: oggSyncYn ?? null,
      status: status ?? null,
      stdDate: stdDate ?? null,
      memo: memo ?? null,
    });
    res.status(200).json({ success: true, message: '등록되었습니다.' });
  } catch (error) {
    logger.error('ILM', '파티션 보관주기(ILM) 등록 오류', error);
    res.status(200).json({ success: false, message: errMsg(error) });
  }
}

export { getPartitionRetentionList, updatePartitionRetention, addPartitionRetention };
