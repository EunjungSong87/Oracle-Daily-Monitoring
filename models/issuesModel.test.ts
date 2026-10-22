import { describe, expect, it } from 'vitest';
import { autoResolveTargets } from './issuesModel';

// 자동 해제는 "이번 실행에서 실제로 성공적으로 돈 태스크"의 티켓만 대상으로 한다.
// 이전에는 DB의 열린 티켓 전부가 대상이라, 용량 예측(예약 점검에만 붙는 태스크) 티켓이 수동 점검 때 풀리고,
// 실패한 태스크(쿼리 오류·타임아웃)의 티켓도 "더 이상 감지되지 않음"으로 풀렸다.
describe('autoResolveTargets', () => {
  const existing = new Map([
    ['1:USED', { id: 11, status: 'OPEN' }],
    ['2:STATUS', { id: 12, status: 'ACKNOWLEDGED' }],
    ['-100:TS:USERS', { id: 13, status: 'OPEN' }],
    ['3:X', { id: 14, status: 'RESOLVED' }],
  ]);

  it('성공한 태스크의 사라진 위반만 해제', () => {
    const results = [
      { task_id: 1, success: true, rows: [] },
      { task_id: 2, success: false, rows: [] },
    ];
    expect(autoResolveTargets(existing, new Set(), results)).toEqual([11]);
  });

  it('여전히 감지되는 것은 해제하지 않음', () => {
    expect(autoResolveTargets(existing, new Set(['1:USED']), [{ task_id: 1, success: true }])).toEqual([]);
  });

  it('용량 예측 태스크가 있는 실행에서만 그 티켓을 해제', () => {
    expect(autoResolveTargets(existing, new Set(), [{ task_id: -100, success: true }])).toEqual([13]);
  });
});
