-- 일일점검 보안성 이상 징후 탐지 태스크 (로그인 실패/계정 잠김 / SQL Injection 의심 패턴 / 과다 파싱).
--
-- 참고용 기록 파일입니다 — 이 파일 자체를 실행하는 것이 아니라, 아래 내용을 화면에서
-- 직접 등록합니다:
--   1) Scripts 화면(Add) : NAME + SQL 입력
--   2) Thresholds 화면(Add) : 해당 task 선택 후 컬럼/조건/레벨/메시지 입력
-- 기존 monitoring_tasks/monitoring_thresholds 구조를 그대로 쓰므로 스키마 변경 없음.
--
-- v2: 첫 버전 검토 중 발견된 문제 수정 —
--   - ORA-01017(단순 비번 오류)은 alert log에 안 남는 게 보통이라 탐지 안 됨 → 범위를
--     alert log에 실제로 남는 ORA-28000(계정 잠김)으로 좁히고, 진짜 시도 횟수가 필요하면
--     Unified Audit 기반 쿼리를 옵션으로 추가 (감사 꺼져있으면 그냥 0건, 에러는 안 남).
--   - ORA-01031은 로그인 실패가 아니라 권한부족 에러라 제거 (무관한 노이즈).
--   - XP_CMDSHELL은 SQL Server 전용이라 Oracle에선 절대 안 걸림 → 삭제.
--   - UNION SELECT 단독 조건은 리포트 SQL에서도 흔해서 오탐 많음 → 딕셔너리 뷰 접근과
--     결합된 경우로 좁힘.
--   - 세미콜론+DML 패턴은 PL/SQL 블록(BEGIN...END)의 정상 세미콜론까지 걸려서
--     command_type으로 순수 SELECT/DML만 보도록 제한.
--   - 어떤 패턴에 걸렸는지 보이게 SECURITY_FLAG 대신 MATCH_REASON 컬럼으로 변경.
--   - DBA_TABLES/DBA_OBJECTS 등 딕셔너리 뷰 직접 조회(스키마 정보 수집 의심) 패턴 추가.
--   - threshold의 PATTERN 조건유형은 연산자를 무시하고 포함(includes) 여부만 본다는 실제
--     평가 로직(services/dbmsService.ts)에 맞춰 안내 문구 수정 (이전 "IS NOT NULL"은 실제로
--     존재하지 않는 옵션이었음).
-- v3: 3) 과다 파싱 탐지를 v$sqlarea VERSION_COUNT → alert log의 "too many parse errors"로 교체.

-- ============================================================
-- 1) 계정 잠김 탐지 (accountLockCheck)
-- ============================================================
-- alert log에 실제로 남는 건 ORA-28000(계정 잠김)뿐입니다. 기존 'alertLog' 태스크와 같은
-- V$DIAG_ALERT_EXT를 쓰므로 추가 권한 불필요.

SELECT COUNT(*) LOCK_COUNT,
       MAX(ORIGINATING_TIMESTAMP + INTERVAL '9' HOUR) LAST_SEEN
  FROM V$DIAG_ALERT_EXT
 WHERE ORIGINATING_TIMESTAMP > SYSDATE - 1
   AND MESSAGE_TEXT LIKE '%ORA-28000%';

-- Thresholds 화면에 등록할 값:
--   컬럼명 : LOCK_COUNT
--   조건유형 : NUMERIC
--   연산자 : >
--   값 : 0
--   레벨 : ERROR
--   메시지 : 최근 1일 내 계정 잠김(ORA-28000) 발생 — 반복 로그인 실패로 인한 잠김 의심


-- ============================================================
-- 1-옵션) 로그인 실패 "시도" 횟수 탐지 (Unified Audit 필요)
-- ============================================================
-- 잠기기 전의 순수 실패 시도 횟수까지 보려면 alert log가 아니라 감사 데이터가 필요합니다.
-- 이 DB에 Unified Auditing이 켜져 있고 로그온 실패를 감사하는 정책이 있을 때만 값이 나옵니다
-- (꺼져있으면 에러 없이 그냥 0건으로 조용히 빈 결과). 먼저 아래로 확인:
--   SELECT * FROM V$OPTION WHERE PARAMETER = 'Unified Auditing';
--   SELECT policy_name, enabled_opt FROM audit_unified_enabled_policies;

SELECT dbusername, userhost,
       COUNT(*) FAIL_COUNT,
       MAX(event_timestamp) LAST_SEEN
  FROM unified_audit_trail
 WHERE event_timestamp > SYSDATE - 1
   AND action_name = 'LOGON'
   AND return_code != 0
 GROUP BY dbusername, userhost;

