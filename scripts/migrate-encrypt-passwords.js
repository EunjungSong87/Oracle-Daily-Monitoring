// 실제 운영 DB의 system.monitoring_dbms_list에 평문으로 저장된 기존 비밀번호를
// DBMS_ENCRYPTION_KEY로 일괄 암호화하는 1회성 마이그레이션 스크립트입니다.
//
// 실행 전 .env(또는 환경변수)에 다음 값이 설정되어 있어야 합니다:
//   NODE_ORACLEDB_USER / NODE_ORACLEDB_PASSWORD / NODE_ORACLEDB_CONNECTIONSTRING
//     -> 실제 운영 메타데이터 DB 접속 정보
//   DBMS_ENCRYPTION_KEY
//     -> 새로 배포할 앱 코드가 사용할 것과 반드시 동일한 키
//
// 실행: node scripts/migrate-encrypt-passwords.js
//
// 이미 암호화된 행은 복호화를 시도해보고 성공하면 건너뛰므로, 실수로 두 번 실행해도
// 안전합니다(이중 암호화되지 않음).

require('dotenv').config();
const oracledb = require('oracledb');

try {
  oracledb.initOracleClient({ libDir: './instantclient_19_25' });
} catch (e) {
  // already initialized
}

const dbConfig = require('../config/database');
const { encrypt, decrypt } = require('../models/cryptoUtils');

(async () => {
  const connection = await oracledb.getConnection(dbConfig);
  try {
    const result = await connection.execute('select id, password from system.monitoring_dbms_list');

    let migrated = 0;
    let skipped = 0;

    for (const [id, password] of result.rows) {
      try {
        decrypt(password);
        console.log(`id=${id}: 이미 암호화되어 있어 건너뜀`);
        skipped++;
        continue;
      } catch (e) {
        // 복호화 실패 = 평문으로 간주하고 암호화 진행
      }

      await connection.execute(
        'update system.monitoring_dbms_list set password = :password where id = :id',
        { password: encrypt(password), id },
        { autoCommit: true }
      );
      console.log(`id=${id}: 암호화 완료`);
      migrated++;
    }

    console.log(`\n마이그레이션 완료: ${migrated}건 암호화, ${skipped}건 스킵 (총 ${result.rows.length}건)`);
  } finally {
    await connection.close();
  }
})().catch((err) => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
