import { describe, it, expect } from 'vitest';
import { withConnectTimeouts, isConnectionBreakError, classifyTargetError } from './targetDbTimeouts';

function oraErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const BROKEN = oraErr('NJS-500', 'NJS-500: connection to the Oracle Database was broken');

describe('withConnectTimeouts', () => {
  it('appends Easy Connect Plus params with ?', () => {
    expect(withConnectTimeouts('10.0.0.1:1521/ORCL', 10, 5)).toBe('10.0.0.1:1521/ORCL?connect_timeout=10&transport_connect_timeout=5');
  });

  it('continues with & when the string already has params', () => {
    expect(withConnectTimeouts('host:1521/ORCL?expire_time=2', 10, 5)).toBe(
      'host:1521/ORCL?expire_time=2&connect_timeout=10&transport_connect_timeout=5'
    );
  });

  it('omits params set to 0', () => {
    expect(withConnectTimeouts('host:1521/ORCL', 0, 0)).toBe('host:1521/ORCL');
    expect(withConnectTimeouts('host:1521/ORCL', 10, 0)).toBe('host:1521/ORCL?connect_timeout=10');
  });
});

describe('isConnectionBreakError', () => {
  it.each(['NJS-500', 'NJS-003', 'DPI-1067', 'DPI-1080', 'ORA-03156', 'ORA-03113', 'ORA-03135'])('detects %s by code', (code) => {
    expect(isConnectionBreakError(oraErr(code, `${code}: something`))).toBe(true);
  });

  it('detects a code that only appears in the message (oracledb 6 translation)', () => {
    expect(isConnectionBreakError(oraErr('NJS-123', 'NJS-123: call timeout of 30000 ms exceeded\nDPI-1067: call timeout of 30000 ms exceeded with ORA-3156'))).toBe(true);
    expect(isConnectionBreakError(new Error('Error: DPI-1080: connection was closed by ORA-3113'))).toBe(true);
  });

  it('ignores other errors and non-errors', () => {
    expect(isConnectionBreakError(oraErr('ORA-00942', 'ORA-00942: table or view does not exist'))).toBe(false);
    expect(isConnectionBreakError(new Error('boom'))).toBe(false);
    expect(isConnectionBreakError(null)).toBe(false);
    expect(isConnectionBreakError('NJS-500')).toBe(false);
  });
});

describe('classifyTargetError', () => {
  it('break error at or after callTimeout → TIMEOUT', () => {
    expect(classifyTargetError(BROKEN, 61000, 30000)).toBe('TIMEOUT');
    expect(classifyTargetError(BROKEN, 30000, 30000)).toBe('TIMEOUT');
  });

  it('break error before callTimeout → DISCONNECTED', () => {
    expect(classifyTargetError(BROKEN, 1200, 30000)).toBe('DISCONNECTED');
    expect(classifyTargetError(oraErr('NJS-003', 'NJS-003: invalid or closed connection'), 5, 30000)).toBe('DISCONNECTED');
  });

  it('break error with no callTimeout is never a timeout', () => {
    expect(classifyTargetError(BROKEN, 999999, 0)).toBe('DISCONNECTED');
  });

  it('ordinary SQL errors → ERROR regardless of elapsed time', () => {
    expect(classifyTargetError(oraErr('ORA-00942', 'ORA-00942: table or view does not exist'), 61000, 30000)).toBe('ERROR');
  });
});
