-- ==========================================================================================================================================   
-- 0006.SQL_Gather_from_AWR.sql 
-- [SCRIPT 0006 : iRPM SPT의 SQL수집을 AWR로 부터 가져오기 위한 PL/SQL (방법 3)]
--                다음의 경우는 SPT를 위한 사용자 권한 설정 및 Repository Table 생성 및 IRPM_SPT Package가 설치된 환경에서 실행하는 것임
--                이 경우가 아닐 경우는 Package구성 없이 별도 제공된 최소한의 수집 체계에 따라 수집해야 함 
-- 
--    > 아래의 5개의 조정 값을 확인 후 환경에 맞게 변경하여 실행
-- ==========================================================================================================================================   
DECLARE
    in_STS_OWNER        VARCHAR2(256);  
    in_STS_TABLE_NAME   VARCHAR2(256);
    in_MIN_DATE         DATE;
    in_MAX_DATE         DATE;
    in_FILTER_PREDICATE VARCHAR2(4000);
BEGIN 
    -- ============================================================
    -- 아래 변수를 수정하여 실행
    --   in_STS_OWNER        : IRPM SPT의 수집동 Table의 Owner
    --   in_STS_TABLE_NAME   : IRPM SPT의 수집용 Table
    --   in_MIN_DATE         : AWR dba_hist_snapshot 의 구간의 MIN DATE
    --   in_MAX_DATE         : AWR dba_hist_snapshot 의 구간의 MAX DATE
    --   in_FILTER_PREDICATE : AWR Repository에서 FILTER할 추가 조건
    -- ------------------------------------------------------------
    in_STS_OWNER       := sys_context('USERENV', 'SESSION_USER');
    in_STS_TABLE_NAME  := 'ILM_IRPMSPT_SQLSET_STAGE'; 
    in_MIN_DATE        := SYSDATE - 14;
    in_MAX_DATE        := SYSDATE;
    in_FILTER_PREDICATE:= ' and SQL_TEXT not like ''%DS_SVC%'' and SQL_TEXT not like ''%DBMS_REDEFINITION%'' ' ||
                          ' and SQL_TEXT not like ''%SQL Analyze%'' and SQL_TEXT not like ''%dbms_stats%'' ' || 
                          ' and SQL_TEXT not like ''%OPT_DYN_SAMP%''  ';                        
    -- ============================================================
    
    -- 실행전에 REPOSITORY TRUNCATE를 위해서는 아래 실행  --------------------------------------------------------------------
    --EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || in_STS_OWNER  || '.' || in_STS_TABLE_NAME; 
    -- WORK TABLE TRUNCATE -----------------------------------------------------------------------------------------    

    IRPM_SPT.IRPM_SPT_SQLGATHER_AWR(in_STS_OWNER,in_STS_TABLE_NAME,in_MIN_DATE , in_MAX_DATE, in_FILTER_PREDICATE );
END;
/


-- ==========================================================================================================================================   
-- Scheduler Job 확인
--   > 실행한 Node수 만큼 Scheduler Job이 나와야 함
-- ========================================================================================================================================== 
select OWNER,JOB_NAME,INSTANCE_ID,STATE,RUN_COUNT,JOB_ACTION,REPEAT_INTERVAL,START_DATE,NEXT_RUN_DATE
FROM DBA_SCHEDULER_JOBS 
WHERE JOB_NAME LIKE 'IRPM_SPT_SQLG%';


-- ==========================================================================================================================================   
-- Scheduler Job 강제종료 (DROP SCHEDULER JOB)
--   > 아래의 SQL을 실행해서 나온 RUN_CMD의 Script를 실행하여 JOB강제 종료
-- ========================================================================================================================================== 
SELECT 'EXEC DBMS_SCHEDULER.STOP_JOB(''' || JOB_NAME ||''');' RUN_CMD 
FROM DBA_SCHEDULER_JOBS 
WHERE JOB_NAME LIKE 'IRPM_SPT_SQLG%';

-- ==========================================================================================================================================   
-- SQL수집된 정보 확인
--   > Node마다 수집된 SQL수(TOTAL_SQL_CNT) 및 최종 수집일자(GATHER_DATE) 확인
-- ========================================================================================================================================== 
SELECT NODE, SQLSET_NAME, MAX(TOTAL_SQL_CNT) AS TOTAL_SQL_CNT, MAX(GATHER_DATE) AS GATHER_DATE
FROM ILM_IRPMSPT_SQLSET_LOG 
GROUP BY NODE, SQLSET_NAME
ORDER BY NODE;


-- ==========================================================================================================================================   
-- SQL수집 LOG(전체보기)
-- ========================================================================================================================================== 
SELECT * 
FROM ILM_IRPMSPT_SQLSET_LOG 
ORDER BY NODE, GATHER_DATE;


-- ==========================================================================================================================================   
-- 수집된 IRPM SPT Repository Table의 SQL 확인 (전체)
-- ========================================================================================================================================== 
SELECT * 
FROM ILM_IRPMSPT_SQLSET_STAGE;


-- ==========================================================================================================================================   
-- 수집된 IRPM SPT Repository Table의 SQL만 보기
-- ========================================================================================================================================== 
SELECT * 
FROM ILM_IRPMSPT_SQLSET_STAGE
WHERE PARSING_SCHEMA_NAME IS NOT NULL;


-- ==========================================================================================================================================   
-- SQL수집 수 확인
--  > ID:1 - CACHE(V$SQL)에서 수집 , 2 - AWR에서 수집 
--  > DESCRIPTION : 'iRPM SPT SQL Gather' - CACHE(V$SQL)에서 수집, 'iRPM SPT SQL Gather(AWR)' - AWR에서 수집
-- ========================================================================================================================================== 
SELECT ID,NAME,OWNER,DESCRIPTION, COUNT(SQL_ID) SQL_CNT, COUNT(DISTINCT SQL_ID) DIST_SQL_CNT
FROM ILM_IRPMSPT_SQLSET_STAGE
WHERE PARSING_SCHEMA_NAME IS NOT NULL
GROUP BY ID,NAME,OWNER,DESCRIPTION
ORDER BY ID,NAME,OWNER;
