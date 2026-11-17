import type { Request, Response } from 'express';
import { DataPumpValidationError } from '../services/dataPumpErrors';
import * as logReviewService from '../services/logReviewService';
import { LOG_TYPES, type LogType } from '../services/logReviewRules';
import { MAX_BYTES, validateLineNumbers } from '../services/logReview';
import { logger } from '../utils/logger';

// Maintenance > 로그 업로드 검토 — DB 접속 없음.
// 로그 원문(content)은 세션 정보·내부 IP 등이 섞여 있을 수 있어 절대 로그에 남기지 않는다 (파일명/크기만).

async function analyze(req: Request, res: Response): Promise<void> {
  const { logType, fileName, content, clientTruncated, lineNumbers, sourceLines } = req.body ?? {};
  if (!LOG_TYPES.includes(logType)) {
    res.status(400).json({ message: '로그 종류(ALERT / LISTENER / CRS)를 골라주세요.' });
    return;
  }
  if (typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ message: '검토할 로그 내용이 없습니다.' });
    return;
  }
  // 요청 크기는 server.ts의 bodyParser(20mb)가 먼저 막고, 그 안에서 MAX_BYTES를 넘으면 서비스가 끝부분(최근)만 분석한다.
  // 그보다 훨씬 큰 값(문자 수 기준 2배 초과)은 비정상 요청으로 보고 거부.
  if (content.length > MAX_BYTES * 2) {
    res.status(400).json({ message: '로그가 너무 큽니다.' });
    return;
  }
  // 대용량 리스너 로그를 브라우저가 골라 보낸 경우: 줄마다의 원본 줄 번호
  if (lineNumbers !== undefined) {
    const problem = validateLineNumbers(content, lineNumbers, sourceLines);
    if (problem) {
      res.status(400).json({ message: problem });
      return;
    }
  }
  const name = typeof fileName === 'string' && fileName.trim() ? fileName.trim().slice(0, 255) : '붙여넣은 텍스트';
  try {
    res.json(
      logReviewService.review(logType as LogType, name, content, {
        clientTruncated: clientTruncated === true,
        ...(lineNumbers !== undefined ? { lineNumbers: lineNumbers as number[], sourceLines: Number(sourceLines) } : {}),
      })
    );
  } catch (error) {
    logger.error('LogReview', `로그 검토 오류 (${logType}, ${name}, ${content.length}자)`, error);
    res.status(500).json({ message: '로그를 분석하지 못했습니다.' });
  }
}

async function excel(req: Request, res: Response): Promise<void> {
  try {
    const buffer = await logReviewService.excel(req.body?.result);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="log_review_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    if (error instanceof DataPumpValidationError) {
      res.status(400).json({ message: error.message });
      return;
    }
    logger.error('LogReview', '로그 검토 엑셀 오류', error);
    res.status(500).json({ message: '엑셀을 만들지 못했습니다.' });
  }
}

export { analyze, excel };
