# 대상 DB 부하 점검 보고서 (LOAD_AUDIT)

- 작성일: 2026-10-22
- 원칙: 이 앱의 모든 기능은 모니터링 대상 DB에 부하를 주면 안 된다.
- 범위: `models/`, `services/`, `queries/`에서 대상 DB로 나가는 모든 SQL·PL/SQL. Daily Monitoring 태스크 SQL은 메타 DB 데이터라 `scripts/monitoring_queries_insert.sql`(운영 시드, 태스크 1~28)과 `docker/initdb/02_seed_data.sql`로 대신 점검했다.
- 이 보고서 작성 과정에서는 코드를 수정하지 않았다.
- 같은 날 반영된 대상 DB 타임아웃 변경은 적용된 것으로 보고 점검했다. 일일점검 30초(실제 약 60초), Real-Time 7초(약 15초), 접속 테스트 5초(약 10초)이고, 나머지 기능은 무제한이다.

## 0. 요약

| 구분 | 건수 | 핵심 |
|---|---|---|
| 상 | 8 | Real-Time 2초 폴링이 사용자마다 logon·조회(+겹침), Object Compare의 DBA_SOURCE 해시(최대 50스키마×2DB), 점검 SQL 저장 검증 없음(DDL 실행 가능), V$DIAG_ALERT_EXT, 수동 점검 실행 무제한 동시 실행, Data Pump 전체 실행, 대상 DB 세션 상한 없음, 타임아웃 후 서버 쪽 SQL 정리 장치 없음 |
| 중 | 14 | DBA_FREE_SPACE 이중 집계, V$ASM_DISKGROUP(디스크 discovery), Table Spec 스키마 목록·IN 리스트, Data Pump 화면 진입 시 동시 4~5 logon, 작업 현황 15초 폴링의 DBA_OBJECTS, 이력 동기화 매분 작업별 logon, 세션 상세의 기간 무제한 AWR ASH 등 |
| 하 | 14 | 사전/동적 뷰를 이름 조건으로 좁혀 읽는 조회들 |

**공통 구조 문제**는 다섯 가지다. 각 행의 '이유'에 반복해서 적지 않고 아래에 모았다.

1. **모든 요청이 logon/logoff를 한다.** 풀 없이 `connectDB()`로 새 접속을 연다.
2. **대상 DB별 동시 세션 상한이 없다.**
3. **세션 식별 정보가 없다.** MODULE/ACTION/CLIENT_IDENTIFIER를 설정하지 않아 V$SESSION에는 `node.exe` 같은 이름만 보인다.
4. **결과 행 수 상한이 없다.** `maxRows`를 어디서도 지정하지 않아 기본값인 무제한이다.
5. **대상 계정이 SYSTEM이다.** 운영 시드 기준이다. 읽기 전용 권한이 아니라서, 잘못된 SQL이 그대로 실행된다.

자세한 내용과 설계안은 2~5장에 있다.

---

## 1. 전수 점검표 (위험도 상 → 중 → 하)

빈도 표기:
- **클릭**: 사용자 클릭 1회
- **2초 폴링** / **15초 폴링**: 화면을 연 동안 반복
- **매분**: 스케줄러 tick
- **매일**: 예약 일일점검

배수는 같은 대상 DB를 N명이 동시에 쓸 때 대상 DB가 받는 호출 수다.

