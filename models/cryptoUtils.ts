import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const keyB64 = process.env.DBMS_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error('DBMS_ENCRYPTION_KEY 환경변수가 설정되지 않았습니다.');
  }
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('DBMS_ENCRYPTION_KEY는 32바이트를 base64로 인코딩한 값이어야 합니다.');
  }
  return key;
}

// 대상 DBMS 접속 비밀번호를 DB에 저장하기 전 암호화합니다 (AES-256-GCM).
function encrypt(plainText: unknown): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

// 저장된 암호문에서 원래 비밀번호를 복원합니다.
function decrypt(cipherTextB64: string): string {
  const data = Buffer.from(cipherTextB64, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
