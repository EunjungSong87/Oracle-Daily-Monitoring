// 사용자가 고칠 수 있는 입력 문제 (컨트롤러가 HTTP 400으로 응답). 필터 모듈과 서비스가 같이 쓰므로 따로 둔다.
// items: 빠진/중복된 항목 전체 목록 — 화면이 메시지와 함께 스크롤·복사할 수 있게 보여 준다 (메시지에는 앞부분만).
export class DataPumpValidationError extends Error {
  readonly items: string[];
  constructor(message: string, items: string[] = []) {
    super(message);
    this.items = items;
  }
}

export function fail(message: string, items: string[] = []): never {
  throw new DataPumpValidationError(message, items);
}
