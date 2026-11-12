-- ==========================================================================================================================================   
-- 0005.SQL_Gather_from_CACHE(ANY_NODES).sql 
-- [SCRIPT 0005 : iRPM SPT의 SQL수집을 위한 Scheduler Job실행 - CACHE로 부터 SQL수집을 위한 PL/SQL (방법 2)]
--                다음의 경우는 SPT를 위한 사용자 권한 설정 및 Repository Table 생성 및 IRPM_SPT Package가 설치된 환경에서 실행하는 것임
--                이 경우가 아닐 경우는 Package구성 없이 별도 제공된 최소한의 수집 체계에 따라 수집해야 함 
-- 
--    > 지정된 RAC Node에서만 SQL 수집을 위해 실행. --> 실행하는 Node는 어느 곳이든 상관 없음
--    > 여러 Node를 돌릴려면 in_RUN_NODE_NUMBER 를 바꿔가며 실행해야 함.
--    > 기존에 실행중인 JOB이 있다면 다시 실행안됨. (SCHEDULER JOB NAME이 같으므로)
--    > job_queue_processess는 기존 Job(Scheduler, dbms_job)과 실행 Process수를 고려하여 충분히 설정
--      alter system set job_queue_processes=1000;
--    > 아래의 8개의 조정 값을 확인 후 환경에 맞게 변경하여 실행
--    > 'IRPM_SPT_SQLG_' || in_SYSTEM_NAME || NODE번호 의 SCHEDULER Job이 지정된 Node의 SQL을 수집함
-- ========================================================================================================================================== 
DECLARE
    in_GATHER_DAYS      NUMBER(10)   ;
    in_SYSTEM_NAME      VARCHAR2(256); 
    in_STS_OWNER        VARCHAR2(256);  
    in_STS_TABLE_NAME   VARCHAR2(256);
    in_REPEAT_INTERVAL  VARCHAR2(4000);
    in_FILTER_PREDICATE VARCHAR2(4000);
    in_COMMIT_COUNT     NUMBER(10)    ;
    
    in_RUN_NODE_NUMBER  NUMBER;
    v_RUN_JOB_STRING    VARCHAR2(4000);
    v_WORK_PREDICATE    VARCHAR2(4000);  
    v_code              NUMBER;
    v_errm              VARCHAR2(2048);
BEGIN 
    -- ============================================================
    -- 아래 변수를 수정하여 실행
    --   in_RUN_NODE_NUMBER : RAC환경의 실행할 Node수 
    --   in_GATHER_DAYS     : 수집 일수
    --   in_SYSTEM_NAME     : 주로 DB명으로 수집된 정보의 출처 DB를 확인 목적
    --   in_STS_OWNER       : IRPM SPT의 수집동 Table의 Owner
    --   in_STS_TABLE_NAME  : IRPM SPT의 수집용 Table
    -- ------------------------------------------------------------
    in_RUN_NODE_NUMBER := 1;
    in_GATHER_DAYS     := 3;
    in_SYSTEM_NAME     := sys_context('USERENV', 'DB_NAME');
    in_STS_OWNER       := sys_context('USERENV', 'SESSION_USER');
    in_STS_TABLE_NAME  := 'ILM_IRPMSPT_SQLSET_STAGE';
    in_REPEAT_INTERVAL := 'FREQ=hourly; BYHOUR=2,4,6,8,10,12,14,16,18,20,22,0; BYMINUTE=5;';
    in_COMMIT_COUNT    := 5000;
    in_FILTER_PREDICATE := ' AND S.EXECUTIONS > 1 AND S.LAST_ACTIVE_TIME >= to_date(to_char(sysdate - 2.2/24,''yyyy/mm/dd hh24:mi:ss''),''yyyy/mm/dd hh24:mi:ss'') ' ;   
    -- ============================================================

    -- 실행전에 REPOSITORY TRUNCATE를 위해서는 아래 실행  --------------------------------------------------------------------
    -- EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || in_STS_OWNER  || '.' || in_STS_TABLE_NAME; 
    -- WORK TABLE TRUNCATE ----------------------------------------------------------------------------------------- 

    v_WORK_PREDICATE := ' ' || REPLACE(in_FILTER_PREDICATE,'''','''''') || ' ';
    v_RUN_JOB_STRING := 'BEGIN IRPM_SPT.IRPM_SPT_SQLGATHER(''' || in_STS_OWNER || ''',''' || in_STS_TABLE_NAME || 
                        ''',' || TRIM(TO_CHAR(in_COMMIT_COUNT)) || ',''' || v_WORK_PREDICATE || '''); END;' ;
    BEGIN
        dbms_scheduler.create_job(
          job_name        => 'IRPM_SPT_SQLG_' || in_SYSTEM_NAME || TRIM(TO_CHAR(in_RUN_NODE_NUMBER))
         ,job_type        => 'PLSQL_BLOCK'
         ,job_action      => v_RUN_JOB_STRING  
         ,start_date      => sysdate 
         ,end_date        => sysdate + in_GATHER_DAYS
         ,repeat_interval => in_REPEAT_INTERVAL
         ,enabled         => TRUE
         ,comments        => 'iRPM SPT SQL GATHER for '  || in_SYSTEM_NAME || TRIM(TO_CHAR(in_RUN_NODE_NUMBER)) );
       dbms_scheduler.set_attribute(name=>'IRPM_SPT_SQLG_' || in_SYSTEM_NAME || TRIM(TO_CHAR(in_RUN_NODE_NUMBER)),attribute=>'instance_id', value=>in_RUN_NODE_NUMBER);  
    EXCEPTION WHEN others THEN 
           v_code := SQLCODE;
           v_errm := SQLERRM;
           DBMS_OUTPUT.PUT_LINE ('iRPM : ' || 'IRPM_SPT_SQLG_' || in_SYSTEM_NAME || TRIM(TO_CHAR(in_RUN_NODE_NUMBER)) || ' Gather Error ('  || v_code || ': ' || v_errm);          
    END;
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