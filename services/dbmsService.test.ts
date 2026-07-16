import { describe, it, expect } from 'vitest';
import { evaluateThreshold, applyThresholds } from './dbmsService';

describe('evaluateThreshold', () => {
  it('NUMERIC: > 연산자로 임계치 초과를 감지한다', () => {
    expect(evaluateThreshold(95, 'NUMERIC', '>', '90')).toBe(true);
    expect(evaluateThreshold(85, 'NUMERIC', '>', '90')).toBe(false);
  });

  it('NUMERIC: 값에 %나 단위 텍스트가 섞여 있어도 숫자만 뽑아 비교한다', () => {
    expect(evaluateThreshold('95%', 'NUMERIC', '>', '90')).toBe(true);
  });

  it('NUMERIC: <, >=, <=, =, != 연산자를 지원한다', () => {
    expect(evaluateThreshold(80, 'NUMERIC', '<', '90')).toBe(true);
    expect(evaluateThreshold(90, 'NUMERIC', '>=', '90')).toBe(true);
    expect(evaluateThreshold(90, 'NUMERIC', '<=', '90')).toBe(true);
    expect(evaluateThreshold(90, 'NUMERIC', '=', '90')).toBe(true);
    expect(evaluateThreshold(90, 'NUMERIC', '!=', '90')).toBe(false);
  });

  it('STRING: = / != 연산자로 정확히 일치하는지 비교한다', () => {
    expect(evaluateThreshold('OPEN', 'STRING', '!=', 'OPEN')).toBe(false);
    expect(evaluateThreshold('MOUNTED', 'STRING', '!=', 'OPEN')).toBe(true);
    expect(evaluateThreshold('FAILED', 'STRING', '=', 'FAILED')).toBe(true);
  });

  it('PATTERN: 문자열 포함 여부를 확인한다', () => {
    expect(evaluateThreshold('<= CHECK!', 'PATTERN', 'LIKE', 'CHECK')).toBe(true);
    expect(evaluateThreshold('', 'PATTERN', 'LIKE', 'CHECK')).toBe(false);
  });

  it('값이 null/undefined면 항상 false를 반환한다', () => {
    expect(evaluateThreshold(null, 'NUMERIC', '>', '90')).toBe(false);
    expect(evaluateThreshold(undefined, 'STRING', '!=', 'OPEN')).toBe(false);
  });

  it('알 수 없는 조건 유형/연산자는 false를 반환한다', () => {
    expect(evaluateThreshold(95, 'UNKNOWN_TYPE', '>', '90')).toBe(false);
    expect(evaluateThreshold(95, 'NUMERIC', '~=', '90')).toBe(false);
  });
});

describe('applyThresholds', () => {
  const rows = [
    { 'USED(%)': 95, TABLESPACE_NAME: 'USERS' },
    { 'USED(%)': 50, TABLESPACE_NAME: 'SYSTEM' },
  ];

  it('임계치가 없으면 원본 rows를 그대로 반환한다', () => {
    expect(applyThresholds(rows, undefined)).toBe(rows);
    expect(applyThresholds(rows, [])).toBe(rows);
  });

  it('임계치를 위반한 row에만 _alerts를 붙인다', () => {
    const thresholds = [
      { COLUMN_NAME: 'USED(%)', CONDITION_TYPE: 'NUMERIC', OPERATOR: '>', THRESHOLD: '90', CLEVEL: 'WARN', MESSAGE: '사용률 초과' },
    ];

    const result = applyThresholds(rows, thresholds);

    expect(result[0]._alerts).toEqual({
      'USED(%)': { level: 'WARN', message: '사용률 초과' },
    });
    expect(result[1]._alerts).toBeUndefined();
  });

  it('원본 row 객체를 변형하지 않는다(불변)', () => {
    const thresholds = [
      { COLUMN_NAME: 'USED(%)', CONDITION_TYPE: 'NUMERIC', OPERATOR: '>', THRESHOLD: '90', CLEVEL: 'WARN' },
    ];

    applyThresholds(rows, thresholds);

    expect(rows[0]).not.toHaveProperty('_alerts');
  });
});
