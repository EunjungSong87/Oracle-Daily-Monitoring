# DB Cockpit — Oracle Daily Monitoring

여러 대의 Oracle DB를 한 화면에서 점검·모니터링하는 사내용 웹 도구입니다.
등록해 둔 DB들에 점검 SQL을 돌려 임계치 위반을 이슈 티켓으로 관리하고, 실시간 세션/SQL 상황을 보고,
두 DB의 오브젝트·파라미터를 비교할 수 있습니다.

- 백엔드: Node.js + Express + TypeScript (`tsx`로 바로 실행, 별도 빌드 없음)
- 프론트엔드: React + TypeScript + Vite (페이지별 멀티 페이지 앱, `client/`)
- DB 접속: `oracledb` Thick 모드 + 저장소에 포함된 Oracle Instant Client 19
- 인터넷 연결이 없는 내부망에서도 그대로 동작합니다 (외부 CDN 의존 없음).

---

## 주요 기능

| 메뉴 | 기능 | 권한 |
|---|---|---|
| **Databases** | 점검 대상 DB 등록/수정/삭제, 접속 테스트 (비밀번호는 AES-256-GCM으로 암호화 저장) | 조회: 전체 · 관리: DBA 이상 |
| **Monitoring › Daily Monitoring** | 등록된 점검 SQL을 대상 DB에 실행하고 임계치 위반 표시, 예약 실행(매일 지정 시각) + HTML 리포트 저장 | 실행: 전체 · 예약 설정: DBA 이상 |
| ‣ Scripts / Thresholds | 점검 SQL(태스크)과 임계치 규칙 관리 | DBA 이상 |
| ‣ Run History | 지난 점검 결과 이력 | 전체 |
| ‣ Issues | 임계치 위반 티켓 (자동 생성/자동 해결/재오픈, 확인·해결·담당자·댓글) | 전체 |
| **Monitoring › Real-Time** | 2초 간격 실시간 세션 모니터링: Active Session 구성/추이, **SQL 경과 시간 산점도**(MaxGauge 방식, ASH 기준 — 점 클릭/드래그로 상세), 세션 더블클릭 시 **세션 상세**(V$SESSION + ASH 요약 + SQL 전문/통계, V$SQL에 없으면 AWR) | 전체 |
| **Maintenance › Table Spec** | 스키마/테이블 명세서 엑셀 추출 | DBA 이상 |
| ‣ Stats Job Status | 통계 수집 스케줄러 잡 현황/수동 실행 | 최고관리자 |
| ‣ ILM Partition Retention | 파티션 보관주기 관리 (`PGDBA.DEL_JOB_TABLE_LIST`) | 최고관리자 |
| **Compare › Object Compare** | 두 DB(또는 두 스키마) 오브젝트 비교: 테이블스페이스, 테이블 컬럼(유무/타입/길이/NULL/기본값), 인덱스, 뷰, 시퀀스, 시노님, PL/SQL 소스(줄 단위 diff) | 최고관리자 |
| **Compare › Parameter Compare** | 두 DB 초기화 파라미터 비교 (hidden `_` 파라미터 포함, 인스턴스 기준 값) | 최고관리자 |
| 계정 › Users | 로그인 계정/권한 관리 | 최고관리자 |

권한은 3단계입니다: **VIEWER**(조회·수동 점검·이슈 처리) < **DBA**(+ DB/스크립트/임계치/예약 관리, Table Spec) < **SUPER_ADMIN**(+ 계정 관리, Stats Job, ILM, Compare).

> Real-Time의 SQL 경과 시간 산점도와 세션 상세의 ASH/AWR 정보는 Oracle **Diagnostics Pack** 라이선스가 필요한 뷰를 읽습니다.
> 권한/라이선스가 없는 DB에서는 해당 부분만 "조회 불가"로 표시되고 나머지 기능은 동작합니다.

---

## 실행하기

### 1. 준비물
- Windows x64, **Node.js v24**
- **Visual C++ 재배포 패키지**(vc_redist.x64) — 포함된 Oracle Instant Client가 필요로 합니다.
  없으면 `DPI-1047: Cannot locate a 64-bit Oracle Client library` 에러가 납니다.
- 앱 자체 데이터를 저장할 **메타데이터 Oracle DB** (로컬 테스트용 Docker 구성 포함, 아래 참고)

`node_modules`, `client/node_modules`, `instantclient_19_25/`, 빌드된 `public/`까지 저장소에 들어 있어서
Windows x64라면 `npm install`이나 프론트 빌드 없이 바로 실행됩니다.

### 2. 환경 변수
`.env.example`을 `.env`로 복사해서 채웁니다. (`.env`는 git에 올라가지 않습니다)

