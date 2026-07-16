import oracle from 'oracledb';

// Database 연결 Thick mode 활성화
try {
  // Oracle Instant Client의 경로 설정
  oracle.initOracleClient({ libDir: './instantclient_19_25' });
  console.log('Thick mode initialized');
} catch (err) {
  console.error('Error initializing Oracle client:', err);
}

// 외부 파일에서 데이터베이스 구성을 가져옵니다.
const dbConfig: oracle.PoolAttributes = require('./config/database');

interface TargetDbConfig {
  user: string;
  password: string;
  connectString: string;
}

async function connectDB(config: TargetDbConfig): Promise<oracle.Connection> {
  console.log('db.js connectDB : ', { ...config, password: config.password ? '***' : config.password });
  try {
    const connection = await oracle.getConnection({
      user: config.user,
      password: config.password,
      connectString: config.connectString,
    });
    console.log('환경에서 DB에 성공적으로 연결되었습니다.');
    return connection;
  } catch (err) {
    console.error('DB 연결 실패:', err);
    throw err;
  }
}

// 커넥션 풀 생성, DB 연결 함수
// 풀은 프로세스당 한 번만 생성해서 재사용합니다 (매 호출마다 새 풀을 만들면
// 커넥션이 누적되어 결국 DB 쪽에서 연결이 지연/타임아웃되는 문제가 있었습니다).
// 첫 생성 시도가 응답 없이 멈추는 경우를 대비해 타임아웃을 둬서, 이후 요청들이
// 영원히 대기하지 않고 다음 호출에서 재시도할 수 있게 합니다.
const POOL_CREATE_TIMEOUT_MS = 15000;
let poolPromise: Promise<oracle.Pool> | null = null;

function initializeDB(): Promise<oracle.Pool> {
  if (!poolPromise) {
    poolPromise = Promise.race([
      oracle.createPool(dbConfig),
      new Promise<oracle.Pool>((_, reject) =>
        setTimeout(
          () => reject(new Error(`커넥션 풀 생성이 ${POOL_CREATE_TIMEOUT_MS}ms 내에 완료되지 않았습니다.`)),
          POOL_CREATE_TIMEOUT_MS
        )
      ),
    ])
      .then((pool) => {
        console.log('Oracle connection pool created');
        return pool;
      })
      .catch((err) => {
        console.error('Error creating connection pool:', err);
        poolPromise = null; // 다음 호출에서 재시도 가능하도록 초기화
        throw err;
      });
  }
  return poolPromise;
}

// 서버 종료 시 커넥션 풀 닫기
async function closeDB(): Promise<void> {
  process.on('SIGINT', async () => {
    try {
      console.log('\nClosing Oracle connection pool...');
      if (poolPromise) {
        const pool = await poolPromise;
        await pool.close(10); // 최대 10초 대기 후 연결 닫기
      }
      console.log('Oracle connection pool closed');
      process.exit(0);
    } catch (err) {
      console.error('Error closing pool:', err);
      process.exit(1);
    }
  });
}

export = { connectDB, initializeDB, closeDB };
