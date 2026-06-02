// server.js

// 필요한 모듈을 가져옵니다.
const express = require('express');
// Express 애플리케이션을 생성합니다.
const app = express();

const oracle = require('oracledb');
//Database 연결 Thick mode 활성화

try {
  // Oracle Instant Client의 경로 설정
  oracle.initOracleClient({ libDir: './instantclient_19_25' });
  console.log('Thick mode initialized');
} catch (err) {
  console.error('Error initializing Oracle client:', err);
}

const cors = require('cors');
const bodyParser = require('body-parser');

// 서버를 위한 포트를 설정합니다.
const host = '172.28.117.30';
const port = 3000;
// 모든 라우트에 대해 CORS를 활성화하여 교차 출처 문제를 방지합니다.
app.use(cors());

// 외부 파일에서 데이터베이스 구성을 가져옵니다.
const dbConfig = require('./config/database.js');

// 메인 기본 HTML 파일을 제공하는 라우트입니다.
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html')
  });


// 'public' 디렉토리에서 정적 파일을 제공합니다.
app.use(express.static('public', { "Content-Type": "application/javascript" }));

// 들어오는 JSON 데이터를 처리하기 위한 JSON 파서를 설정합니다.
// body-parser 미들웨어 추가
const jsonParser = bodyParser.json();
const urlencodedParser = bodyParser.urlencoded({ extended: true });

// JSON 요청 본문 처리
app.use(jsonParser);

// URL-encoded 요청 본문 처리
app.use(urlencodedParser);

// 서버 시작
async function startServer() {
  //await initPool(); // 커넥션 풀 초기화
  app.listen(port, host, () => {
    console.log(`Server is running on http://172.28.117.30:${port}`);
  });
}
  
  // 서버 및 커넥션 풀 초기화 실행
startServer();

// 라우트 설정
const dbmsRouters = require('./routers/dbmsRouters'); // 라우터 가져오기
app.use('/main', dbmsRouters);
app.use('/api' , dbmsRouters);