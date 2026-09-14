import crypto from 'crypto';

const SALT_BYTES = 16;
const KEY_LEN = 64;

// 로그인 비밀번호를 저장 전 해싱합니다 (Node 내장 crypto.scrypt, 외부 패키지 불필요).
// cryptoUtils.encrypt와 마찬가지로 salt+hash를 한 문자열에 담아 컬럼 하나로 저장합니다.
function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(plain, salt, KEY_LEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(plain, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export { hashPassword, verifyPassword };
