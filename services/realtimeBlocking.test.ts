import { describe, expect, it } from 'vitest';
import { buildBlockingTree, killDisabledReason, type BlockingSession } from './realtimeBlocking';

function s(instId: number, sid: number, over: Partial<BlockingSession> = {}): BlockingSession {
  return {
    instId,
    sid,
    serial: sid * 10,
    username: 'APP',
    machine: 'm',
    program: 'p',
    sqlId: null,
    event: null,
    status: 'ACTIVE',
    type: 'USER',
    waitSec: null,
    blockingInstance: null,
    blockingSession: null,
    rowWaitObj: null,
    objectName: null,
    ...over,
  };
}

describe('buildBlockingTree', () => {
  it('최상위 블로커 → 대기자 → 그 대기자의 대기자, RAC 인스턴스 구분', () => {
    const waiters = [
      s(1, 20, { blockingInstance: 2, blockingSession: 10, waitSec: 30 }),
      s(1, 30, { blockingInstance: 1, blockingSession: 20, waitSec: 90 }),
      s(2, 40, { blockingInstance: 2, blockingSession: 10, waitSec: 5 }),
    ];
    const roots = buildBlockingTree(waiters, [s(2, 10, { status: 'INACTIVE' })]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ instId: 2, sid: 10, blockedSec: 90, waiterCount: 3 });
    expect(roots[0].waiters.map((w) => `${w.instId}:${w.sid}`)).toEqual(['1:20', '2:40']);
    expect(roots[0].waiters[0].waiters[0]).toMatchObject({ instId: 1, sid: 30 });
  });

  it('같은 SID라도 인스턴스가 다르면 다른 세션', () => {
    const roots = buildBlockingTree([s(2, 10, { blockingInstance: 1, blockingSession: 10, waitSec: 1 })], [s(1, 10)]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ instId: 1, sid: 10 });
    expect(roots[0].waiters[0]).toMatchObject({ instId: 2, sid: 10 });
  });

  it('블로커 정보를 못 읽었으면 자리만 남기고 대기자는 그 아래에', () => {
    const roots = buildBlockingTree([s(1, 20, { blockingInstance: 1, blockingSession: 99, waitSec: 3 })], []);
    expect(roots[0]).toMatchObject({ instId: 1, sid: 99, program: '(세션 정보 없음)', killDisabled: '백그라운드 프로세스' });
    expect(roots[0].waiters).toHaveLength(1);
  });

  it('순환이어도 무한 루프 없이 하나를 최상위로', () => {
    const roots = buildBlockingTree(
      [s(1, 1, { blockingInstance: 1, blockingSession: 2, waitSec: 4 }), s(1, 2, { blockingInstance: 1, blockingSession: 1, waitSec: 7 })],
      []
    );
    expect(roots).toHaveLength(1);
    expect(roots[0].waiterCount).toBe(1);
  });

  it('여러 블로커는 오래 막은 순', () => {
    const roots = buildBlockingTree(
      [s(1, 2, { blockingInstance: 1, blockingSession: 1, waitSec: 10 }), s(1, 4, { blockingInstance: 1, blockingSession: 3, waitSec: 100 })],
      [s(1, 1), s(1, 3)]
    );
    expect(roots.map((r) => r.sid)).toEqual([3, 1]);
  });
});

describe('killDisabledReason', () => {
  it('백그라운드와 SYS는 막는다', () => {
    expect(killDisabledReason({ type: 'BACKGROUND', username: null })).toBe('백그라운드 프로세스');
    expect(killDisabledReason({ type: 'USER', username: null })).toBe('백그라운드 프로세스');
    expect(killDisabledReason({ type: 'USER', username: 'sys' })).toBe('SYS 세션');
    expect(killDisabledReason({ type: 'USER', username: 'SYSTEM' })).toBeNull();
  });
});
