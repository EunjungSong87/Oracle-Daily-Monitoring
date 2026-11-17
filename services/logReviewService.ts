import ExcelJS from 'exceljs';
import { fail } from './dataPumpErrors';
import * as logReview from './logReview';
import type { Finding, Summary } from './logReview';
import { LOG_TYPES, type LogType } from './logReviewRules';

// Maintenance > 로그 업로드 검토. 대상 DB에 접속하지 않고 업로드된 텍스트를 그 요청 안에서만 분석한다 (저장 없음).

// 응답 크기 상한 — 요약 건수는 전체 기준, 목록은 최근(뒤쪽) 것만 남긴다.
export const MAX_FINDINGS = 20_000;

export interface ReviewResult {
  fileName: string;
  logType: LogType;
  truncated: boolean;
  notes: string[];
  lineCount: number;
  summary: Summary;
  findings: Finding[];
}

export interface ReviewOptions {
  clientTruncated?: boolean; // 브라우저가 앞부분을 버리고 보냄
  // 대용량 리스너 로그: 브라우저가 파일 전체를 훑어 실패/TNS 줄만 골라 보낸 경우 — 보낸 줄마다의 원본 줄 번호와 원본 전체 줄 수
  lineNumbers?: number[];
  sourceLines?: number;
}

function review(logType: LogType, fileName: string, content: string, options: ReviewOptions = {}): ReviewResult {
  const { clientTruncated = false, lineNumbers, sourceLines } = options;
  try {
    const limited = logReview.limitText(content);
    // 줄 번호: 골라낸 줄이면 원본 줄 번호 목록(서버가 앞을 더 잘랐으면 그만큼 건너뜀), 아니면 받은 텍스트 기준 + 서버가 버린 줄 수.
    // 브라우저가 앞부분을 잘라 보낸 경우(골라내기 없이)는 원본에서 버린 줄 수를 알 수 없어 받은 구간 기준이 된다.
    const position = lineNumbers ? lineNumbers.slice(limited.lineOffset) : limited.lineOffset;
    const findings = logReview.analyze(logType, limited.text, position);
    const origin = clientTruncated && !lineNumbers ? '읽어 온 구간 기준' : '원본 기준';
    const notes: string[] = [];
    if (lineNumbers) {
      notes.push(
        `큰 리스너 로그라 브라우저가 전체 ${(sourceLines ?? 0).toLocaleString()}줄을 훑어 접속 실패(리턴코드 ≠ 0)·TNS 줄 ${lineNumbers.length.toLocaleString()}줄만 골라 분석했습니다. ` +
          '줄 번호는 원본 기준이고, 전후 줄 보기는 골라낸 줄끼리입니다.'
      );
      if (clientTruncated) notes.push('골라낸 줄도 너무 많아 최근 것만 보냈습니다 (일부만 분석함).');
    } else if (clientTruncated) {
      notes.push('파일이 커서 끝부분(최근 기록) 약 18MB만 분석했습니다 (일부만 분석함). 앞부분을 버린 상태라 줄 번호는 읽어 온 구간의 첫 줄을 1로 센 값입니다.');
    } else if (limited.truncatedBytes) {
      notes.push(`파일이 커서 끝부분(최근 기록) ${logReview.MAX_BYTES / 1024 / 1024}MB만 분석했습니다 (일부만 분석함, 줄 번호는 원본 기준).`);
    }
    if (limited.truncatedLines) notes.push(`줄 수가 많아 마지막 ${logReview.MAX_LINES.toLocaleString()}줄만 분석했습니다 (일부만 분석함, 줄 번호는 ${origin}).`);
    if (findings.length > MAX_FINDINGS) notes.push(`특이사항이 ${findings.length.toLocaleString()}건이라 목록은 마지막(최근) ${MAX_FINDINGS.toLocaleString()}건만 보여줍니다 (요약 건수는 전체 기준).`);
    return {
      fileName,
      logType,
      truncated: clientTruncated || limited.truncatedBytes || limited.truncatedLines,
      notes,
      lineCount: lineNumbers && sourceLines ? sourceLines : limited.lineCount,
      summary: logReview.summarize(findings),
      findings: findings.slice(-MAX_FINDINGS),
    };
  } catch (error) {
    throw new Error('로그 분석 실패', { cause: error });
  }
}

// 화면이 받은 결과를 그대로 다시 보내면 특이사항 목록을 시트 하나로
async function excel(result: ReviewResult): Promise<Buffer> {
  if (!result || !Array.isArray(result.findings) || !LOG_TYPES.includes(result.logType)) fail('검토 결과가 없습니다.');
  try {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('특이사항');
    ws.columns = [
      { header: '줄', key: 'line', width: 8 },
      { header: '시각', key: 'time', width: 20 },
      { header: '심각도', key: 'severity', width: 10 },
      { header: '카테고리', key: 'category', width: 12 },
      { header: '내용', key: 'label', width: 50 },
      { header: '원문', key: 'text', width: 100 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRows(
      result.findings.map((finding) => ({
        line: finding.line,
        time: finding.time ?? '',
        severity: finding.severity,
        category: finding.category,
        label: finding.label,
        text: finding.synthetic ? finding.context.join('\n') : finding.text,
      }))
    );
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    return Buffer.from(await workbook.xlsx.writeBuffer());
  } catch (error) {
    throw new Error('로그 검토 엑셀 생성 실패', { cause: error });
  }
}

export { review, excel };
