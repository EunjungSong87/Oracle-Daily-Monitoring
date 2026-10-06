import { describe, expect, it } from 'vitest';
import { SCREENS, resolveVisible, screenForPage } from './screenAccessService';

describe('resolveVisible', () => {
  it('역할 기본값: VIEWER < DBA < SUPER_ADMIN', () => {
    const viewer = resolveVisible('VIEWER', new Map());
    expect(viewer).toContain('realtime');
    expect(viewer).not.toContain('tableSpec');
    expect(viewer).not.toContain('dataPump');

    const dba = resolveVisible('DBA', new Map());
    expect(dba).toContain('tableSpec');
    expect(dba).not.toContain('dataPump');

    expect(resolveVisible('SUPER_ADMIN', new Map())).toHaveLength(SCREENS.length);
  });

  it('사용자별 예외: 숨김과 역할 위로 보이게', () => {
    const visible = resolveVisible(
      'VIEWER',
      new Map([
        ['issues', false],
        ['dataPump', true],
      ])
    );
    expect(visible).not.toContain('issues');
    expect(visible).toContain('dataPump');
    expect(visible).toContain('databases');
  });

  it('결과는 메뉴 순서 (첫 번째가 돌려보낼 화면)', () => {
    const visible = resolveVisible('VIEWER', new Map([['databases', false]]));
    expect(visible[0]).toBe('dailyMonitoring');
  });

  it('역할 정보가 없으면 예외로 연 화면만', () => {
    expect(resolveVisible(undefined, new Map([['history', true]]))).toEqual(['history']);
  });
});

describe('screenForPage', () => {
  it('페이지 경로 → 화면 (루트는 Databases, 화면 아닌 파일은 null)', () => {
    expect(screenForPage('/')).toBe('databases');
    expect(screenForPage('/dataPump.html')).toBe('dataPump');
    expect(screenForPage('/monitoringScript.html')).toBe('scripts');
    expect(screenForPage('/users.html')).toBeNull();
    expect(screenForPage('/assets/pages/dataPump.js')).toBeNull();
  });
});
