const oracle = require('oracledb');
//Database 연결 Thick mode 활성화

try {
  // Oracle Instant Client의 경로 설정
  oracle.initOracleClient({ libDir: './instantclient_19_25' });
  console.log('Thick mode initialized');
} catch (err) {
  console.error('Error initializing Oracle client:', err);
}

// 외부 파일에서 데이터베이스 구성을 가져옵니다.
const dbConfig = require('./config/database.js');

async function connectDB(config) {
    console.log('db.js connectDB : ', config );
    try {
      const connection = await oracle.getConnection({
        user: config.user,
        password: config.password,
        connectString: config.connectString
      });
      console.log('환경에서 DB에 성공적으로 연결되었습니다.');
      return connection;
    } catch (err) {
      console.error('DB 연결 실패:', err);
      throw err;
    }
  }


// 커넥션 풀 생성,DB 연결 함수 
async function initializeDB() {
    let pool;
    try {
      pool = await oracle.createPool(dbConfig);
      console.log('Oracle connection pool created');
      return pool; // 연결 객체 반환
    } catch (err) {
      console.error('Error creating connection pool:', err);
      throw err;
    }
  }


// 서버 종료 시 커넥션 풀 닫기
async function closeDB() {
    process.on('SIGINT', async () => {
        try {
          console.log('\nClosing Oracle connection pool...');
          await pool.close(10); // 최대 10초 대기 후 연결 닫기
          console.log('Oracle connection pool closed');
          process.exit(0);
        } catch (err) {
          console.error('Error closing pool:', err);
          process.exit(1);
        }
      })
    };

module.exports = { connectDB, initializeDB, closeDB };