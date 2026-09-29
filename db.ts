import oracle from 'oracledb';
import dbConfig from './config/database';
import { logger } from './utils/logger';

// Database 연결 Thick mode 활성화
try {
  // Oracle Instant Client의 경로 설정
  oracle.initOracleClient({ libDir: './instantclient_19_25' });
} catch (err) {
  logger.error('DB', 'Oracle Instant Client(Thick mode) 초기화 실패', err);
}

interface TargetDbConfig {
  user: string;
  password: string;
  connectString: string;
}

// 접속 실패는 여기서 로그를 찍지 않고 그대로 던집니다 — 호출한 쪽(controller)이 한 번만 찍고,
// 접속 테스트 버튼처럼 실패가 정상 결과인 경우엔 아예 에러 로그를 남기지 않기 위해서입니다.
async function connectDB(config: TargetDbConfig): Promise<oracle.Connection> {
  return oracle.getConnection({
    user: config.user,
    password: config.password,
    connectString: config.connectString,
  });
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
        logger.info('DB', `메타데이터 DB 커넥션 풀 생성: ${dbConfig.connectString}`);
        return pool;
      })
      .catch((err) => {
        logger.error('DB', '메타데이터 DB 커넥션 풀 생성 실패', err);
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
      logger.info('DB', '커넥션 풀 종료 중...');
      if (poolPromise) {
        const pool = await poolPromise;
        await pool.close(10); // 최대 10초 대기 후 연결 닫기
      }
      logger.info('DB', '커넥션 풀 종료 완료');
      process.exit(0);
    } catch (err) {
      logger.error('DB', '커넥션 풀 종료 실패', err);
      process.exit(1);
    }
  });
}

export { connectDB, initializeDB, closeDB };
