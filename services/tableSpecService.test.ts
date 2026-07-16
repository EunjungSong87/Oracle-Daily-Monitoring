import { describe, it, expect } from 'vitest';
import { sanitizeSheetName } from './tableSpecService';

describe('sanitizeSheetName', () => {
  it('일반 스키마 이름은 그대로 둔다', () => {
    expect(sanitizeSheetName('APPUSER')).toBe('APPUSER');
  });

  it('엑셀 시트명에 쓸 수 없는 문자를 밑줄로 바꾼다', () => {
    expect(sanitizeSheetName('A:B/C?D*E[F]')).toBe('A_B_C_D_E_F_');
  });

  it('31자를 넘으면 잘라낸다 (엑셀 시트명 길이 제한)', () => {
    const longName = 'A'.repeat(50);
    const result = sanitizeSheetName(longName);
    expect(result.length).toBe(31);
    expect(result).toBe('A'.repeat(31));
  });
});
