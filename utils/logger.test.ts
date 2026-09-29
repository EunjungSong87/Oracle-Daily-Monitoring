import { describe, expect, it } from 'vitest';
import { describeError } from './logger';

describe('describeError', () => {
  it('cause 체인을 바깥 ← 안쪽 순으로 잇는다', () => {
    const root = new Error('ORA-12514: TNS:listener does not currently know of service');
    const wrapped = new Error('대상 DB 접속 실패', { cause: root });
    expect(describeError(wrapped, '점검 실행 오류').chain).toBe(
      '대상 DB 접속 실패 ← ORA-12514: TNS:listener does not currently know of service'
    );
  });

  it('로그 메시지와 같은 문구는 체인에서 뺀다', () => {
    const wrapped = new Error('DBMS 목록 조회 실패', { cause: new Error('ORA-00942: table or view does not exist') });
    expect(describeError(wrapped, 'DBMS 목록 조회 실패').chain).toBe('ORA-00942: table or view does not exist');
  });

  it('근본 원인이 Oracle 에러면 스택을 붙이지 않는다', () => {
    const wrapped = new Error('조회 실패', { cause: new Error('NJS-500: connection to the Oracle Database was broken') });
    expect(describeError(wrapped, 'x').stack).toBeUndefined();
  });

  it('근본 원인이 Oracle 에러가 아니면(= 코드 버그 가능성) 스택을 붙인다', () => {
    const wrapped = new Error('조회 실패', { cause: new TypeError("Cannot read properties of undefined (reading 'rows')") });
    expect(describeError(wrapped, 'x').stack).toContain('TypeError');
  });

  it('Error가 아닌 값도 처리한다', () => {
    expect(describeError('문자열 에러', 'x').chain).toBe('문자열 에러');
  });
});
