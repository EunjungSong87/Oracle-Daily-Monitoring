// 대용량 리스너 로그: 파일 전체를 조금씩(스트림으로) 읽으면서 서버 분석에 쓸 줄만 원래 줄 번호와 함께 남긴다.
// 남기는 줄 = 접속 실패(맨 끝 리턴코드 ≠ 0) 또는 TNS- 오류 — services/logReviewRules.ts의 LISTENER_RULES와
// services/logReview.ts의 detectSuspiciousConnections가 보는 줄과 같은 조건이다 (규칙을 바꾸면 여기도 맞출 것).
// 성공(리턴코드 0) 줄이 대부분이라 GB 단위 파일도 보통 몇 MB로 줄어든다.

const CANDIDATE_RE = /\*\s*[1-9]\d*\s*$|TNS-\d{5}/;

export interface PrefilterResult {
  content: string;
  lineNumbers: number[]; // content의 줄마다 원본 줄 번호 (1부터)
  sourceLines: number; // 원본 전체 줄 수
  droppedForSize: boolean; // 골라낸 줄도 한도를 넘어 앞(오래된) 것을 버림
}

export async function prefilterListenerLog(
  file: File,
  maxBytes: number,
  maxLines: number,
  onProgress?: (ratio: number) => void
): Promise<PrefilterResult> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let kept: string[] = [];
  let numbers: number[] = [];
  let head = 0; // kept[head..]만 유효 (앞에서 버린 것은 가끔 한꺼번에 정리)
  let bytes = 0; // 유효 구간 크기 (리스너 로그는 ASCII라 글자 수 ≈ 바이트 수)
  let lineNo = 0;
  let droppedForSize = false;
  let readChars = 0;
  let rest = '';

  const take = (raw: string) => {
    lineNo++;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!CANDIDATE_RE.test(line)) return;
    kept.push(line);
    numbers.push(lineNo);
    bytes += line.length + 1;
    while (head < kept.length && (bytes > maxBytes || kept.length - head > maxLines)) {
      bytes -= kept[head].length + 1;
      head++;
      droppedForSize = true;
    }
    if (head > 100_000 && head * 2 > kept.length) {
      kept = kept.slice(head);
      numbers = numbers.slice(head);
      head = 0;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    readChars += value.length;
    const parts = (rest + value).split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) take(part);
    onProgress?.(Math.min(readChars / Math.max(file.size, 1), 1));
  }
  if (rest !== '') take(rest);

  return { content: kept.slice(head).join('\n'), lineNumbers: numbers.slice(head), sourceLines: lineNo, droppedForSize };
}
