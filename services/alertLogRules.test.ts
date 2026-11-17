import { describe, expect, it } from 'vitest';
import { escapeLike, extractOraCode, normalizeOraCode, parseSearchParams, toSamples, truncateBytes } from './alertLogRules';

describe('ORA 코드', () => {
  it('메시지에서 첫 ORA 코드만', () => {
    expect(extractOraCode('ORA-00600: internal error, ORA-07445')).toBe('ORA-00600');
    expect(extractOraCode('Archiver FAILED')).toBeNull();
  });

  it('검색 입력 정규화', () => {
    expect(normalizeOraCode('600')).toBe('ORA-00600');
    expect(normalizeOraCode(' ora-1555 ')).toBe('ORA-01555');
    expect(normalizeOraCode('ORA12514')).toBe('ORA-12514');
    expect(normalizeOraCode('')).toBeNull();
    expect(normalizeOraCode('abc')).toBeUndefined();
  });

  it('LIKE 와일드카드 이스케이프', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});

describe('parseSearchParams', () => {
  const base = { fromDate: '2026-11-01', toDate: '2026-11-07' };

  it('기본값: 전체 DB, limit 200, offset 0', () => {
    expect(parseSearchParams(base)).toEqual({ ok: true, params: { dbmsId: null, ...base, oraCode: null, keyword: null, limit: 200, offset: 0 } });
  });

  it('날짜 형식/순서/최대 기간 검증', () => {
    expect(parseSearchParams({ fromDate: '2026-02-30', toDate: '2026-03-01' }).ok).toBe(false);
    expect(parseSearchParams({ fromDate: '2026-11-08', toDate: '2026-11-07' }).ok).toBe(false);
    expect(parseSearchParams({ fromDate: '2025-01-01', toDate: '2026-11-07' }).ok).toBe(false);
    expect(parseSearchParams({ fromDate: '2025-11-08', toDate: '2026-11-07' }).ok).toBe(true);
  });

  it('limit 상한 5000, 잘못된 DB/ORA 코드는 거부', () => {
    expect(parseSearchParams({ ...base, limit: 5001 }).ok).toBe(false);
    expect(parseSearchParams({ ...base, limit: 5000 }).ok).toBe(true);
    expect(parseSearchParams({ ...base, dbmsId: 'x' }).ok).toBe(false);
    expect(parseSearchParams({ ...base, oraCode: 'ORA-X' }).ok).toBe(false);
  });
});

describe('toSamples', () => {
  it('같은 시각+메시지는 하나만, 해시는 원문 기준', () => {
    const entry = { logTime: '2026-11-12 10:00:00', messageText: 'ORA-00600' };
    const samples = toSamples([entry, { ...entry }, { ...entry, logTime: '2026-11-12 10:00:01' }]);
    expect(samples).toHaveLength(2);
    expect(samples[0].msgHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('4000바이트 초과는 멀티바이트 글자 경계에서 자름', () => {
    const text = '가'.repeat(1500); // 4500 bytes
    const cut = truncateBytes(text);
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(4000);
    expect(cut).toBe('가'.repeat(1333));
  });
});