| 항목 | 설명 |
|---|---|
| `APP_HOST`, `APP_PORT` | 서버가 바인딩할 주소/포트 (로컬은 `localhost`) |
| `NODE_ORACLEDB_USER` / `_PASSWORD` / `_CONNECTIONSTRING` | 메타데이터 DB 접속 정보 |
| `DBMS_ENCRYPTION_KEY` | 대상 DB 비밀번호 암호화 키. **한 번 정하면 절대 바꾸지 마세요** — 바뀌면 저장된 비밀번호를 복호화할 수 없습니다 |
| `SESSION_SECRET` | 로그인 세션 쿠키 서명 키 (바꾸면 전원 로그아웃) |

키 생성: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

### 3. 메타데이터 DB 스키마
처음 설치하는 환경이면 `scripts/`의 SQL을 메타데이터 DB에 적용합니다.
순서와 방법은 **[scripts/DEPLOY_NOTES.txt](scripts/DEPLOY_NOTES.txt)** 3번을 따르세요.

### 4. 첫 관리자 계정
```
npx tsx scripts/create-admin-user.ts <아이디> <비밀번호> [표시이름]
```
항상 SUPER_ADMIN으로 만들어집니다 (같은 아이디로 다시 실행하면 비밀번호 초기화 — 분실 시 복구용).
그 외 계정은 화면의 Users 메뉴에서 만듭니다.

### 5. 서버 실행
반드시 **프로젝트 루트에서** 실행합니다 (Instant Client를 상대경로로 찾습니다).
```
npm start          # 운영
npm run dev        # 개발 (파일 변경 시 자동 재시작)
```
`서버 시작: http://...` 로그가 찍힌 뒤 그 주소로 접속하면 됩니다. 터미널을 닫으면 서버도 꺼집니다.
세션은 메모리에 저장되므로 재시작하면 다시 로그인해야 합니다.

---

## 로컬 테스트 DB (Docker)

```
docker compose up -d
```
`gvenzl/oracle-free:23.4` 컨테이너가 뜨고, 처음 생성될 때 `docker/initdb/*.sql`로 스키마와 샘플 데이터가 자동으로 들어갑니다
(ILM 샘플 테이블, Object Compare용 `CMP_SRC`/`CMP_TGT` 샘플 스키마 포함). `.env`는 `localhost:1521/FREEPDB1`로 맞추면 됩니다.

> `docker/initdb/*.sql`은 **로컬 테스트 전용**입니다. 내부망/운영 DB에서는 실행하지 마세요.

---

## 개발

```
npm run typecheck      # 백엔드 타입 검사
npm run lint           # ESLint
npm test               # 단위 테스트 (vitest)
npm run build:client   # 프론트엔드 빌드 → public/
```

- 프론트엔드 소스는 `client/src/`에 있고, **`public/*.html`과 `public/assets/`는 빌드 결과물**이라 직접 고치지 않습니다.
  `client/src`를 고쳤으면 `npm run build:client` 후 바뀐 `public/` 파일도 같이 커밋합니다.
- 공통 스타일은 `public/style.css` (직접 편집).
- 서버 로그는 `utils/logger.ts`로만 찍습니다 — `시각 레벨 [영역] 메시지 | 원인` 한 줄 형식, 에러는 처리하는 곳(controller)에서 한 번만.

### 폴더 구조
```
server.ts              Express 앱 진입점 (세션, 인증, 정적 파일, 라우터, 스케줄러)
db.ts                  메타데이터 DB 커넥션 풀 / 대상 DB 단건 접속
config/                메타데이터 DB 접속 설정
routers/               URL → controller 매핑 (+ 권한 미들웨어)
controllers/           요청 검증 / 응답
services/              비즈니스 로직 (점검 실행·임계치 평가, 비교 로직, 스케줄러, 리포트)
models/                Oracle 쿼리 (메타데이터 DB, 대상 DB 딕셔너리/ASH/AWR)
middleware/auth.ts     로그인 / DBA / 최고관리자 권한 검사
utils/logger.ts        공통 로그 포맷
client/                React 프론트엔드 (pages/<화면>/, shared/)
public/                빌드된 프론트엔드 + style.css (Express가 정적 서빙)
scripts/               스키마 SQL, 관리자 계정 생성, 배포 노트, hidden 파라미터 권한 스크립트
docker/initdb/         로컬 테스트 DB 초기화 SQL
instantclient_19_25/   Oracle Instant Client (Windows x64)
```

### 구조 한눈에 보기
- **두 종류의 DB**를 다룹니다.
  - **메타데이터 DB**: 앱 자체 데이터(등록된 DB 목록, 점검 SQL, 임계치, 실행 이력, 이슈, 계정)를 저장. 커넥션 풀 사용.
  - **대상 DB**: 실제로 점검/모니터링하는 DB들. 메타데이터 DB에 저장된 접속 정보(비밀번호 복호화)로 요청마다 새로 접속.
- 계층: `routers` → `controllers` → `services` → `models`.

---

## 배포 (내부망)

내부망에 새 버전을 올릴 때의 순서(백업, 소스 옮기기, `.env`, 스키마, 대상 DB 권한, 재시작, 확인 항목)와
버전별 변경 내역은 **[scripts/DEPLOY_NOTES.txt](scripts/DEPLOY_NOTES.txt)** 에 정리되어 있습니다.
