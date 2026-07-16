// server.ts

// .env 파일의 환경변수를 process.env로 로드합니다 (다른 import보다 먼저 실행되어야 함).
// tsx/esbuild는 import 문을 파일 상단으로 끌어올리므로, `dotenv.config()`를 별도 문장으로 쓰면
// 뒤에 오는 import(예: dbmsRouters -> config/database.ts)가 먼저 로드되어 .env 값이 반영되지 않을 수 있다.
// side-effect import는 다른 import들과의 상대 순서가 보장되므로 반드시 첫 줄에 위치해야 한다.
import 'dotenv/config';

// 필요한 모듈을 가져옵니다.
import express from 'express';
import path from 'path';
import cors from 'cors';
import bodyParser from 'body-parser';
import oracle from 'oracledb';
import dbmsRouters from './routers/dbmsRouters'; // 라우터 가져오기
import tableSpecRouters from './routers/tableSpecRouters';

// Express 애플리케이션을 생성합니다.
const app = express();

// Database 연결 Thick mode 활성화
try {
  // Oracle Instant Client의 경로 설정
  oracle.initOracleClient({ libDir: './instantclient_19_25' });
  console.log('Thick mode initialized');
} catch (err) {
  console.error('Error initializing Oracle client:', err);
}

// 서버를 위한 포트를 설정합니다.
const host = process.env.APP_HOST || '172.28.117.30';
const port = process.env.APP_PORT || 3000;
// 모든 라우트에 대해 CORS를 활성화하여 교차 출처 문제를 방지합니다.
app.use(cors());

// 메인 기본 HTML 파일을 제공하는 라우트입니다.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 'public' 디렉토리에서 정적 파일을 제공합니다.
app.use(express.static('public'));

// 들어오는 JSON 데이터를 처리하기 위한 JSON 파서를 설정합니다.
// body-parser 미들웨어 추가
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

// JSON 요청 본문 처리
app.use(jsonParser);

// URL-encoded 요청 본문 처리
app.use(urlencodedParser);

// 서버 시작
async function startServer(): Promise<void> {
  app.listen(Number(port), host, () => {
    console.log(`Server is running on http://${host}:${port}`);
  });
}

// 서버 및 커넥션 풀 초기화 실행
startServer();

// 라우트 설정
app.use('/main', dbmsRouters);
app.use('/api', dbmsRouters);
app.use('/api', tableSpecRouters);
