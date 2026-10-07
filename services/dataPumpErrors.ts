// 사용자가 고칠 수 있는 입력 문제 (컨트롤러가 HTTP 400으로 응답). 필터 모듈과 서비스가 같이 쓰므로 따로 둔다.
export class DataPumpValidationError extends Error {}

export function fail(message: string): never {
  throw new DataPumpValidationError(message);
}
