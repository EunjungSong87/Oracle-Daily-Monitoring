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
-- 3) 과다 파싱(SQL 공유 안 됨) 탐지 (excessiveParseCheck)
-- ============================================================
-- bind variable 없이 리터럴을 이어붙인 SQL(흔히 injection 시도에서도 나타남)은
-- child cursor(version_count)가 비정상적으로 늘어나는 경향이 있어 보조 신호로 씁니다.
-- 단, VPD/세션별 NLS 설정/cursor_sharing 차이 등 보안과 무관한 이유로도 높아질 수 있는
-- "일반 파싱 효율" 지표라서, 이것만으로 공격 단정은 금물 — 급증 추세를 보는 용도입니다.

SELECT sql_id, parsing_schema_name AS schema_name,
       SUBSTR(sql_text, 1, 200) AS sql_preview,
       version_count, loaded_versions, executions
  FROM v$sqlarea
 WHERE parsing_schema_name NOT IN ('SYS', 'SYSTEM')
 ORDER BY version_count DESC;

-- Thresholds 화면에 등록할 값:
--   컬럼명 : VERSION_COUNT
--   조건유형 : NUMERIC
--   연산자 : >
--   값 : 50 (환경별 평상시 수치 보고 조정)
--   레벨 : WARN
--   메시지 : 동일 SQL의 child cursor(버전)가 과도하게 많음 — bind variable 미사용/리터럴 SQL 의심 (hard parse 증가)
