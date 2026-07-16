import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { encrypt, decrypt } from './cryptoUtils';

beforeAll(() => {
  // 32바이트를 base64로 인코딩한 테스트 전용 키.
  process.env.DBMS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
});

describe('encrypt/decrypt', () => {
  it('암호화한 값을 다시 복호화하면 원본과 같다', () => {
    const plain = 'OraTest_2026!';
    const cipherText = encrypt(plain);
    expect(cipherText).not.toBe(plain);
    expect(decrypt(cipherText)).toBe(plain);
  });

  it('암호화할 때마다 다른 값이 나온다 (매번 랜덤 IV 사용)', () => {
    const plain = 'same-password';
    const a = encrypt(plain);
    const b = encrypt(plain);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plain);
    expect(decrypt(b)).toBe(plain);
  });

  it('DBMS_ENCRYPTION_KEY가 없으면 에러를 던진다', () => {
    const original = process.env.DBMS_ENCRYPTION_KEY;
    delete process.env.DBMS_ENCRYPTION_KEY;
    expect(() => encrypt('x')).toThrow('DBMS_ENCRYPTION_KEY');
    process.env.DBMS_ENCRYPTION_KEY = original;
  });

  it('평문(암호화되지 않은) 값을 복호화하려 하면 에러를 던진다', () => {
    // 마이그레이션 스크립트가 "이미 암호화됐는지" 판단할 때 기대하는 동작.
    expect(() => decrypt('this-is-plain-text-not-encrypted')).toThrow();
  });
});