-- Thresholds 화면에 등록할 값:
--   컬럼명 : FAIL_COUNT
--   조건유형 : NUMERIC
--   연산자 : >
--   값 : 20
--   레벨 : WARN
--   메시지 : 최근 1일 로그인 실패 20건 초과 (userhost 기준) — 비정상 접속 시도 의심


-- ============================================================
-- 2) SQL Injection 의심 패턴 탐지 (sqlInjectionPatternCheck)
-- ============================================================
-- V$SQL은 shared pool에 남아있는 최근 SQL만 보여서 완전한 탐지는 아니고,
-- 눈에 띄는 패턴만 걸러내는 보조 체크입니다. command_type으로 순수 SELECT/DML만 봐서
-- PL/SQL 블록의 정상적인 세미콜론은 걸리지 않게 했습니다.

SELECT sql_id, parsing_schema_name AS schema_name,
       SUBSTR(sql_text, 1, 200) AS sql_preview,
       executions, last_active_time,
       CASE
         WHEN REGEXP_LIKE(sql_text, 'UNION[[:space:]]+(ALL[[:space:]]+)?SELECT.*(ALL_|DBA_|USER_)(TAB|USERS|COL)', 'i')
           THEN 'UNION+딕셔너리뷰 조회 의심(스키마 열거)'
         WHEN REGEXP_LIKE(sql_text, '(''|[[:space:]])OR[[:space:]]+''?1''?[[:space:]]*=[[:space:]]*''?1', 'i')
           THEN '항상 참 조건 의심(OR 1=1류)'
         WHEN REGEXP_LIKE(sql_text, ';[[:space:]]*(DROP|DELETE|UPDATE|INSERT)[[:space:]]', 'i') AND command_type IN (2, 3, 6, 7)
           THEN '쿼리 스태킹 의심(세미콜론+DML)'
         WHEN REGEXP_LIKE(sql_text, '(DBA_TABLES|DBA_OBJECTS|DBA_USERS|DBA_TAB_COLUMNS|DBA_ROLE_PRIVS|DBA_SYS_PRIVS)', 'i')
           THEN 'DBA_* 딕셔너리뷰 직접 조회 의심(스키마 정보 수집)'
       END AS MATCH_REASON
  FROM v$sql
 WHERE last_active_time > SYSDATE - 1
   AND parsing_schema_name NOT IN ('SYS', 'SYSTEM')
   AND (
        REGEXP_LIKE(sql_text, 'UNION[[:space:]]+(ALL[[:space:]]+)?SELECT.*(ALL_|DBA_|USER_)(TAB|USERS|COL)', 'i')
     OR REGEXP_LIKE(sql_text, '(''|[[:space:]])OR[[:space:]]+''?1''?[[:space:]]*=[[:space:]]*''?1', 'i')
     OR (REGEXP_LIKE(sql_text, ';[[:space:]]*(DROP|DELETE|UPDATE|INSERT)[[:space:]]', 'i') AND command_type IN (2, 3, 6, 7))
     OR REGEXP_LIKE(sql_text, '(DBA_TABLES|DBA_OBJECTS|DBA_USERS|DBA_TAB_COLUMNS|DBA_ROLE_PRIVS|DBA_SYS_PRIVS)', 'i')
   );

-- Thresholds 화면에 등록할 값 (실제 평가 로직 기준 — services/dbmsService.ts의 evaluateThreshold):
--   PATTERN 조건유형은 연산자 값과 무관하게 "포함(includes)" 여부만 봅니다. MATCH_REASON은
--   매칭된 4가지 경우 모두 '의심'이라는 단어를 포함하도록 맞췄으니 그걸 기준으로 잡으면 됩니다.
--   컬럼명 : MATCH_REASON
--   조건유형 : PATTERN
--   연산자 : 아무 값(평가 시 무시됨) — 화면에서 필수로 받으면 LIKE로 채우기
--   값 : 의심
--   레벨 : ERROR
--   메시지 : SQL Injection 의심 패턴 탐지됨 — MATCH_REASON/sql_preview 확인 필요