| 기능 | 파일:함수 | 조회하는 뷰/테이블 | 실행 빈도 | 동시 사용자 N명일 때 배수 | 위험도 | 이유 | 개선안 |
|---|---|---|---|---|---|---|---|
| Real-Time | `models/realtimeModel.ts:272` getSnapshot (+`:51` loadSessions, `:217` loadAshExecutionsSince) | V$SESSION(전체), V$ACTIVE_SESSION_HISTORY(최근 10분 GROUP BY), DBA_USERS | 2초 폴링(화면 열린 동안 계속) | N배. 사용자당 **분당 logon 30회 + 쿼리 90회**. 5명이면 분당 logon 150회 | 상 | ① 폴링마다 logon/logoff를 해서 logon storm과 감사 로그 증가를 일으킨다. ② 클라이언트(`client/src/pages/realtime/App.tsx:293`)가 `setInterval`이라 이전 응답을 기다리지 않는다. 응답이 2초를 넘으면 요청과 세션이 겹쳐 쌓인다. ③ 탭이 숨겨져도 멈추지 않는다(Data Pump 화면은 `whenVisible`로 멈춤). ④ ASH 10분 창을 매번 처음부터 GROUP BY한다. 인덱스가 없는 고정 테이블이라 매번 ASH 버퍼를 훑는다. ⑤ 같은 DB를 보는 사용자끼리 결과를 공유하지 않는다 | 3.2 "DB별 공유 폴러" 적용(N명이어도 2초당 1회). 폴링은 이전 응답이 끝난 뒤 다음 요청을 보내고, 탭이 숨겨지면 멈춘다. 공유 폴러는 대상 DB별 풀(3.1)의 커넥션 1개를 재사용해 logon을 없앤다. ASH는 공유 폴러가 마지막 `sample_time` 이후만 읽어 앱 메모리에 10분 창을 유지한다 |
| Object Compare | `models/objectCompareModel.ts:413` loadSourceHashes (`:474` getSnapshots가 스키마마다 호출) | DBA_SOURCE(스키마 전체 줄), 줄마다 ORA_HASH 2회 + 1행 REGEXP_REPLACE 2회 | 클릭(비교 실행). 한 번에 **최대 50개 스키마 짝**(`services/objectCompareService.ts:57`) × 원본·대상 2DB | N배, 캐시 없음 | 상 | 패키지가 많은 스키마는 DBA_SOURCE가 수백만 줄이고, 줄마다 해시와 정규식을 계산해 CPU를 크게 쓴다. 쿼리 타임아웃이 무제한이고 동시 실행 제한도 없다. 같은 스냅샷을 다시 비교해도 매번 처음부터 읽는다 | ① 1차 비교는 DBA_OBJECTS.LAST_DDL_TIME과 소스 줄 수로 하고, 다른 것만 해시를 계산한다. ② 스냅샷 결과를 (dbmsid, owner, types) 키로 TTL 10분 캐시한다(`dataPumpSizeCache.ts`의 `cached()` 재사용, 화면에 "새로 읽기" 버튼). ③ 대상 DB별 무거운 작업 세마포어(3.1)로 한 번에 1개만 실행한다. ④ 한 요청의 스키마 짝 상한을 50에서 10으로 낮추거나 진행형(스키마 단위 응답)으로 바꾼다. ⑤ 계정에 PROFILE `CPU_PER_CALL`을 건다(4장) |
| Object Compare | 같은 파일 `:225` loadColumns, `:251` loadIndexes, `:306` loadConstraints, `:438` loadTextObjects, `:451` loadStatuses | DBA_TAB_COLUMNS(owner 전체, 뷰 컬럼 포함), DBA_INDEXES/IND_COLUMNS/IND_EXPRESSIONS, DBA_CONSTRAINTS 자기조인 + DBA_CONS_COLUMNS, DBA_VIEWS.TEXT(LONG, 전체 뷰), DBA_MVIEWS, DBA_OBJECTS | 위와 같음(스키마당 쿼리 약 13개) | N배 | 상 (위와 합산) | 쿼리 하나하나는 OWNER 조건이 있어 정상이다. 그러나 50스키마 × 13쿼리 × 2DB가 한 요청에서 무제한 시간으로 순차 실행된다. DBA_TAB_COLUMNS는 뷰 컬럼까지 읽은 뒤 앱에서 버린다. DBA_CONSTRAINTS 자기조인은 사전 뷰 중에서도 무거운 편이다 | 위 캐시와 세마포어로 해결한다. loadColumns는 `TABLE_NAME IN (SELECT TABLE_NAME FROM DBA_TABLES WHERE OWNER=:owner)`로 좁히거나 DBA_TAB_COLS + 테이블 조인으로 바꾼다. 비교 대상 타입에 없는 쿼리는 이미 건너뛰므로 화면 기본 선택 타입을 줄인다 |
| Daily Monitoring (Scripts 관리) | `controllers/dbmsController.ts:111,147` modifyScript/addScript → `models/dbmsModel.ts:55` executeQuery | 사용자가 등록한 임의 SQL | 저장 후, 수동 점검 클릭마다 + 매일 | N배(아래 수동 점검 행 참고) | 상 | ① 저장할 때 검증이 전혀 없다. DML·DDL·PL/SQL 블록도 저장된다. ② 실행 커넥션이 읽기 전용이 아니고 계정이 SYSTEM이다. DML은 close 때 롤백되지만 **DDL(TRUNCATE/DROP 등)은 자동 커밋돼 그대로 실행된다**. ③ 조건 없는 대형 뷰 조회나 결과 행 상한 없는 SQL도 막지 못한다. 결과 전체가 메모리와 메타 DB 실행 이력 JSON에 저장된다 | ① 저장 시 검증한다. 공백·주석을 제거한 뒤 `SELECT`/`WITH`로 시작해야 하고, `;`로 문장을 여러 개 쓰지 못하며, 문장 레벨 `INSERT/UPDATE/DELETE/MERGE/CREATE/ALTER/DROP/TRUNCATE/GRANT/BEGIN/DECLARE/CALL`이 있으면 거부한다. ② 경고 목록(저장은 허용하고 화면에 경고): 1.1의 무거운 뷰를 WHERE 없이 조회하거나, `V$DIAG_ALERT_EXT`, `DBA_HIST_*`에 snap_id 조건이 없는 경우. ③ 저장 시 대상 DB 하나에 `EXPLAIN PLAN`을 실행해 문법을 확인하는 선택 기능. ④ 실행 시 `maxRows: 1000`을 지정하고, 잘린 경우 결과에 표시한다. ⑤ 근본 대책은 4장의 전용 읽기 계정이다 |
| Daily Monitoring | 태스크 25 alertLog (`monitoring_queries_insert.sql`) | V$DIAG_ALERT_EXT, `ORIGINATING_TIMESTAMP > sysdate-2`, `MESSAGE_TEXT LIKE '%ORA-%' OR LIKE '%FAIL%'` | 클릭 + 매일 | N배 | 상 | V$DIAG_ALERT_EXT는 ADR의 alert XML 파일을 디스크에서 파싱하는 뷰다. 시간 조건이 있어도 보관 중인 log.xml 전체를 읽는 경우가 많아, alert 로그가 크면 수십 초 동안 I/O와 CPU를 쓴다. 이는 일반적으로 알려진 특성이고, 대상 DB 버전마다 실측이 필요하다. 행 상한도 없다 | ① 대상 DB에서 `adrci` purge 정책(SHORTP_POLICY/LONGP_POLICY)으로 alert XML 크기를 제한한다(DBA 작업). ② 조건을 `ORIGINATING_TIMESTAMP > SYSTIMESTAMP - INTERVAL '1' DAY`로 줄이고 `FETCH FIRST 200 ROWS ONLY`를 붙인다. ③ 더 근본적으로는 대상 DB 쪽 스케줄러 잡이 하루 1회 오류 줄만 작은 테이블로 옮기고, 앱은 그 테이블을 읽는다(태스크 27 TB_DBSERVER_INFO와 같은 방식) |
| Daily Monitoring (수동 실행) | `services/dbmsService.ts:135` getMonResult | 태스크 1~28 전체(활성 26개)를 한 커넥션에서 순차 실행 | 클릭(VIEWER 권한도 가능) + 매일 | **N배, 제한 없음**. 3명이 같은 DB를 동시에 누르면 V$DIAG_ALERT_EXT·DBA_FREE_SPACE가 3번 동시에 돈다 | 상 | 한 번 실행은 커넥션 1개로 순차 실행해 양호하다. 그러나 같은 DB의 동시 실행을 합치거나 막는 장치가 없다. 직전 결과가 몇 초 전 것이어도 다시 실행한다 | ① DB별 single-flight: 같은 dbmsid가 이미 실행 중이면 새 요청은 그 결과를 기다려 함께 받는다(`dataPumpSizeCache.ts`의 `pending` 맵 방식). ② 직전 결과 재사용: 60초 이내 결과가 있으면 그대로 돌려주고 화면에 "N초 전 결과 · 다시 실행" 버튼을 둔다. 실행 이력은 실제 실행 1회만 저장한다. ③ 3.1 세마포어에 포함한다 |
| Data Pump (전체 실행) | `models/dataPumpModel.ts:345` startJob (화면 `ExportTab.tsx` runAll) | DBMS_DATAPUMP(실제 export/import 작업) | 클릭 | 작업 수 × PARALLEL. 예: 분할 20개 × PARALLEL 4 = 워커 80개 동시 | 상 (의도된 무거운 작업) | 기능 자체가 무거운 작업이다. 다만 "전체 실행"은 분할된 작업을 **모두 동시에** 시작하고, 동시 작업 수 상한이 없다. 다른 사용자가 같은 DB에 따로 실행해도 막지 않는다 | ① 대상 DB별 동시 Data Pump 작업 상한을 둔다(예: 2개). 나머지는 앱이 대기열로 들고 있다가 끝나는 대로 시작한다(이력 동기화가 이미 종료를 감지함). ② 전체 실행 확인창에 "동시 워커 = 작업 수 × PARALLEL"을 표시한다. ③ 4장의 Resource Manager로 Data Pump 워커를 낮은 우선순위 그룹에 매핑한다 |
| 공통 (모든 기능) | `db.ts` connectDB, `models/dbmsModel.ts` connectToTarget | — | 모든 요청 | 요청 수만큼 동시 세션 | 상 | 대상 DB별 동시 세션 상한이 없다. 무거운 기능(Compare, Data Pump 계획, Table Spec)을 여러 명이 동시에 누르면 그만큼 세션이 동시에 열려 같은 사전 뷰를 동시에 읽는다. 쿼리 타임아웃도 이 기능들은 무제한이다 | 3.1 "대상 DB별 풀 + 세마포어" |
| 공통 (타임아웃 후 정리) | `services/dbmsService.ts:135`, `db.ts` callTimeout | — | 타임아웃 발생 시 | — | 상 | Thick 모드 callTimeout은 먼저 break를 보낸다. break도 같은 시간 안에 처리되지 않으면 클라이언트가 소켓을 끊는다(NJS-500). 실측 "설정값의 약 2배"와 일치하는 동작이다. 이렇게 끊기면 **서버 프로세스는 다음에 네트워크로 쓰기를 시도할 때까지 SQL을 계속 실행할 수 있다**. 결과를 아직 안 보낸 무거운 집계는 끝날 때까지 돈다. 앱에는 정리 장치가 없다 | ① 앱에 소프트 타임아웃을 둔다. callTimeout보다 짧은 타이머(예: 설정값의 80%)에서 `connection.break()`를 호출하면 서버가 ORA-01013으로 그 SQL을 취소하고, 커넥션도 살아남는 경우가 많다. callTimeout은 최후 방어선으로 남긴다. ② 접속 직후 `SYS_CONTEXT('USERENV','SID')`와 SERIAL#을 기억해 두었다가, 끊긴 뒤 별도 세션에서 `ALTER SYSTEM CANCEL SQL 'sid,serial'`(18c+)을 실행한다. 다만 ALTER SYSTEM 권한이 필요하므로 ①을 우선한다. ③ 서버 쪽 보호: Resource Manager `SWITCH_GROUP=>'CANCEL_SQL'`(4.3), PROFILE `CPU_PER_CALL`(4.2), `sqlnet.ora`의 `SQLNET.EXPIRE_TIME=10`(끊긴 세션 감지) |
| Daily Monitoring | 태스크 18 tablespaceUsage | DBA_DATA_FILES, **DBA_FREE_SPACE 전체 GROUP BY**, V$PARAMETER(행마다 스칼라 서브쿼리), DBA_TABLESPACES 2회 + REGEXP_LIKE | 클릭 + 매일 | N배 | 중 | DBA_FREE_SPACE는 익스텐트 수와 휴지통 객체 수에 비례해 느려진다. 단편화된 DB에서는 수 초 이상 걸린다(DMT·휴지통이 많을 때 특히). 태스크 28과 **같은 집계를 한 번 더** 한다 | `DBA_TABLESPACE_USAGE_METRICS`(USED_SPACE, TABLESPACE_SIZE를 블록 단위로 유지)로 대체하고 `× block_size`로 MB를 계산한다. 자동 확장 최대치(MAXBYTES) 기준 사용률도 이 뷰가 이미 반영한다. 월별 테이블스페이스 제외 규칙은 앱 쪽 WHERE로 유지한다 |
| Daily Monitoring | 태스크 28 DB Size Check | DBA_DATA_FILES, DBA_FREE_SPACE 전체 GROUP BY | 클릭 + 매일 | N배 | 중 | 태스크 18과 같은 DBA_FREE_SPACE 집계를 반복한다 | 태스크 18과 합치거나 `DBA_TABLESPACE_USAGE_METRICS` 합계로 대체한다 |
| Daily Monitoring | 태스크 7 asmdiskUsage, 22 asmDiskGroupCheck | **V$ASM_DISKGROUP** (2개 태스크가 중복 조회) | 클릭 + 매일 | N배 | 중 | V$ASM_DISKGROUP은 조회할 때마다 ASM 디스크 discovery(디스크 헤더 재스캔)를 일으킬 수 있다. 디스크가 많으면 느리고 I/O도 생긴다 | `V$ASM_DISKGROUP_STAT`으로 바꾼다(discovery 없이 캐시된 값을 읽고, 컬럼은 같다). 두 태스크를 하나로 합친다 |
| Daily Monitoring | 태스크 27 DB LOG | SYSTEM.TB_DBSERVER_INFO, `to_char(createtime,'YYYY/MM/DD') = to_char(sysdate,...)` | 클릭 + 매일 | N배 | 중 | 컬럼에 함수를 씌워 createtime 인덱스를 못 타므로 **테이블 전체를 스캔**한다. 매일 쌓이는 로그 테이블이라 시간이 갈수록 느려진다. 행 상한도 없다 | `createtime >= TRUNC(SYSDATE) AND createtime < TRUNC(SYSDATE)+1`로 바꾼다. createtime 인덱스가 있는지 확인하고, 테이블 보관 주기(purge)를 정한다 |
| Daily Monitoring | 태스크 21 rmanBackupCheck | V$RMAN_STATUS(CONNECT BY), **행마다 V$RMAN_OUTPUT 상관 서브쿼리 + `LIKE 'allocated channel: ch%'`**, V$RMAN_BACKUP_JOB_DETAILS, V$RMAN_*_ALGORITHM | 클릭 + 매일 | N배 | 중 | V$RMAN_OUTPUT은 메모리에 쌓인 RMAN 출력 전체다. 결과 행마다 그 뷰를 다시 훑는다. 컨트롤 파일 기반 뷰는 RAC에서 인스턴스 간 조회도 생긴다 | 채널 수는 `V$RMAN_OUTPUT`을 한 번만 GROUP BY(session_recid)해서 조인한다. 알고리즘 조회는 고정 값이라 캐시하거나 별도 태스크로 뺀다 |
| Daily Monitoring | 태스크 6 archivelogFile | **GV$LOG_HISTORY** (15일) | 클릭 + 매일 | N배 | 중 | V$LOG_HISTORY는 컨트롤 파일 기반이라 이미 모든 thread를 담고 있다. GV$로 읽으면 RAC에서 **인스턴스 수만큼 같은 행이 중복**돼 건수가 2배로 나오고(값도 틀림), 인스턴스 간 조회 비용만 더해진다 | `V$LOG_HISTORY`로 바꾸고, 필요하면 `GROUP BY thread#`로 thread별로 본다 |
| Table Spec | `models/tableSpecModel.ts:21` getSchemas | `SELECT DISTINCT owner FROM DBA_TABLES JOIN DBA_USERS` | 화면 진입(클릭) | N배 | 중 | 스키마 목록을 얻으려고 **DBA_TABLES 전체**(tab$·obj$·seg$ 등 조인 뷰)를 읽고 DISTINCT한다. 테이블이 많은 DB에서는 수 초 걸린다 | Object Compare처럼 `DBA_USERS WHERE oracle_maintained='N'` + `EXISTS (SELECT 1 FROM DBA_TABLES t WHERE t.owner = u.username AND ROWNUM = 1)`로 바꾼다. 결과는 dbmsid별 TTL 10분 캐시 |
| Table Spec | `models/tableSpecModel.ts:52` getTableSpec (엑셀 'ALL' 경로 `services/tableSpecService.ts:229`) | DBA_TABLES/TAB_COMMENTS, DBA_TAB_COLUMNS/COL_COMMENTS, DBA_CONSTRAINTS×2 + CONS_COLUMNS, DBA_INDEXES/IND_COLUMNS, DBA_TAB_PRIVS, **DBA_SYNONYMS(TABLE_OWNER 조건)** | 클릭(엑셀 내보내기) | N배 | 중 | ① 'ALL'이면 스키마의 모든 테이블명을 **바인드 IN 리스트**로 넣는다. 테이블 수마다 SQL 문장이 달라져 하드 파스와 공유 풀 오염이 생기고, 1000개를 넘으면 ORA-01795로 실패한다. ② DBA_SYNONYMS는 참조 대상(TABLE_OWNER) 기준 인덱스가 없어 syn$ 전체(공용 시노님 포함)를 훑는다. ③ 스키마마다 logon 2회(getTables, getTableSpec) | 'ALL'은 IN 리스트 없이 `OWNER = :owner`만 쓰고, 개별 선택만 IN을 쓴다(500개 단위로 나누는 방식은 `dataPumpModel.loadTableSizes` 참고). 시노님은 스키마당 1회 `TABLE_OWNER = :owner`로 읽어 앱에서 필터한다. 한 요청은 커넥션 1개로 처리한다 |
| Data Pump (화면 진입) | `services/dataPumpService.ts:1103` (`Promise.all`) → `dataPumpModel.ts:139` getEdition, `:131` getDirectories, `:171` getSchemas, `:155` getDbLinks, `:289` getFilterEnv | V$VERSION, DBA_DIRECTORIES, DBA_USERS, ALL_DB_LINKS, *_EXPORT_OBJECTS, V$INSTANCE | 화면 진입·DB 전환(클릭) | N배. **한 번에 동시 logon 4~5회** | 중 | 쿼리 자체는 가볍지만 함수마다 `withConnection`으로 따로 접속하고 `Promise.all`로 동시에 연다. 한 사용자가 화면을 열 때마다 같은 DB에 순간 logon이 4~5회 몰린다 | 한 커넥션에서 순서대로 읽도록 묶는다(`getMeta(connection)` 하나). 에디션·디렉터리·링크·스키마 목록은 dbmsid별 TTL 10분 캐시(filterEnv는 이미 캐시됨) |
| Data Pump (작업 현황) | `models/dataPumpModel.ts:702` getJobs | DBA_DATAPUMP_JOBS, **DBA_OBJECTS(`object_name IN (...)`, owner 조건 없음)**, V$SESSION_LONGOPS | **15초 폴링**(탭이 보일 때만, `JobsTab.tsx:209`) | N배. 사용자당 분당 logon 4회 + 쿼리 12회 | 중 | ATTACH 없이 읽기만 하는 점은 이미 개선돼 양호하다. 그러나 DBA_OBJECTS를 owner 없이 이름으로만 찾아 obj$ 인덱스(owner# 선두)를 못 탄다. 오브젝트가 많은 DB에서는 obj$ 전체 스캔이 될 수 있다. 사용자마다 따로 폴링한다 | `owner = :ownerN AND object_name = :jobN` 쌍 조건으로 바꾼다(작업의 OWNER_NAME을 이미 알고 있음). 같은 DB를 보는 사용자끼리 결과를 공유한다(3.2 방식, TTL 10초). 작업이 없으면 DBA_DATAPUMP_JOBS만 조회하고 끝난다(현재도 그렇게 동작함) |
| Data Pump (이력 동기화) | `services/dataPumpHistoryService.ts:181` syncRunning → `dataPumpModel.ts:843` jobExists, `:880` readLog, `:855` getFileSizes | DBA_DATAPUMP_JOBS, BFILE(로그 512KB), UTL_FILE.FGETATTR | **매분**(스케줄러) + 이력 화면 조회 시 | 사용자 수와 무관. 대신 **실행 중 작업 수만큼 매분 logon**(분할 20개면 같은 DB에 분당 20회) | 중 | 작업마다 `withConnection`을 새로 연다. 같은 DB의 작업 여러 개를 한 커넥션·한 쿼리로 확인하지 않는다 | dbmsid별로 묶어 커넥션 1개에서 `SELECT owner_name, job_name FROM dba_datapump_jobs`를 한 번만 읽고, 앱에서 대조한다. 끝난 작업의 로그·파일 크기도 같은 커넥션에서 읽는다 |
| Data Pump (분할 계획) | `models/dataPumpModel.ts:182` loadTableSizes (`:243` getTableSizes, `:256` getListSizing) | **DBA_SEGMENTS 2회**(테이블 + LOB 조인), DBA_LOBS, DBA_TABLES, DB 링크 사용 시 `@link` 원격 | 클릭(계획 만들기). TTL 10분 캐시 있음 | N배이지만 같은 키는 캐시와 single-flight로 1회 | 중 | DBA_SEGMENTS는 사전 뷰 중 가장 무거운 축이다. OWNER 조건이 있어도 파티션·LOB이 많은 스키마(수십만 세그먼트)는 수십 초 걸린다. DB 링크면 원격 DB에서 같은 비용이 들고 네트워크도 탄다. 캐시(`dataPumpSizeCache.ts`)와 동시 요청 합치기는 이미 잘 돼 있다 | ① 스키마 모드는 `DBA_SEGMENTS` 대신 `DBA_TABLES.BLOCKS × block_size`(통계 기준) 근사치를 기본으로 하고, 정확한 크기는 "세그먼트 기준 다시 계산" 버튼으로 받는다. ② 3.1 세마포어의 "무거운 작업" 등급에 포함한다 |
| Data Pump (파티션) | `models/dataPumpModel.ts:568` getRangePartitionedTables | DBA_PART_TABLES, DBA_PART_KEY_COLUMNS, DBA_TAB_COLUMNS, **테이블마다 DBA_TAB_PARTITIONS COUNT(*) 상관 서브쿼리** | 클릭(스키마 선택) | N배, 캐시 없음 | 중 | 인터벌 파티션 테이블이 많고 파티션 수가 수천 개면 테이블마다 COUNT를 한 번씩 한다 | `DBA_TAB_PARTITIONS`를 `table_owner = :owner`로 한 번만 GROUP BY해서 조인한다. 결과를 `cached()`로 TTL 10분 캐시한다(같은 서비스의 `cachedTablePartitions`와 같은 방식) |
| Real-Time (세션 상세) | `models/realtimeModel.ts:381` loadAshSummary | V$ACTIVE_SESSION_HISTORY, (메모리 ASH 범위 밖이면) **DBA_HIST_ACTIVE_SESS_HISTORY** + DBA_HIST_SNAPSHOT, V$ASH_INFO, DBA_USERS | 클릭(세션·실행 더블클릭) | N배 | 중 | dbid와 snap_id 범위로 파티션을 좁히는 점은 양호하다. 그러나 ① from/to **기간 길이에 상한이 없다**(`controllers/realtimeController.ts:13`는 형식만 검사). 요청을 조작하면 AWR 보관 기간 전체(기본 8일)의 ASH를 읽을 수 있다. ② `instance_number` 조건이 없어 RAC에서 모든 인스턴스를 읽는다. 같은 SID의 다른 인스턴스 세션이 섞이는 기능 오류이기도 하다 | 기간 상한을 둔다(예: 최대 2시간, 서버에서 강제). `h.instance_number = SYS_CONTEXT('USERENV','INSTANCE')`(V$ 기준과 일치)를 추가한다. 결과 상한 20000은 유지한다 |
| Stats Job | `models/statsJobModel.ts:26` getJobStatus | DBA_SCHEDULER_JOBS(`UPPER(job_name) LIKE '%STAT%'`), **DBA_SCHEDULER_JOB_RUN_DETAILS(job_name IN, 기간·owner 조건 없음) + ROW_NUMBER** | 화면 진입 + 실행 중인 잡이 있으면 **2초 폴링, 최대 30회**(`client/src/pages/statsJob/App.tsx:102`) | N배 | 중 | 실행 이력 뷰는 보관 기간(기본 30일) 전체가 쌓여 있다. 자주 도는 잡이면 수만~수십만 행을 윈도우 함수로 정렬한다. 2초 폴링마다 logon도 한다 | `log_date > SYSTIMESTAMP - INTERVAL '7' DAY`와 owner 조건을 추가한다. 폴링 주기를 2초에서 10초로 늘리고, 실행 확인 중에는 DBA_SCHEDULER_RUNNING_JOBS만 가볍게 확인한다. `UPPER(...) LIKE '%STAT%'`은 잡 수가 적어 영향이 미미하므로 유지 가능 |
| Daily Monitoring | 태스크 16 longSessionCheck, 17 longTransactionCheck | GV$SESSION(ROWNUM 30), GV$SESSION × GV$TRANSACTION | 클릭 + 매일 | N배 | 하 | RAC 전체 세션을 봐야 하는 점검이라 GV$ 사용이 타당하다. 16번은 행 상한도 있다. 17번은 상한이 없지만 3시간 넘는 트랜잭션만이라 적다 | 17번에 `FETCH FIRST 100 ROWS ONLY` |
| Daily Monitoring | 태스크 1 instanceInfo, 2 databaseInfo, 20 keystoreCheck | GV$INSTANCE, **GV$DATABASE**, GV$ENCRYPTION_WALLET | 클릭 + 매일 | N배 | 하 | 인스턴스별 정보라 GV$INSTANCE·GV$ENCRYPTION_WALLET은 타당하다. GV$DATABASE는 모든 인스턴스가 같은 값이라 불필요한 인스턴스 간 조회다 | 2번은 `V$DATABASE`로 바꾼다 |
| Daily Monitoring | 태스크 3~5, 8~15, 19, 23, 24 | V$RESOURCE_LIMIT, V$CONTROLFILE, V$LOG/V$LOGFILE, V$TEMPFILE, DBA_TABLESPACES(STATUS 조건), V$RECOVER_FILE, V$LIBRARYCACHE, V$SYSSTAT, V$ROWCACHE, DBA_SCHEDULER_JOBS, V$SPPARAMETER, V$RECOVERY_AREA_USAGE | 클릭 + 매일 | N배 | 하 | 행 수가 작은 동적 뷰다. V$RECOVER_FILE은 데이터파일 헤더를 읽지만 하루 1회 수준이면 무시할 만하다 | 수동 실행 single-flight(위)로 충분 |
| Real-Time (세션 상세) | `models/realtimeModel.ts:292` loadSession, `:433` loadSql | V$SESSION+V$PROCESS(sid 조건), V$SQL(sql_id, ROWNUM=1), DBA_HIST_SQLTEXT(dbid+sql_id), DBA_HIST_SQLSTAT+SNAPSHOT(dbid+sql_id+최근 7일 snap_id) | 클릭 | N배 | 하 | 모두 키 조건(sid, sql_id, dbid+snap_id)이 있다. V$SQL은 sql_id 고정 인덱스를 탄다 | 없음. SQLSTAT에 `instance_number` 조건을 추가하면 약간 더 줄어든다 |
| Data Pump | `models/dataPumpModel.ts:880` readLog (로그 창) | BFILE → 임시 CLOB(최대 512KB) | 로그 창이 열려 있고 작업이 실행 중이면 15초 폴링 | N배 | 하 | 읽을 때마다 임시 LOB을 만든다. 크기 상한이 있어 영향은 작다 | 직전에 읽은 길이를 기억해 늘어난 부분만 읽는다(offset) |
| Data Pump | `:310` getViews, `:319` getCurrentScn, `:604` loadTablePartitions(캐시), `:790` writeFiles, `:855` getFileSizes, `:773` cancelJob | DBA_VIEWS(owner), V$DATABASE, DBA_PART_*·DBA_TAB_PARTITIONS·DBA_SEGMENTS(owner+segment_name), UTL_FILE, DBMS_DATAPUMP.ATTACH(취소 시에만) | 클릭 | N배 | 하 | 키 조건이 있거나 사용자가 명시적으로 실행하는 단발성 작업이다. loadTablePartitions의 DBA_SEGMENTS도 owner+segment_name 조건이라 범위가 한 테이블이다 | 없음 |
| Data Pump (파티션 비우기) | `models/dataPumpModel.ts:693` truncatePartitions | `ALTER TABLE ... TRUNCATE PARTITION ... UPDATE INDEXES` | 클릭(확인 후) | — | 하 (의도된 쓰기) | 사용자가 확인한 DDL이다. 글로벌 인덱스 유지 비용이 있다 | 없음(현재 확인 절차 유지) |
| 계정·권한 비교 | `models/securityCompareModel.ts:113` getLists, `:126` getSnapshot | DBA_USERS, DBA_ROLES, DBA_PROFILES, DBA_TS_QUOTAS, DBA_SYS_PRIVS, DBA_ROLE_PRIVS×2, DBA_TAB_PRIVS, DBA_COL_PRIVS (grantee IN, 최대 500개) | 클릭 | N배 | 하 | 이름 조건으로 좁혀 읽는다. 다만 IN 리스트 길이가 매번 달라 하드 파스가 생긴다 | 바인드 개수를 10/50/100/500 단위로 올림하고 남는 칸은 NULL로 채워 SQL 문장 종류를 줄인다 |
| Parameter Compare | `models/parameterCompareModel.ts:63` getParameters | X$KSPPI+X$KSPPSV → SYS.X_$ → V$SYSTEM_PARAMETER 순으로 시도, V$INSTANCE | 클릭 | N배 | 하 | 약 5천 행 고정 크기다. 권한이 없으면 실패한 시도 2회가 매번 반복된다 | 어느 소스가 성공했는지 dbmsid별로 기억해 다음부터 바로 그 쿼리를 쓴다 |
| Object Compare | `models/objectCompareModel.ts:154` getSchemas, `:165` loadTablespaces, `:204` loadTables, `:368` loadSequences, `:389` loadSynonyms, `:512` getSourceLines | DBA_USERS, DBA_TABLESPACES+DATA/TEMP_FILES, DBA_TABLES(owner), DBA_SEQUENCES, DBA_SYNONYMS(owner), DBA_SOURCE/DBA_VIEWS(오브젝트 하나) | 클릭 | N배 | 하 | owner 또는 이름 조건으로 범위가 좁다 | 없음(상위 행의 캐시·세마포어로 함께 해결) |
| ILM | `models/ilmJobModel.ts:33,72,121` | PGDBA.DEL_JOB_TABLE_LIST(소형 관리 테이블) SELECT/UPDATE/INSERT | 클릭 | N배 | 하 | 작은 관리 테이블이다. 쓰기는 PK 한 행 단위다 | 없음 |
| Stats Job (실행) | `models/statsJobModel.ts:96` runJob | DBA_SCHEDULER_JOBS(이름), DBMS_SCHEDULER.RUN_JOB(use_current_session=FALSE) | 클릭 | — | 하 | 잡 실행 자체는 사용자가 의도한 작업이다. 백그라운드로 실행되므로 앱 세션을 오래 잡지 않는다 | 없음 |
| 접속 테스트 | `models/dbmsModel.ts:212` testConnection | (logon만) | 클릭 | N배 | 하 | 접속 타임아웃(10초)과 callTimeout(5초, 실제 약 10초)이 걸려 있다 | 없음 |
| 예약 일일점검 | `services/scheduler.ts` runScheduledReports | 위 Daily Monitoring 태스크 | 매일 1회, DB마다 순차 | 1 | 하 | DB마다 커넥션 1개로 순차 실행하고, 타임아웃 시 재접속하며, tick 중복 방지가 반영돼 있다 | 태스크별 개선(위)만 반영하면 된다 |
| queries/ | `queries/dailyChecks.ts` | — | **실행 안 됨** | — | — | 어디서도 import하지 않는 참고용 SQL 모음이다(`grep` 확인). 대상 DB에 나가지 않는다 | 태스크로 옮길 때 이 보고서 기준으로 다시 검토 |

---

## 2. 공통 구조 문제 상세

### 2.1 접속 횟수 (logon storm)
- 현재 모든 대상 DB 호출은 `db.ts` `connectDB()`로 **새 접속 → 작업 → close**를 반복한다(풀 없음).
- logon 1회는 서버 프로세스 생성(dedicated 서버), 인증, 세션 초기화, 감사 기록이다. 감사 정책에 따라 `AUD$`/Unified Audit Trail에 1행이 남는다. logon 트리거가 있는 DB라면 그 비용도 더해진다.
- 분당 logon 발생량:

| 발생원 | 분당 logon |
|---|---|
| Real-Time 1명 | 30회 |
| Data Pump 작업 현황 1명 | 4회 |
| Data Pump 이력 동기화 | 실행 중 작업 수만큼 |
| Stats Job 실행 확인 중 | 30회 |
| Data Pump 화면 진입 | 순간 4~5회 동시 |

### 2.2 동시 세션 상한 없음
- 같은 대상 DB에 앱이 동시에 여는 세션 수를 제한하는 장치가 없다.
- 예: 3명이 Object Compare(50스키마), Data Pump 계획(DBA_SEGMENTS), Table Spec(전체 스키마)을 동시에 누르면 무거운 사전 조회 세션 3개가 무제한 시간으로 같은 사전 테이블(obj$, seg$, source$)을 동시에 읽는다.
- 같은 사용자가 버튼을 연타해도 막지 않는다. 화면에서 버튼을 비활성화하는 곳은 있지만 서버에는 장치가 없다.

### 2.3 세션 식별 불가
- `connection.module`/`action`/`clientId`를 설정하는 코드가 없다(`grep` 확인).
- 대상 DB DBA가 V$SESSION에서 보면 PROGRAM=`node.exe`(또는 `node`), MODULE=`node.exe`뿐이다. 어떤 기능이 누구의 요청으로 돌고 있는지 알 수 없다.
- Thick 모드에서 이 값들은 다음 왕복에 실려 가므로 추가 왕복이 없다.
- 제안:
  - `module = 'DBCockpit'`
  - `action = '<기능>:<세부>'` (예: `Monitor:task18`, `Realtime:poll`, `ObjCompare:SCOTT`, `DataPump:plan`)
  - `clientId = <앱 로그인 사용자명>`
- `initOracleClient({ driverName: 'DBCockpit : 1.0' })`를 주면 V$SESSION_CONNECT_INFO.CLIENT_DRIVER에도 남는다.
- 이렇게 하면 4.3의 Resource Manager를 MODULE 기준으로 매핑할 수 있다.

### 2.4 결과 행 수 상한 없음
- `maxRows`를 지정하는 곳이 없어 기본값인 무제한이다. 행 상한을 SQL 안에 둔 곳은 Real-Time 2곳(ROWNUM 2000/20000)과 태스크 16(ROWNUM 30)뿐이다.
- 사용자 등록 SQL이 수십만 행을 돌려주면, 대상 DB에서 그만큼 fetch 왕복이 생긴다. 앱 메모리를 쓰고, 메타 DB 실행 이력(JSON CLOB)에도 저장된다.
- 제안: `executeQuery`에 `maxRows: 1000`을 주고, 잘렸으면 결과에 `truncated: true`를 넣어 화면과 리포트에 표시한다.

### 2.5 대상 계정 권한
- 운영 시드(`scripts/monitoring_queries_insert.sql` 앞부분)를 보면 대상 DB 등록 계정이 **SYSTEM**이다.
- 이 파일에는 운영 DB 계정의 **평문 비밀번호가 git에 커밋**돼 있다. 부하 문제와는 별개지만 즉시 조치가 필요하다: 비밀번호 교체 + 파일 정리, 필요하면 git 이력 정리.
- SYSTEM으로 접속하면 다음 문제가 있다.
  - 점검 SQL·Compare가 실수로 DDL/DML을 실행해도 막을 수 없다.
  - PROFILE과 Resource Manager로 앱만 따로 제한하기 어렵다(같은 계정을 DBA도 씀).

---

## 3. 개선 설계안 (앱 쪽)

### 3.1 대상 DB별 풀 + 세마포어 (동시 세션 상한)
- **구현:** 대상 DB마다 작은 `oracledb.createPool`을 lazy하게 만든다(dbmsid → pool 맵). 등록 정보가 수정·삭제되면 해당 풀을 닫는다.
  - `poolMin: 0`, `poolMax: 3`, `poolIncrement: 1`
  - `poolTimeout: 60`: 1분 동안 쓰지 않은 세션은 닫아 대상 DB에 상주 세션을 남기지 않는다.
  - `queueMax: 20`, `queueTimeout: 30000`: 넘치면 "대상 DB가 바쁩니다" 에러로 빨리 실패한다.
- **효과:** logon storm이 사라진다(2초 폴링도 같은 세션을 재사용). 풀 크기 자체가 **대상 DB별 동시 세션 상한**이 된다.
- **무거운 작업 등급:** Object Compare 스냅샷, Data Pump 크기 계산, Table Spec 엑셀, 수동 일일점검은 풀과 별도로 dbmsid별 **세마포어 1**(앱 메모리 카운터 + 대기열)을 거친다. 이렇게 하면 무거운 작업이 동시에 1개만 돌고, 가벼운 조회(목록·상세·폴링)는 남은 슬롯을 쓴다.
- **세션 초기화:** 풀 세션 재사용 시 `callTimeout`과 `module/action`을 매번 설정하고, 사용 후 `callTimeout = 0`으로 되돌린다. 타임아웃·연결 끊김(NJS-500/NJS-003)이 난 커넥션은 `close({ drop: true })`로 풀에서 버린다. `services/dbmsService.ts` getMonResult의 재접속 로직은 "풀에서 새로 받기"로 바뀐다.
- **주의:** 풀 세션은 상주하므로 대상 DB의 `SESSIONS_PER_USER`(4.2)를 풀 크기 합계 + 여유로 맞춘다. Data Pump DBMS_DATAPUMP 작업(startJob)은 시작 후 바로 DETACH하므로 풀 세션을 오래 잡지 않는다.

### 3.2 Real-Time 공유 폴러 (사용자 간 폴링 공유)
- **구조:** 서버에 `RealtimePoller` 맵(dbmsid → poller)을 둔다.
  - 클라이언트가 `getSnapshot`을 호출하면 그 dbmsid의 poller를 깨우고 `lastRequestedAt`을 갱신한다.
  - poller는 `lastRequestedAt`이 15초 이내인 동안 **2초마다 한 번만** 대상 DB를 조회한다. 이전 조회가 끝난 뒤 다음 조회를 예약하므로(setTimeout 체인) 요청이 겹치지 않는다.
  - 아무도 요청하지 않으면 멈추고 풀 세션을 반납한다.
- **세션 목록:** 최신 스냅샷 1개를 보관하고 모든 클라이언트에 그대로 돌려준다.
- **ASH 실행 목록:**
  - poller가 `sample_time > :lastSampleTime`만 읽는다. 처음 시작할 때만 10분을 읽는다.
  - 결과를 앱 메모리의 10분 창(실행 키 `sid,serial,sql_id,sql_exec_id` → 누적 집계)에 합친다.
  - 각 클라이언트는 자기 `since` 이후에 갱신된 실행만 메모리에서 걸러 받는다. 대상 DB 쿼리가 "10분 GROUP BY"에서 "직전 2초분 샘플"로 줄어든다.
- **효과:** 같은 DB를 N명이 보는 경우 대상 DB 부하가 N배에서 1배가 된다. logon은 풀 재사용으로 0이다.
- **클라이언트:** `setInterval`을 "응답 후 2초 뒤 다음 요청"으로 바꾸고, `document.visibilityState === 'hidden'`이면 멈춘다(Data Pump 화면의 `whenVisible`과 같은 방식).

### 3.3 결과 캐시 (TTL)
`services/dataPumpSizeCache.ts`의 `cached(key, load, refresh)`를 범용 모듈로 옮겨 재사용한다. 이 함수는 TTL, 동시 요청 합치기(single-flight), 크기 제한을 이미 갖추고 있다.

| 대상 | 키 | TTL | 비고 |
|---|---|---|---|
| 수동 일일점검 결과 | dbmsid | 60초 | 화면에 "N초 전 결과 · 다시 실행" |
| Object Compare 스냅샷 | dbmsid + owner + types | 10분 | "새로 읽기" 버튼 |
| Table Spec 스키마 목록 | dbmsid | 10분 | |
| Data Pump 화면 메타(에디션·디렉터리·링크·스키마) | dbmsid | 10분 | filterEnv는 이미 캐시됨 |
| Data Pump 파티션 테이블 목록 | dbmsid + owner | 10분 | |
| Data Pump 작업 현황 | dbmsid | 10초 | 사용자 간 공유 |
| Parameter Compare 소스 종류(X$/V$) | dbmsid | 프로세스 수명 | 실패 시도 반복 방지 |

### 3.4 점검 SQL 저장 검증
1장의 Scripts 행 참고. 서버(`services/dbmsService.ts` addScript/modifyScript)에서 거부 규칙을 적용하고, 경고는 응답에 담아 화면에 표시한다. 규칙은 단위 테스트로 고정한다.

### 3.5 타임아웃 후 정리
1장의 "공통(타임아웃 후 정리)" 행 참고. `connection.break()` 소프트 타임아웃이 1순위다. 서버 쪽 최종 방어는 Resource Manager다(4.3).

---

## 4. 대상 DB 쪽 보호장치 (DBA 작업)

### 4.1 모니터링 전용 계정
```sql
CREATE USER dbcockpit IDENTIFIED BY "<강한 비밀번호>" PROFILE dbcockpit_prof;
GRANT CREATE SESSION TO dbcockpit;
GRANT SELECT_CATALOG_ROLE TO dbcockpit;          -- DBA_*/V$ 조회
-- 기능별 추가 권한 (쓰는 기능만):
--   Real-Time 세션 상세 AWR:  SELECT ON dba_hist_* (SELECT_CATALOG_ROLE에 포함), Diagnostics Pack 라이선스 확인
--   Data Pump:                DATAPUMP_EXP_FULL_DATABASE / DATAPUMP_IMP_FULL_DATABASE, DIRECTORY READ/WRITE
--   Stats Job 실행:            해당 잡 소유자 권한 또는 MANAGE SCHEDULER (최소화)
--   ILM:                      SELECT, INSERT, UPDATE ON pgdba.del_job_table_list
--   Parameter Compare hidden: (선택) SELECT ON sys.x_$ksppi / x_$ksppsv 뷰
```
- 일일점검·Real-Time·Compare·Table Spec용 계정과 Data Pump·ILM처럼 쓰기가 있는 기능용 계정을 **둘로 나누는 것**을 권장한다. 앱에 DBMS 등록을 계정 2개로 할 수 있게 하는 변경이 필요하다.
- 읽기 계정은 DDL/DML 권한이 없으므로 2.5와 Scripts 검증 누락의 근본 대책이 된다.

### 4.2 PROFILE
```sql
CREATE PROFILE dbcockpit_prof LIMIT
  SESSIONS_PER_USER        6        -- 풀(3) + 무거운 작업 여유. 3.1 적용 전이면 Real-Time 사용자 수를 고려해 조정
  CPU_PER_CALL             6000     -- 호출당 CPU 60초(1/100초 단위). 넘으면 ORA-02393으로 그 호출만 중단
  LOGICAL_READS_PER_CALL   5000000  -- 호출당 논리 읽기 상한 (환경에 맞춰 측정 후 조정)
  IDLE_TIME                30       -- 분. 남은 세션 정리
  CONNECT_TIME             UNLIMITED;
-- 자원 제한이 동작하려면: ALTER SYSTEM SET resource_limit = TRUE;  (12c 이상 기본 TRUE)
```
- `CPU_PER_CALL`과 `LOGICAL_READS_PER_CALL`은 **서버에서 SQL을 직접 끊는다**. 3.5의 "클라이언트는 끊겼는데 서버에서 계속 도는 SQL"에 대한 최종 방어선이다.
- Data Pump 계정에는 걸지 않는다. 덤프 작업은 정상적으로 오래 걸린다.

### 4.3 Resource Manager
- 소비자 그룹 `DBCOCKPIT_GRP`을 만들고, 매핑 규칙을 `ORACLE_USER = DBCOCKPIT`(또는 2.3 적용 후 `MODULE_NAME = DBCockpit`)로 둔다.
- 활성 플랜에 다음 디렉티브를 넣는다.
  - `MGMT_P1`을 낮게(예: 업무 그룹보다 낮은 레벨): CPU 경합 시 업무 세션이 우선한다.
  - `SWITCH_GROUP => 'CANCEL_SQL'`, `SWITCH_TIME => 120`, `SWITCH_ESTIMATE => TRUE`: 120초가 넘거나 넘을 것으로 추정되는 SQL은 서버가 취소한다.
  - `MAX_EST_EXEC_TIME => 300`: 옵티마이저 추정이 5분을 넘는 SQL은 시작 전에 거부한다.
  - `PARALLEL_DEGREE_LIMIT_P1 => 1`: 앱 조회가 병렬로 퍼지지 않게 한다.
- Data Pump 워커는 작업 소유자의 소비자 그룹을 따른다. 별도 그룹(`DBCOCKPIT_DP_GRP`, 낮은 CPU 비중)에 매핑하면 "전체 실행"이 업무 시간에 미치는 영향이 줄어든다.

### 4.4 기타
- `sqlnet.ora`(서버): `SQLNET.EXPIRE_TIME = 10`. 클라이언트가 사라진 세션을 감지해 정리한다.
- ADR purge 정책: alert XML 크기를 제한해 태스크 25(V$DIAG_ALERT_EXT) 비용을 줄인다.
- logon 감사를 쓰고 있다면, 3.1 적용 전까지 앱 계정 logon이 감사 테이블에 미치는 증가량을 확인한다.

---

## 5. "특히 볼 것" 항목별 답

| 점검 항목 | 결과 |
|---|---|
| 무거운 뷰를 조건 없이 훑는 것 | **DBA_FREE_SPACE**(태스크 18·28, 조건 없이 전체 GROUP BY), **DBA_TABLES**(Table Spec getSchemas, DISTINCT), **DBA_SOURCE**(Object Compare, owner 조건은 있으나 스키마 전체 해시), **DBA_SEGMENTS**(Data Pump, owner 조건 있음·캐시 있음), **DBA_OBJECTS**(Data Pump getJobs, owner 없이 이름만), **DBA_SYNONYMS**(Table Spec, TABLE_OWNER 조건이라 인덱스 없음), **V$DIAG_ALERT_EXT**(태스크 25), **V$ASM_DISKGROUP**(태스크 7·22). DBA_EXTENTS, DBA_DEPENDENCIES, V$SQLAREA, V$SQL_PLAN, V$LOCK은 사용처 없음. V$SQL은 sql_id 조건으로만 사용 |
| 인덱스를 못 타는 함수 조건 | 태스크 27 `to_char(createtime,...) = ...`(전체 스캔). Stats Job `UPPER(job_name) LIKE '%STAT%'`(대상 뷰가 작아 영향 미미). 태스크 18 `regexp_like(tablespace_name, ...)`(DBA_TABLESPACES라 작음). 태스크 25 `LIKE '%ORA-%'`(뷰 특성상 어차피 전체 파싱) |
| ASH/AWR 범위 | Real-Time 폴링 ASH: 항상 `sample_time > SYSDATE-10분`으로 좁다. 세션 상세 ASH: from/to 범위가 있으나 **길이 상한이 없다**(중). DBA_HIST_ACTIVE_SESS_HISTORY: dbid·snap_id 범위는 있고 **instance_number가 없다**. DBA_HIST_SQLSTAT: dbid·snap_id(7일)·sql_id 조건 있음, instance_number 없음(합산 목적이라 허용). DBA_HIST_SQLTEXT: dbid+sql_id |
| 결과 행 수 상한 | 없는 곳: 일일점검 태스크 대부분, Table Spec, Object Compare, Stats Job 실행 이력, Data Pump 목록류. 있는 곳: Real-Time(2000/20000), 태스크 16(30), Data Pump 로그(512KB) |
| RAC GV$ | 불필요: GV$LOG_HISTORY(태스크 6, 중복 집계로 값도 틀림), GV$DATABASE(태스크 2). 타당: GV$INSTANCE, GV$SESSION, GV$TRANSACTION, GV$ENCRYPTION_WALLET. Real-Time은 V$(접속한 인스턴스만)라 부하 측면은 안전하나, RAC 다른 인스턴스 세션은 보이지 않는다(기능 한계) |
| 폴링 | Real-Time 2초(사용자별, 겹침 가능, 숨김 탭에서도 계속): 상. Data Pump 작업 현황 15초(숨김 탭 정지): 중. Stats Job 2초 × 최대 30회: 중. 공유 캐시는 3.2 설계로 가능 |
| 접속 횟수 | 모든 요청이 logon/logoff(2.1). 3.1 풀로 해결 |
| 동시 실행 제한 | 없음(2.2). 3.1 세마포어로 해결 |
| 세션 식별 | 없음(2.3) |
| 타임아웃 후 서버 정리 | 없음. 1장 "공통(타임아웃 후 정리)" 행, 3.5, 4.2·4.3 참고 |
| Data Pump | 크기 계산: DBA_SEGMENTS 2회(owner 조건, TTL 10분 캐시와 single-flight 있음, 중). LONGOPS 폴링: 15초, 숨김 탭 정지, ATTACH 없음(양호). ATTACH: 작업 취소 클릭 시에만. 이력 동기화: 매분 작업별 logon(중) |
| Scripts 검증 | 없음. DDL도 실행 가능(상) |
