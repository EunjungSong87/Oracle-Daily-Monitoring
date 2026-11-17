-- 일일점검 보안성 이상 징후 탐지 태스크 3종 (로그인 실패 시도 / SQL Injection 의심 패턴 / 과다 파싱).
--
-- 참고용 기록 파일입니다 — 이 파일 자체를 실행하는 것이 아니라, 아래 내용을 화면에서
-- 직접 등록합니다:
--   1) Scripts 화면(Add) : NAME + SQL 입력
--   2) Thresholds 화면(Add) : 해당 task 선택 후 컬럼/조건/레벨/메시지 입력
-- 기존 monitoring_tasks/monitoring_thresholds 구조를 그대로 쓰므로 스키마 변경, 추가 권한 모두 없음
-- (1번 태스크는 기존 'alertLog' 태스크와 같은 V$DIAG_ALERT_EXT를 사용).

-- ============================================================
-- 1) 로그인 실패 시도 탐지 (loginFailureCheck)
-- ============================================================
-- Scripts 화면에 등록할 SQL:

SELECT REGEXP_SUBSTR(MESSAGE_TEXT, 'ORA-[0-9]+') ORA_CODE,
       COUNT(*) FAIL_COUNT,
       MAX(ORIGINATING_TIMESTAMP + INTERVAL '9' HOUR) LAST_SEEN
  FROM V$DIAG_ALERT_EXT
 WHERE ORIGINATING_TIMESTAMP > SYSDATE - 1
   AND (MESSAGE_TEXT LIKE '%ORA-01017%' OR MESSAGE_TEXT LIKE '%ORA-28000%' OR MESSAGE_TEXT LIKE '%ORA-01031%')
 GROUP BY REGEXP_SUBSTR(MESSAGE_TEXT, 'ORA-[0-9]+');

-- Thresholds 화면에 등록할 값:
--   컬럼명 : FAIL_COUNT
--   조건유형 : NUMERIC
--   연산자 : >
--   값 : 20
--   레벨 : WARN (환경에 따라 ERROR로)
--   메시지 : 최근 1일 로그인 실패/권한거부 20건 초과 — 비정상 접속 시도 의심


-- ============================================================
-- 2) SQL Injection 의심 패턴 탐지 (sqlInjectionPatternCheck)
-- ============================================================
-- V$SQL은 shared pool에 남아있는 최근 SQL만 보여서 완전한 탐지는 아니고,
-- 눈에 띄는 패턴만 걸러내는 보조 체크입니다.

SELECT sql_id, parsing_schema_name AS schema_name,
       SUBSTR(sql_text, 1, 200) AS sql_preview,
       executions, last_active_time,
       '의심' AS SECURITY_FLAG
  FROM v$sql
 WHERE last_active_time > SYSDATE - 1
   AND parsing_schema_name NOT IN ('SYS', 'SYSTEM')
   AND (
        REGEXP_LIKE(sql_text, 'UNION[[:space:]]+(ALL[[:space:]]+)?SELECT', 'i')
     OR REGEXP_LIKE(sql_text, '(''|[[:space:]])OR[[:space:]]+''?1''?[[:space:]]*=[[:space:]]*''?1', 'i')
     OR REGEXP_LIKE(sql_text, ';[[:space:]]*(DROP|DELETE|UPDATE|INSERT)[[:space:]]', 'i')
     OR REGEXP_LIKE(sql_text, 'XP_CMDSHELL', 'i')
   );

-- Thresholds 화면에 등록할 값:
--   컬럼명 : SECURITY_FLAG
--   조건유형 : STRING (PATTERN/LIKE)
--   연산자 : LIKE
--   값 : 의심
--   레벨 : ERROR
--   메시지 : SQL Injection 의심 패턴 탐지됨 — sql_preview 확인 필요


-- ============================================================
-- 3) 과다 파싱(SQL 공유 안 됨) 탐지 (excessiveParseCheck)
-- ============================================================
-- bind variable 없이 리터럴을 이어붙인 SQL(흔히 injection 시도에서도 나타남)은
-- child cursor(version_count)가 비정상적으로 늘어남 — "too many parse"를 이 지표로 탐지.

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