-- ============================================================
-- 3) 과다 파싱 오류 탐지 (tooManyParseErrorCheck)
-- ============================================================
-- v3: 이전 버전(v$sqlarea VERSION_COUNT)은 VPD/NLS/cursor_sharing 등 보안과 무관한 이유로도
-- 높아지는 일반 파싱 효율 지표라 오탐이 많아 alert log 기반으로 교체.
-- 12.2부터 같은 SQL이 파싱 오류를 반복하면(기본 100회마다) alert log에
--   "WARNING: too many parse errors, count=100 SQL hash=0x1a2b3c4d"
--   "PARSE ERROR: ospid=12345, error=942 for statement: ..."
-- 가 남습니다. 없는 테이블/컬럼 추측, 문법 깨진 injection 시도 등이 여기에 걸립니다.
-- 1) 계정 잠김과 같은 V$DIAG_ALERT_EXT라 추가 권한 불필요. 12.1 이하는 메시지 자체가 없어 0건.
--
-- 경고 뒤에 같은 프로세스가 이어서 남기는 레코드(19c 기준 형식):
--   PARSE ERROR: ospid=12345, error=942 for statement:
--   SELECT * FROM no_such_table                                  ← SQL 구문
--   Additional information: hd=0x... phd=0x... ... sqlid=fq2cmmv4hv5nm   ← SQL_ID
--   ...Current username=SCOTT
-- 그래서 WARNING 레코드부터 같은 PROCESS_ID의 다음 레코드 5개를 이어붙인 뒤(WIN) 정규식으로 뽑습니다.
-- 버전/형식 차이로 해당 줄이 없으면 그 컬럼만 NULL (에러는 안 남). 각 조각을 잘라 붙이는 건
-- VARCHAR2 4000 한도(ORA-01489) 때문이고, 그래서 긴 SQL은 앞부분만 나옵니다 (SQL_ID로 V$SQL 등에서 확인).

SELECT SQL_HASH, SQL_ID, USERNAME, ERROR_CODE,
       COUNT(*) AS WARN_COUNT,
       MAX(PARSE_ERRORS) AS MAX_PARSE_ERRORS,
       MAX(SQL_TEXT) AS SQL_TEXT,
       MAX(LOG_TIME) AS LAST_SEEN
  FROM (
        SELECT REGEXP_SUBSTR(MSG, 'SQL hash=(0x[0-9a-fA-F]+)', 1, 1, NULL, 1) AS SQL_HASH,
               TO_NUMBER(REGEXP_SUBSTR(MSG, 'count=([0-9]+)', 1, 1, NULL, 1)) AS PARSE_ERRORS,
               REGEXP_SUBSTR(WIN, 'error=([0-9]+)', 1, 1, NULL, 1) AS ERROR_CODE,
               REGEXP_SUBSTR(WIN, 'sqlid=([0-9a-z]+)', 1, 1, NULL, 1) AS SQL_ID,
               REGEXP_SUBSTR(WIN, 'Current username=([^[:space:]]+)', 1, 1, NULL, 1) AS USERNAME,
               SUBSTR(TRIM(NVL(REGEXP_SUBSTR(WIN, 'for statement:(.*?)Additional information', 1, 1, 'n', 1),
                               REGEXP_SUBSTR(WIN, 'for statement:(.*)', 1, 1, 'n', 1))), 1, 1000) AS SQL_TEXT,
               LOG_TIME
          FROM (
                SELECT MESSAGE_TEXT AS MSG,
                       ORIGINATING_TIMESTAMP + INTERVAL '9' HOUR AS LOG_TIME,
                       SUBSTR(MESSAGE_TEXT, 1, 400)
                       || CHR(10) || SUBSTR(LEAD(MESSAGE_TEXT, 1) OVER (PARTITION BY PROCESS_ID ORDER BY ORIGINATING_TIMESTAMP, RECORD_ID), 1, 1200)
                       || CHR(10) || SUBSTR(LEAD(MESSAGE_TEXT, 2) OVER (PARTITION BY PROCESS_ID ORDER BY ORIGINATING_TIMESTAMP, RECORD_ID), 1, 1200)
                       || CHR(10) || SUBSTR(LEAD(MESSAGE_TEXT, 3) OVER (PARTITION BY PROCESS_ID ORDER BY ORIGINATING_TIMESTAMP, RECORD_ID), 1, 600)
                       || CHR(10) || SUBSTR(LEAD(MESSAGE_TEXT, 4) OVER (PARTITION BY PROCESS_ID ORDER BY ORIGINATING_TIMESTAMP, RECORD_ID), 1, 300)
                       || CHR(10) || SUBSTR(LEAD(MESSAGE_TEXT, 5) OVER (PARTITION BY PROCESS_ID ORDER BY ORIGINATING_TIMESTAMP, RECORD_ID), 1, 200) AS WIN
                  FROM V$DIAG_ALERT_EXT
                 WHERE ORIGINATING_TIMESTAMP > SYSDATE - 1
               )
         WHERE MSG LIKE '%too many parse errors%'
       )
 GROUP BY SQL_HASH, SQL_ID, USERNAME, ERROR_CODE
 ORDER BY WARN_COUNT DESC;

-- Thresholds 화면에 등록할 값:
--   컬럼명 : WARN_COUNT
--   조건유형 : NUMERIC
--   연산자 : >
--   값 : 0
--   레벨 : WARN
--   메시지 : 최근 1일 내 too many parse errors 발생 — 동일 SQL 파싱 오류 반복 (잘못된 앱 SQL 또는 injection 시도 의심)
