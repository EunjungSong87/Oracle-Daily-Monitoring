// 최초 관리자 계정을 만드는 1회성 부트스트랩 스크립트입니다.
// 사용자 관리 페이지(users.html) 자체가 로그인한 관리자만 접근 가능하기 때문에,
// 앱을 처음 배포한 뒤에는 이 스크립트로 계정을 하나 만들어야만 로그인할 수 있습니다
// (UI로는 첫 계정을 만들 방법이 없는 닭과 달걀 문제).
//
// 실행 전 .env(또는 환경변수)에 다음 값이 설정되어 있어야 합니다:
//   NODE_ORACLEDB_USER / NODE_ORACLEDB_PASSWORD / NODE_ORACLEDB_CONNECTIONSTRING
//     -> 메타데이터 DB 접속 정보
//
// 실행: npx tsx scripts/create-admin-user.ts <username> <password> [displayName]
//
// 이미 존재하는 username이면 비밀번호를 갱신하고 관리자/활성 상태로 되돌립니다
// (관리자 본인이 잠겼을 때 재실행으로 복구할 수 있도록 안전하게 재실행 가능합니다).

// side-effect import를 첫 줄에 둬서, 뒤따르는 import(config/database.ts 등)가 평가되기 전에
// .env가 먼저 로드되도록 합니다 (import 문은 모듈 최상단으로 끌어올려지므로, dotenv.config()를
// 별도 문장으로 쓰면 이후에 오는 다른 import가 먼저 실행되어 .env 값이 반영되지 않을 수 있습니다 —
// server.ts와 동일한 이유).
import 'dotenv/config';
import oracledb from 'oracledb';
import dbConfig from '../config/database';
import { hashPassword } from '../models/passwordUtils';

try {
  oracledb.initOracleClient({ libDir: './instantclient_19_25' });
} catch {
  // already initialized
}

(async () => {
  const [, , username, password, displayName] = process.argv;
  if (!username || !password) {
    console.error('사용법: npx tsx scripts/create-admin-user.ts <username> <password> [displayName]');
    process.exit(1);
  }

  const connection = await oracledb.getConnection(dbConfig);
  try {
    const passwordHash = hashPassword(password);

    const existing = await connection.execute<any[]>('select id from system.users where username = :username', {
      username,
    });

    if (existing.rows && existing.rows.length > 0) {
      const id = existing.rows[0][0];
      await connection.execute(
        `update system.users
            set password_hash = :passwordHash, display_name = :displayName,
                role = 'SUPER_ADMIN', is_active = 'Y'
          where id = :id`,
        { id, passwordHash, displayName: displayName ?? null },
        { autoCommit: true }
      );
      console.log(`기존 계정 "${username}"을 최고관리자(SUPER_ADMIN)로 갱신했습니다 (id=${id}).`);
    } else {
      const maxRes = await connection.execute<any[]>('select nvl(max(id),0)+1 as nextid from system.users');
      const nextId = maxRes.rows?.[0][0];
      await connection.execute(
        `insert into system.users (id, username, password_hash, display_name, role, is_active, created_at)
         values (:id, :username, :passwordHash, :displayName, 'SUPER_ADMIN', 'Y', TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'))`,
        { id: nextId, username, passwordHash, displayName: displayName ?? null },
        { autoCommit: true }
      );
      console.log(`최고관리자(SUPER_ADMIN) 계정 "${username}"을 생성했습니다 (id=${nextId}).`);
    }
  } finally {
    await connection.close();
  }
})().catch((err) => {
  console.error('관리자 계정 생성 실패:', err);
  process.exit(1);
});
