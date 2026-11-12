-- ======================================================================================================================================
-- 0011.SPT_COPY_and_EXECUTE_for_AWR.sql 
-- [SCRIPT 0011 : iRPM SPT의 수집된 SQL들의 Play Job실행 ]
--              기존에 분석되었던 ILM_IRPMSPT_RUN의 WROK Table에 있는 SQL_ID를 실행정보를 제외한 RUN_NAME에 해당 하는 SQL들을 COPY하고 KEY(RUN_NAME)을 
--              재생성하여 여러차례 반속하여 변화된 환경에 대한 분석을 신속하게 하기 위한 처리 방법. 
--              ILM_IRPMSPT_SQLSET_STAGE Table에서 FILTER대상 SQL을 다시 추출하는 Operation을 줄여서 신속히 처리할 수 있다.
-- 
-- UGENS SPT 수행하기 
--    in_RUN_SOURCE==> 'STS' : from iRPM SQL수집 대상 또는 STS(SQL Tuning Set) Source사용. ILM_IRPMSPT_SQLSET_STAGE에 수집된 대상을 이용하여 SPT실행시 사용
--    in_RUN_SOURCE==> 'AWR' : from AWR Source사용 (AWR에서 분석대상 직접 취합하여 실행)
--
--    본 Script는 기존에 이미 실행했던 정보를 실행 OUTPUT을 제외한 KEY들만을 복사하여 변경된 환경으로 재실행을 간편하게 하는 기능
--    주의) 반드시 in_SOURCE_RUN_NAME, in_JOB_CODE를 지정하여 실행  
--    참고) RUN_NAME = JOB_CODE + YYYYMMDDHH24MISS로 자동 생성되는 KEY로 실행의 고유 이름
--    > job_queue_processess는 기존 Job(Scheduler, dbms_job)과 실행 Process수를 고려하여 충분히 설정
--      alter system set job_queue_processes=1000;
-- ======================================================================================================================================

-- --------------------------------------------------------------------------------------------------
-- 기존 실행정보 확인하여 COPY 대상 RUN_NAME 선택 
-- --------------------------------------------------------------------------------------------------

SELECT RUN_NAME,RUN_SOURCE,DECODE(LOAD_TEST_YN,'Y','Load Tester','SPT') "Run Type", DESCRIPTION "Description",
       DECODE(RUN_END_DATE,NULL,DECODE(PROC_REST,0,'N/A','Running...'),'Finished') "Run Status",RUN_START_DATE "Job Start Date",RUN_END_DATE "Job End Date",
       TOT_CNT "Target SQL Cnt",PROC_FINISH "Finished SQL Cnt",PROC_REST "Rest SQL Cnt",PROC_PCT "Progress %",
       PROC_P "Running SQL Cnt",PROC_N "Not Run Yet ",PROC_T "Timeout SQL Cnt",PROC_E "Error SQL Cnt",PROC_S "Skip SQL Cnt",PROC_Y "Run OK Cnt",
       PROC_FINISH "Total Runned SQL Cnt", ROUND(((NVL(RUN_END_DATE,SYSDATE)- RUN_START_DATE)*(24*60*60))) "Load Duration(Sec)",
       ROUND(DECODE(((NVL(RUN_END_DATE,SYSDATE)- RUN_START_DATE)*(24*60*60)),0,0,NULL,0,PROC_FINISH/((NVL(RUN_END_DATE,SYSDATE)- RUN_START_DATE)*(24*60*60))),2) TPS, 
       -- Configuration Information
       RUN_PROCESS,RUN_SQL_TIMEOUT,RUN_REMAP_STRING,
       RUN_REPLACE_SYSDATE,RUN_NLS_DATE_FORMAT,RUN_PRE_SQL,RUN_POST_SQL,PLAN_COMPARE_YN,PLAN_COMPARE_CHK_RUN_YN,
       USE_SQL_REPLACE,USE_BIND_REPLACE,
       LOAD_REG_DATE,LOAD_TEST_YN,LOAD_PROC_STATUS,LOAD_PROC_THINKTIME,LOAD_PROC_STARTTIME,LOAD_PROC_ENDTIME ,LOAD_PROC_COMMIT_YN,  LOAD_PROC_TYPE,
       USE_QUERY_RESULT_CHK , USE_QUERY_RESULT_LOGGING, USE_QUERY_RESULT_ROWLIMIT, USE_SQL_COMMENT, PREFETCH_COUNT     
FROM ILM_IRPMSPT_RUNINFO
WHERE 1=1
-- AND RUN_NAME like 'ORDERS%'
-- ORDER BY COALESCE(RUN_START_DATE,LOAD_REG_DATE) DESC;
ORDER BY SUBSTR(RUN_NAME,-14) DESC;
 


DECLARE
    out_RUN_NAME            VARCHAR2(200);
    v_NodeCount             NUMBER;
                            
    in_STS_OWNER            VARCHAR2(256);  
    in_STS_TABLE_NAME       VARCHAR2(256);
    in_SPT_WORKTBL_OWNER    VARCHAR2(256);  
    in_SPT_WORKTBL_NAME     VARCHAR2(256);
    in_SPT_LOGTBL_OWNER     VARCHAR2(256);  
    in_SPT_LOGTBL_NAME      VARCHAR2(256);
    in_RUN_SOURCE           VARCHAR2(20);
    in_PARALLEL_PROC        NUMBER;    
    in_AWR_SQLTARGET_DAYS   NUMBER;  
    in_AWR_STARTDT          VARCHAR2(100);
    in_AWR_ENDDT            VARCHAR2(100);
    in_DESCRIPTION          VARCHAR2(2000);
    in_PREDICATE            VARCHAR2(4000);
    in_JOB_CODE             VARCHAR2(15);
                            
    in_TABLE_OWNER          VARCHAR2(256);  
    in_TABLE_NAME           VARCHAR2(256);
    in_RUN_NODE_LIST        VARCHAR2(1000);
                            
    in_RUN_SQL_TIMEOUT      NUMBER;
    in_RUN_REMAP_STRING     CLOB;
    in_RUN_REPLACE_SYSDATE  VARCHAR2(14);
    in_RUN_NLS_DATE_FORMAT  VARCHAR2(100); 
    in_RUN_PRE_SQL          CLOB;
    in_RUN_POST_SQL         CLOB;   
    in_PRE_PLAN_COMPARE_YN  CHAR(1); 
    in_PLAN_COMP_CHK_RUN_YN CHAR(1);    
    in_USE_SQL_REPLACE_YN   CHAR(1);                              
    in_USE_BIND_REPLACE_YN  CHAR(1);
    in_LOAD_TEST_YN         CHAR(1);
    in_LOAD_PROC_TYPE       CHAR(1);
    in_USE_QUERY_RESULT_CHK CHAR(1);   
    in_USE_QUERY_RESULT_LOG CHAR(1);   
    in_USE_QUERY_RESULT_ROWLIMIT NUMBER;
    in_LOAD_PROC_THINKTIME  NUMBER;
    in_PREFETCH_COUNT       NUMBER;
    in_USE_SQL_COMMENT      CHAR(1);
    
    v_code                  NUMBER          := NULL;
    v_errm                  VARCHAR2(2048)  := ''; 
    v_II                    NUMBER; 
    in_LICENSE_KEY          VARCHAR2(128);   
    in_SOURCE_RUN_NAME      VARCHAR2(256);
BEGIN

    -- #####################################################################################################################################################
    -- 아래 변수를 수정하여 실행
    --
    --   in_SPT_LOGTBL_OWNER , in_SPT_LOGTBL_NAME  : SPT실행을 위한 LOG Table의 OWNER, TABLE_NAME (FIXED Name : ILM_IRPMSPT_LOG_WORK)
    --   in_SPT_WORKTBL_OWNER, in_SPT_WORKTBL_NAME : SPT실행을 위한 성능정보 수집 Table의 OWNER, TABLE_NAME, 성능정보 수집 대상 TABLE
    --   in_STS_OWNER,in_SYSTEM_NAME               : iRPM Staging Table의 OWNER, TABLE_NAME
    --   in_RUN_SOURCE                             : IRPMSPT의 수집 Source ('STS','AWR') 2개의 RESERVERD CODE
    --   in_PARALLEL_PROC                          : IRPM SPT의 실행 병렬도
    --   in_AWR_SQLTARGET_DAYS                     : 현재로 부터 AWR Repository의 몇일전 Data에 대해 분석할 것인지를 지정 in_RUN_SOURCE가 AWR일경우만 지정 
    --   in_AWR_STARTDT                            : AWR일 경우 AWR START DATE - YYYY-MM-DD Format
    --   in_AWR_ENDDT                              : AWR일 경우 AWR END DATE - YYYY-MM-DD Format
    --   in_JOB_CODE                               : JOB Unique Name (MAX 15 BYTE), 주로 TABLE_NAME등 구별 문자 
    --                                               JOB_NAME 구성 > IRPMSPT_[in_JOB_CODE]_001 = 30-12 = 18 BYTE 여유
    --                                               RUN_NAME 구성 > [in_JOB_CODE]_YYYYMMDDHH24MISS = 30-15 = 15 여유
    --   in_TABLE_OWNER , in_TABLE_NAME            : STS, AWR 에서 특정 TABLE에 속한 SQL문장만 실행을 위한 in_PREDICATE 조건 구성 Input
    --   in_RUN_NODE_LIST                          : JOB을 특정 Node들에서 실행할 경우 RAC Node번호, 지정하지 않을 경우 실행 Node에서 실행 예) '1,2' '1,3,4'
    --   in_RUN_SQL_TIMEOUT                        : SQL실행 Timeout Sec(0 - UNLIMIT, >0 실행 Timeout
    --   in_RUN_REMAP_STRING                       : TABLE등을 임시 TABLE이름으로 만든 후 SQL을 수정(REMAP)하여 돌릴 경우 REMAP STring
    --                                               EMP:EMP_$T,EMP_PK:EMP_PK_$T,DEPT:DEPT_$T,.... 과 같이 지정   
    --   in_RUN_REPLACE_SYSDATE                    : SYSDATE, SYSTIMESTAMP를 지정한 날짜로 변경하여 실행 (FORMAT : YYYYMMDDHH24MISS)
    --   in_RUN_NLS_DATE_FORMAT                    : SQL들이 날짜 Type에 대해 String으로 지정할 경우 사용될 Date Format, NULL --> 'YYYY-MM-DD HH24:MI:SS' 
    --   in_RUN_PRE_SQL                            : SQL실행전 환경 설정을 위한 Pre SQL, ';'로 구분 (주로 Init.ora Parameter), Public Synonym 설정 등
    --
    --                                               ALTER SYSTEM FIXED_DATE='2019-05-01 00:00:00; '
    --
    --                                               'ALTER SESSION SET optimizer_use_pending_statistics=true; '  ||
    --                                               'ALTER SESSION SET optimizer_use_invisible_indexes =true; '  || 
    --                                               'ALTER SESSION SET optimizer_use_sql_plan_baselines=false; ' ||
    --                                               'ALTER SESSION SET optimizer_dynamic_sampling=0; ' ;         ||
    --                                               'ALTER SESSION SET optimizer_dynamic_sampling=0; ' ;
    --
    --                                               -- 설정 관련 Parameter
    --                                               optimizer_features_enable ,optimizer_mode , optimizer_index_cost_adj, optimizer_index_caching, 
    --                                               optimizer_dynamic_sampling,optimizer_use_pending_statistics,optimizer_use_sql_plan_baselines,
    --                                               optimizer_use_invisible_indexes,optimizer_adaptive_plans,optimizer_adaptive_statistics,_optimizer_use_feedback,
    --                                               _add_col_optim_enabled,_index_join_enabled,_optim_peek_user_binds,_optimizer_adaptive_cursor_sharing,
    --                                               _optimizer_aggr_groupby_elim,_optimizer_band_join_aware,_optimizer_extended_cursor_sharing,
    --                                               _optimizer_extended_cursor_sharing_rel,_optimizer_gather_stats_on_load,db_file_multiblock_read_count,...
    --
    --   in_RUN_POST_SQL                           : 모든 SQL들을 처리 후 종료 전에 실행할 Post SQL , ';'로 구분 
    --   in_PRE_PLAN_COMPARE_YN                    : Repository의 수집 SQL과 PLAN (EXPLAIN PLAN)비교 후 같은 PLAN여부 확인 Y/N, Y일 경우 PLAN비교
    --   in_PLAN_COMP_CHK_RUN_YN                   : Repository의 수집 SQL과 PLAN (EXPLAIN PLAN)비교 후 다를 경우 SPT로 SQL실행 여부 Y/N, N일 경우 PLAN만 비교
    --   in_PREDICATE                              : Repository (STS, AWR)로 부터 실행 대상 SQL 추출을 위한 Predicate조건
    --
    --   in_USE_SQL_REPLACE_YN                     : REPLACE SQL_TEXT to 튜닝 SQL_TEXT on ILM_IRPMSPT_SQL_REPLACE Table        
    --   in_USE_BIND_REPLACE_YN                    : BIND Value Replace Y/N
    --   in_LOAD_TEST_YN                           : SPT Load Test Y or N 
    --   in_LOAD_PROC_TYPE                         : C or O : C(sql_id에 한시점에 여러 Process들이 동시 실행가능, Timeout가능 사용불가),O(sql_id에 한 시점에 한개의 Process만 실행가능, Timeout기능 가능)
    --   in_LOAD_PROC_THINKTIME                    : 부하발생시 Thinktime (Sleeptime between SQLs) 1/100초 단위 (0.01 ~ ) 단위 초
    --   in_USE_QUERY_RESULT_CHK                   : Query Result 비교목적,SQL Query Result Check Y/N (Wrong Result, Result Order)      
    --   in_USE_QUERY_RESULT_LOG                   : Query Result 비교목적,RUN SQL Logging in ILM_IRPMSPT_DIGITALSLOG
    --   in_USE_QUERY_RESULT_ROWLIMIT              : SQL Query Result Return Row Check Limit (0-All Rows, n-First n Rows)
    --   in_PREFETCH_COUNT                         : Select Query Prefetch Count, PREFETCH_COUNT = -1 (1 ROW FETCH) , FETCH_COUNT = 0 (계산된 FETCH) , FETCH_COUNT > 0  : (FIXED FETCH) 
    --   in_USE_SQL_COMMENT                        : SQL COMMENT Usage in SPT SQL, Attach Comment in Oraginal SQL        
    -- =======================================================================================================================================================
    
    in_LICENSE_KEY           := 'A6P0mnWwuwpFl/j2TtWGrA==';              -- iRPM_SPT License Key
    in_SPT_LOGTBL_OWNER      := sys_context('USERENV', 'SESSION_USER');  -- ILM_IRPMSPT_LOG_WORK Table Owner
    in_SPT_LOGTBL_NAME       := 'ILM_IRPMSPT_LOG_WORK';                  -- ILM_IRPMSPT_LOG_WORK 고정, 변경 불가 
    in_SPT_WORKTBL_OWNER     := sys_context('USERENV', 'SESSION_USER');  -- WORK Table의 OWNER
    in_SPT_WORKTBL_NAME      := 'ILM_IRPMSPT_RUN';                       -- WORK Table Name (사용자 지정 Table, 조정 가능)
    in_STS_OWNER             := sys_context('USERENV', 'SESSION_USER');  -- STS일경우 STS Staging Table의 OWNER
    in_STS_TABLE_NAME        := 'ILM_IRPMSPT_SQLSET_STAGE';              -- STS일경우 STS Staging Table (사용자 지정 Table, 조정 가능)  
    in_AWR_SQLTARGET_DAYS    := 14;                                      -- AWR일 경우 현재로 부터 지정된 일자 전까지의 SQL을 대상으로 수집 , STS는 무시
    in_AWR_STARTDT           := TRIM(TO_CHAR(SYSDATE - 14,'YYYY-MM-DD'));-- AWR일 경우 AWR START DATE - YYYY-MM-DD Format
    in_AWR_ENDDT             := TRIM(TO_CHAR(SYSDATE     ,'YYYY-MM-DD'));-- AWR일 경우 AWR END DATE - YYYY-MM-DD Format
    
    in_RUN_SOURCE            := 'SPT_AWR';                               -- 'STS' or 'AWR'  
    in_DESCRIPTION           := 'SPT AWR TEST';                          -- JOB Description
    in_PARALLEL_PROC         := 5;                                       -- Parallel Process  
    in_RUN_NODE_LIST         := NULL;                                    -- RAC Node에서 특별히 지정된 Node LIst에서 실행하도록 설정, RAC Node번호 (NULL-현재 접속 Node에서만 실행, '1,2,3' - 1 -> 2 -> 3번 Node에서 Round robin방식으로 실행, Main Control은 첫번쨰 지정 Node)
    in_RUN_SQL_TIMEOUT       := 0;                                       -- SQL 실행 Timeout
    in_RUN_REMAP_STRING      := NULL;                                    -- REMAP STring : 'EMP:EMP_$T,DEPT:DEPT_$T'
    in_RUN_REPLACE_SYSDATE   := NULL;                                    -- SYSDATE, SYSTIMESTAMP를 지정한 날짜로 변경하여 실행 (FORMAT : YYYYMMDDHH24MISS)
    in_RUN_NLS_DATE_FORMAT   := 'YYYY-MM-DD HH24:MI:SS';                 -- SQL들이 날짜 Type에 대해 String으로 지정할 경우 사용될 Date Format, NULL --> 'YYYY-MM-DD HH24:MI:SS'
    in_RUN_PRE_SQL           := NULL;                                    -- 위의 설명과 같이 SQL실행전 환경 설정을 위한 Pre SQL
    in_RUN_POST_SQL          := NULL;                                    -- Post SQL, ;로 구분한 여러 SQL문장 
    in_PRE_PLAN_COMPARE_YN   := 'N';                                     -- Repository의 수집 SQL과 PLAN (EXPLAIN PLAN)비교 후 같은 PLAN여부 확인 Y/N, Y일 경우 PLAN비교 
    in_PLAN_COMP_CHK_RUN_YN  := 'Y';                                     -- Repository의 수집 SQL과 PLAN (EXPLAIN PLAN)비교 후 다를 경우 SPT로 SQL실행 여부 Y/N, N일 경우 PLAN만 비교  
                             
    in_USE_SQL_REPLACE_YN    := 'Y';                                     -- EPLACE SQL_TEXT to 튜닝 SQL_TEXT on ILM_IRPMSPT_SQL_REPLACE Table  
    in_USE_BIND_REPLACE_YN   := 'N';                                     -- BIND Value Replace Y/N
    
    in_LOAD_TEST_YN          := 'N';                                     -- SPT Load Test Y or N
    in_LOAD_PROC_TYPE        := 'C';                                     -- C or O : C(sql_id에 한시점에 여러 Process들이 동시 실행가능, Timeout가능 사용불가),O(sql_id에 한 시점에 한개의 Process만 실행가능, Timeout기능 가능)
    in_LOAD_PROC_THINKTIME   := NULL;                                    -- 부하발생시 Thinktime (Sleeptime between SQLs) 1/100초 단위 (0.01 ~ ) 단위 초 
    
    in_USE_QUERY_RESULT_CHK  := 'N';                                     -- Query Result 비교목적 DBMS_SQLHASH를 이용한 SQL결과 저장 
    in_USE_QUERY_RESULT_LOG  := 'N';                                     -- Query Result 비교목적 DBMS_SQLHASH를 이용한 RUN SQL Logging in ILM_IRPMSPT_DIGITALSLOG
    in_USE_QUERY_RESULT_ROWLIMIT := 0;                                   -- Query Result 비교목적 Result결과의 HASH처리 LIMIT (100000 ROW 이상일 경우 시간이 늘어남, 10만 ROW일 경우 1분정도 소요)
    
    in_PREFETCH_COUNT        := -1 ;                                     -- Select Query Prefetch Count, PREFETCH_COUNT = -1 (1 ROW FETCH) , FETCH_COUNT = 0 (계산된 FETCH) , FETCH_COUNT > 0  : (FIXED FETCH)
    in_USE_SQL_COMMENT       := 'Y';                                     -- SQL에 Comment를 붙여 실행 (고유한 실행 목적, COMMENT제거('N')일 경우 SQL Plan Baseline, SQL Profile적용 후 사용여부 Check목적  
    -- @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    -- 아래 입력 부분은 COPY할 RUN_NAME (KEY)이며, 신규 생셩될 KEY를 위한 JOB_CODE임
    -- in_SPT_WORKTBL_NAME ('ILM_IRPMSPT_RUN')로 부터 in_SOURCE_RUN_NAME을 COPY하여 in_JOB_CODE || 'YYYYMMDDHH24MISS'의 새로운 RUN Name을 생성하고 Return
    -- @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    in_SOURCE_RUN_NAME       := 'XXXXXXXXXXXXXXXXXXXXXX';                 -- 기존에 실행되었던 Source Run Name
    in_JOB_CODE              := 'AWR_ALL';                                -- JOB을 구별하기 위한 고유 STRING, MAX (15 Bytes) + 뒤에 날짜가 붙어서 RUN_NAME생성됨 
    -- @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
    
    -- #####################################################################################################################################################
    
    -- JOB_CODE는 초대 15 Byte
    in_JOB_CODE := SUBSTR(UPPER(TRIM(NVL(in_JOB_CODE,'JOB'))),1,15);   
    
    
    -- STEP 1: WORK TABLE및 LOG Table TRUNCATE (Option) -------------------------------------------------------------
    -- EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || in_SPT_LOGTBL_OWNER  || '.' || in_SPT_LOGTBL_NAME; 
    -- EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || in_SPT_WORKTBL_OWNER || '.' || in_SPT_WORKTBL_NAME; 
    -- WORK TABLE및 LOG Table TRUNCATE ------------------------------------------------------------------------------
    
    
    -- STEP 2: 기존 Running Job이 있다면 DROP Job (Option) --------------------------------------------------------------
    -- FOR v_II in 1 .. in_PARALLEL_PROC LOOP
    --  BEGIN
    --    dbms_scheduler.stop_job(job_name=> 'IRPMSPT_' || in_JOB_CODE || '_' || TRIM(TO_CHAR(v_II,'009')));
    --    EXCEPTION WHEN others THEN 
    --       v_code := SQLCODE;
    --       v_errm := SQLERRM;
    --       DBMS_OUTPUT.PUT_LINE ('iRPM : ' || 'DROP JOB : ' || 'IRPMSPT_' || in_JOB_CODE || '_' || TRIM(TO_CHAR(v_II,'009')) || ' Error ('  || v_code || ': ' || v_errm);          
    --  END;
    -- END LOOP;
    -- 기존 Running Job이 있다면 DROP Job -------------------------------------------------------------------------------
    
    IRPM_SPT.INIT(in_LICENSE_KEY);

    -- STEP 3: 아래 입력 부분은 COPY할 RUN_NAME (KEY)이며, 신규 생셩될 KEY를 위한 JOB_CODE를 받아서 신규 실행을 위한 복제 (COPY)를 하며, 생성된 RUN_NAME을 out_RUN_NAME로 Return함
    IRPM_SPT.SPT_COPY_FROM_RUN(in_SPT_WORKTBL_OWNER, in_SPT_WORKTBL_NAME, in_SOURCE_RUN_NAME ,in_RUN_SOURCE, in_JOB_CODE , out_RUN_NAME  ) ;
   
    -- STEP 4: RUN Configuration (ILM_IRPMSPT_RUNINFO Table에 등록)  --------------------------------------------------
    IRPM_SPT.RUN_CONFIG(out_RUN_NAME,in_RUN_SOURCE,in_DESCRIPTION,in_PARALLEL_PROC,in_RUN_SQL_TIMEOUT, in_RUN_REMAP_STRING, in_RUN_REPLACE_SYSDATE,
                        in_RUN_NLS_DATE_FORMAT,in_RUN_PRE_SQL,in_RUN_POST_SQL,in_PRE_PLAN_COMPARE_YN, in_PLAN_COMP_CHK_RUN_YN, 
                        in_USE_SQL_REPLACE_YN , in_USE_BIND_REPLACE_YN, in_LOAD_TEST_YN , in_LOAD_PROC_TYPE, in_LOAD_PROC_THINKTIME,
                        in_USE_QUERY_RESULT_CHK,in_USE_QUERY_RESULT_LOG,in_USE_QUERY_RESULT_ROWLIMIT, in_PREFETCH_COUNT, in_USE_SQL_COMMENT);
    
    -- STEP 5: IRPM SPT Play(SQL Run) 내부적으로 병렬도 만큼 Scheduler Job이 디동됨 'IRPMSPT_' || in_JOB_CODE || TRIM(TO_CHAR(v_II) --   
    --         in_LOAD_TEST_YN = 'Y' ==> 부하발생기 JOB , 'N' ==> SPT Job
    --         부하발생기는 iRPM_SPT.SPT_LOAD_START로 START해 줘야 부하 JOB STart 
    IF in_LOAD_TEST_YN = 'Y' THEN
        IRPM_SPT.SPT_LOAD_JOB(in_SPT_WORKTBL_OWNER,in_SPT_WORKTBL_NAME,in_JOB_CODE, in_STS_OWNER, in_STS_TABLE_NAME, out_RUN_NAME, in_RUN_SOURCE, in_PARALLEL_PROC, in_RUN_NODE_LIST);
        -- Remove Comment Line for Immediately Start Load Test
        -- iRPM_SPT.SPT_LOAD_START (out_RUN_NAME, in_RUN_SOURCE);
        -- Remove Comment Line for Reserved Time (다음의 경우는 1분뒤에 자동 START하며 10분간 부하 발생)
        -- iRPM_SPT.SPT_LOAD_START (out_RUN_NAME, in_RUN_SOURCE, SYSDATE + 1/(24*60) , SYSDATE + 11/(24*60) ,'N' );  
    ELSE
        IRPM_SPT.SPT_START_JOB(in_SPT_WORKTBL_OWNER,in_SPT_WORKTBL_NAME,in_JOB_CODE, in_STS_OWNER, in_STS_TABLE_NAME, out_RUN_NAME, in_RUN_SOURCE, in_PARALLEL_PROC, in_RUN_NODE_LIST);
    END IF;
    
    DBMS_OUTPUT.PUT_LINE(out_RUN_NAME);
END;
/





-- #############################################################################################################################################
--  
--  Monitoring & Job Control
--     1. Run STatistics Monitoring and Configuration Parameter Monitoring
--     2. 개발 SQL처리 정보 모니터링
--     3. Add Job, Stop Job, Kill SQL Script
--     4. Scheduler Job기동 여부 Monitoring
--     5. Sheduler Job 강제 종료 처리 Script
--
-- #############################################################################################################################################



-- ==========================================================================================================================================   
-- SPT Run STatistics Information , RUN Configuration Check
-- ========================================================================================================================================== 
SELECT RUN_NAME,RUN_SOURCE,DECODE(LOAD_TEST_YN,'Y','Load Tester','SPT') "Run Type", DESCRIPTION "Description",
       DECODE(RUN_END_DATE,NULL,DECODE(PROC_REST,0,'N/A','Running...'),'Finished') "Run Status",RUN_START_DATE "Job Start Date",RUN_END_DATE "Job End Date",
       -- Run STatistics Information
       TOT_CNT "Target SQL Cnt",PROC_FINISH "Finished SQL Cnt",PROC_REST "Rest SQL Cnt",PROC_PCT "Progress %",
       PROC_P "Running SQL Cnt",PROC_N "Not Run Yet ",PROC_T "Timeout SQL Cnt",PROC_E "Error SQL Cnt",PROC_S "Skip SQL Cnt",PROC_Y "Run OK Cnt",
       PROC_FINISH "Total Runned SQL Cnt", ROUND(((NVL(RUN_END_DATE,SYSDATE)- RUN_START_DATE)*(24*60*60))) "Load Duration(Sec)",
       ROUND(DECODE(((NVL(RUN_END_DATE,SYSDATE)- RUN_START_DATE)*(24*60*60)),0,0,NULL,0,PROC_FINISH/((NVL(RUN_END_DATE,SYSDATE)- RUN_START_DATE)*(24*60*60))),2) TPS, 
       -- Configuration Information
       RUN_PROCESS,RUN_SQL_TIMEOUT,RUN_REMAP_STRING,
       RUN_REPLACE_SYSDATE,RUN_NLS_DATE_FORMAT,RUN_PRE_SQL,RUN_POST_SQL,PLAN_COMPARE_YN,PLAN_COMPARE_CHK_RUN_YN,
       USE_SQL_REPLACE,USE_BIND_REPLACE,
       LOAD_REG_DATE,LOAD_TEST_YN,LOAD_PROC_STATUS,LOAD_PROC_THINKTIME,LOAD_PROC_STARTTIME,LOAD_PROC_ENDTIME ,LOAD_PROC_COMMIT_YN,  LOAD_PROC_TYPE,
       USE_QUERY_RESULT_CHK , USE_QUERY_RESULT_LOGGING, USE_QUERY_RESULT_ROWLIMIT, USE_SQL_COMMENT, PREFETCH_COUNT     
FROM ILM_IRPMSPT_RUNINFO
WHERE 1=1
-- AND RUN_NAME like 'ORDERS%'
-- ORDER BY COALESCE(RUN_START_DATE,LOAD_REG_DATE) DESC;
ORDER BY SUBSTR(RUN_NAME,-14) DESC;



-- =============================================================================================================================================
-- SPT 수행 모니터링
-- =============================================================================================================================================
WITH MY_INPUT AS (
    SELECT
    
    --=====================================================================
    -- 아래의 2개의 값을 입력후 실행하세요~
    -- RUN_NAME, RUN_SOURCE가 NULL일 경우 가장 최근에 실행한 JOB의 값을 읽음
    --=====================================================================
    NULL                        RUN_NAME,
    NULL                        RUN_SOURCE    
    --=====================================================================
    
    FROM DUAL 
)
,LAST_JOB AS (
    SELECT RUN_NAME, RUN_SOURCE
    FROM (SELECT RUN_NAME,RUN_SOURCE FROM ILM_IRPMSPT_RUNINFO 
          ORDER BY SUBSTR(RUN_NAME,-14) DESC)
    WHERE ROWNUM <= 1 
)
SELECT /*+ LEADING(A,B) USE_NL(A B) */ 
       A.* ,
       '#####' SEP,
       'AWR Snap: [' || B.MIN_SNAP_ID || ' ~ ' || B.MAX_SNAP_ID || ']' AWR_SNAP_RANGE,
       (select sql_text from dba_hist_sqltext where rowid = A.AWR_ROWID)  SQL_TEXT,  
       B.* 
       -- SQL PROFILE, SPM Usage Check from V$SQL
       ,'@@@@@' SEP2,
       Q.SQL_PROFILE,Q.SQL_PLAN_BASELINE
FROM ILM_IRPMSPT_RUN A, 
     (select  /*+ LEADING(SN SY) NO_MERGE(SN) USE_HASH(SN SY) FULL(sy) */ 
              sy.dbid, sy.sql_id,sy.plan_hash_value      
            , NVL(sum(ELAPSED_TIME_DELTA)           ,0) ELAPSED_TIME           
            , NVL(sum(CPU_TIME_DELTA)               ,0) CPU_TIME              
            , NVL(sum(EXECUTIONS_DELTA)             ,0) EXECUTIONS             
            , NVL(sum(FETCHES_DELTA)                ,0) FETCHES                 
            , NVL(sum(END_OF_FETCH_COUNT_DELTA)     ,0) END_OF_FETCH_COUNT    
            , NVL(sum(SORTS_DELTA)                  ,0) SORTS                
            , NVL(sum(PX_SERVERS_EXECS_DELTA)       ,0) PX_SERVERS_EXECS      
            , NVL(sum(LOADS_DELTA)                  ,0) LOADS               
            , NVL(sum(INVALIDATIONS_DELTA)          ,0) INVALIDATIONS         
            , NVL(sum(PARSE_CALLS_DELTA)            ,0) PARSE_CALLS         
            , NVL(sum(DISK_READS_DELTA)             ,0) DISK_READS             
            , NVL(sum(BUFFER_GETS_DELTA)            ,0) BUFFER_GETS            
            , NVL(sum(ROWS_PROCESSED_DELTA)         ,0) ROWS_PROCESSED        
            , NVL(sum(IOWAIT_DELTA)                 ,0) IOWAIT                
            , NVL(sum(CLWAIT_DELTA)                 ,0) CLWAIT               
            , NVL(sum(APWAIT_DELTA)                 ,0) APWAIT              
            , NVL(sum(CCWAIT_DELTA)                 ,0) CCWAIT                  
            , NVL(sum(DIRECT_WRITES_DELTA)          ,0) DIRECT_WRITES          
            , NVL(sum(PLSEXEC_TIME_DELTA)           ,0) PLSEXEC_TIME        
            , NVL(sum(JAVEXEC_TIME_DELTA)           ,0) JAVEXEC_TIME 
            , MAX(FORCE_MATCHING_SIGNATURE)             FORCE_MATCHING_SIGNATURE
            , MAX(MODULE)                               MODULE
            , MAX(PARSING_SCHEMA_NAME)                  PARSING_SCHEMA_NAME
            , MAX(BIND_DATA)                            BIND_DATA
            , MIN(MIN_SNAP_ID)                          MIN_SNAP_ID
            , MAX(MAX_SNAP_ID)                          MAX_SNAP_ID 
      from  (SELECT DBID,INSTANCE_NUMBER,SQL_ID ,MIN_SNAP_ID ,MAX_SNAP_ID       
            from   ILM_IRPMSPT_RUN y
            WHERE  RUN_NAME = NVL((SELECT RUN_NAME FROM MY_INPUT),(SELECT RUN_NAME FROM LAST_JOB))
              AND  RUN_SOURCE like NVL((SELECT RUN_SOURCE FROM MY_INPUT),(SELECT RUN_SOURCE FROM LAST_JOB)) || '%'
            ) V1,
            dba_hist_sqlstat  sy
     WHERE  1=1 
       and sy.snap_id         BETWEEN V1.MIN_SNAP_ID AND V1.MAX_SNAP_ID
       and sy.dbid            = V1.dbid
       and sy.instance_number = V1.instance_number
       and sy.sql_id          = V1.sql_id
     group by sy.dbid,sy.sql_id,sy.plan_hash_value) B
     ,V$SQL Q
WHERE A.RUN_NAME   = NVL((SELECT RUN_NAME FROM MY_INPUT),(SELECT RUN_NAME FROM LAST_JOB)) 
 AND  A.RUN_SOURCE LIKE NVL((SELECT RUN_SOURCE FROM MY_INPUT),(SELECT RUN_SOURCE FROM LAST_JOB)) || '%'
 AND  A.DBID                = B.DBID
 AND  A.SQL_ID              = B.SQL_ID
 AND  A.AWR_PLAN_HASH_VALUE = B.PLAN_HASH_VALUE 
 AND  A.SPT_SQL_ID = Q.SQL_ID(+)
  -- AND RUN_PROC_YN IN ('P','N')
  -- AND RUN_PROC_YN IN ('Y')
  -- AND RUN_PROC_YN IN ('T','S','E')
ORDER BY RUN_ORDER;




-- ----------------------------------------------------------------------------------
-- RUN_NAME, RUN_SOURCE에 추가 Process 기동하기
-- ----------------------------------------------------------------------------------
--EXEC IRPM_SPT.SPT_ADD_JOB(:RUN_NAME , :RUN_SOURCE, 5) ;

-- ----------------------------------------------------------------------------------
-- RUN_NAME, RUN_SOURCE의 JOB 강제 종료하기
-- ----------------------------------------------------------------------------------
--EXEC IRPM_SPT.SPT_DROP_JOB(:RUN_NAME , :RUN_SOURCE, sys_context('USERENV', 'SESSION_USER'), 'ILM_IRPMSPT_RUN') ; 

-- ----------------------------------------------------------------------------------
-- 'P' 상태의 Process를 강제적으로 죽이기 --> 'T'와 EXEC_ERROR는 Killed로 나타남
-- ----------------------------------------------------------------------------------
--EXEC IRPM_SPT.SPT_KILL_SQL(:RUN_NAME , :RUN_SOURCE, sys_context('USERENV', 'SESSION_USER'), 'ILM_IRPMSPT_RUN', :SQL_ID) ;

 
 
-- =============================================================================================================================================
-- 수행중인 JOB 내역 보기
-- =============================================================================================================================================
SELECT * 
FROM DBA_SCHEDULER_JOBS 
WHERE JOB_NAME LIKE 'IRPMSPT%' 
ORDER BY JOB_NAME;

-- ==========================================================================================================================================   
-- SPT RUN Scheduler Job 강제종료 (STOP SCHEDULER JOB)
--   > 아래의 SQL을 실행해서 나온 RUN_CMD의 Script를 실행하여 JOB강제 종료
-- ========================================================================================================================================== 
-- ----------------------------------------------------------------------------------
-- RUN_NAME, RUN_SOURCE의 실행중인 대상을 전체 정리하기, 이 방법으로 처리 권장 
-- ----------------------------------------------------------------------------------
--EXEC IRPM_SPT.SPT_DROP_JOB(:RUN_NAME , :RUN_SOURCE, sys_context('USERENV', 'SESSION_USER'), 'ILM_IRPMSPT_RUN') ; 

SELECT 'BEGIN BEGIN DBMS_SCHEDULER.STOP_JOB(''' || JOB_NAME ||'''); EXCEPTION WHEN OTHERS THEN NULL; END;' ||
       '      BEGIN DBMS_SCHEDULER.DROP_JOB(''' || JOB_NAME ||'''); EXCEPTION WHEN OTHERS THEN NULL; END; END;' || chr(10) || '/' RUN_CMD 
FROM DBA_SCHEDULER_JOBS 
WHERE JOB_NAME LIKE 'IRPMSPT%'    
ORDER BY JOB_NAME DESC;

  
  
  
-- =============================================================================================================================================
-- SPT 수행로그 보기
-- =============================================================================================================================================
SELECT * 
FROM ILM_IRPMSPT_LOG_WORK 
ORDER BY 1 DESC;

select A.*, (select sql_text from dba_hist_sqltext h where h.SQL_ID = a.sql_id ) sql_text  
from ILM_IRPMSPT_RUN A 
where RUN_NAME like 'AWR_ALL_20190608132004';



-- =============================================================================================================================================
-- 부하발생기 JOB Start / Stop
-- =============================================================================================================================================
-- 실행방법 1) 다음의 경우는 즉시 부하발생기 Start하며 SPT_LOAD_STOP를 실행할 떄까지 지속적 실행
BEGIN iRPM_SPT.SPT_LOAD_START (:in_RUN_NAME, :in_RUN_SOURCE); END;
/

-- 실행방법 2) 다음의 경우는 1분뒤에 자동 START하며 10분간 부하 발생
BEGIN iRPM_SPT.SPT_LOAD_START (:in_RUN_NAME, :in_RUN_SOURCE, SYSDATE + 1/(24*60) , SYSDATE + 11/(24*60) ,'N' ); END;
/

-- 실행방법 3) 다음의 경우는 시간을 정확히 지정하여 실행 
BEGIN iRPM_SPT.SPT_LOAD_START (:in_RUN_NAME, :in_RUN_SOURCE, TO_DATE('2020-01-01 00:00:00','YYYY-MM-DD HH24:MI:SS') , TO_DATE('2020-01-01 00:30:00','YYYY-MM-DD HH24:MI:SS'), 'N'  ); END;
/

-- 실행방법 4) 다음의 경우는 시간을 정확히 지정하여 실행하며, 부하TEST시 Commit까지 처리  
BEGIN iRPM_SPT.SPT_LOAD_START (:in_RUN_NAME, :in_RUN_SOURCE, TO_DATE('2020-01-01 00:00:00','YYYY-MM-DD HH24:MI:SS') , TO_DATE('2020-01-01 00:30:00','YYYY-MM-DD HH24:MI:SS'), 'Y'  ); END;
/


-- 지정된 JOB_NAME 부하 발생 Stop
BEGIN iRPM_SPT.SPT_LOAD_STOP (:in_RUN_NAME, :in_RUN_SOURCE); END;
/

 
 
 
-- #############################################################################################################################################
--  
--  SPT 또는 부하발생기 실행동안 DB성능정보 Monitoring
--
--     --> "Host CPU Utilization (%)", "Logical Reads Per Sec"     ,"Physical Reads Per Sec"
--         "Executions Per Sec"      , "User Transaction Per Sec"  ,"Session Count"  
--     --> WITH MY_INPUT절의 값을 입력후 실행, 그대로 실행시 가장 최근에 시행한 JOB의 1번 Node의 DB성능 정보임
--     --> @@@@@@@@@@@@@@@@@  주의) 해당 Data는 최근 1시간 이전 성능정보만 보이므로 1시간 이내 수집 @@@@@@@@@@@@@@@@@@
--
-- #############################################################################################################################################

WITH MY_INPUT AS (
    SELECT
    
    --=====================================================================
    -- 아래의 3개의 값을 입력후 실행하세요~
    -- RAC 여러 Node의 DB성능정보를 확인하기 위해서는 INST_ID를 바꿔가면서 실행
    -- RUN_NAME, RUN_SOURCE가 NULL일 경우 가장 최근에 실행한 JOB의 값을 읽음
    --=====================================================================
    1                           INST_ID,
    NULL                        RUN_NAME,
    NULL                        RUN_SOURCE    
    --=====================================================================
    
    FROM DUAL 
)
,LAST_JOB AS (
    SELECT RUN_NAME, RUN_SOURCE
    FROM (SELECT RUN_NAME,RUN_SOURCE FROM ILM_IRPMSPT_RUNINFO 
          ORDER BY SUBSTR(RUN_NAME,-14) DESC)
    WHERE ROWNUM <= 1 
)
SELECT  INST_ID
       ,TO_CHAR(BEGIN_TIME,'YYYY-MM-DD HH24:MI')  "Snaptime"   
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Host CPU Utilization (%)' , VALUE)),0),1) "Host CPU Utilization (%)"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Logical Reads Per Sec'    , VALUE)),0),1) "Logical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Physical Reads Per Sec'   , VALUE)),0),1) "Physical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Executions Per Sec'       , VALUE)),0),1) "Executions Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'User Transaction Per Sec' , VALUE)),0),1) "User Transaction Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Session Count'            , VALUE)),0),1) "Session Count"  
  FROM (SELECT (RUN_START_DATE - (1/(24*60))) START_DATE , (NVL(RUN_END_DATE,SYSDATE) + (1/(24*60))) END_DATE
        FROM ILM_IRPMSPT_RUNINFO 
        WHERE RUN_NAME   = NVL((SELECT RUN_NAME FROM MY_INPUT),(SELECT RUN_NAME FROM LAST_JOB)) 
          AND RUN_SOURCE LIKE NVL((SELECT RUN_SOURCE FROM MY_INPUT),(SELECT RUN_SOURCE FROM LAST_JOB)) || '%'
       ) A,
       SYS.GV_$SYSMETRIC_HISTORY B
 WHERE 1=1 
   AND INST_ID    = (SELECT INST_ID FROM MY_INPUT)
   AND GROUP_ID   = 2   
   AND METRIC_NAME IN ('Host CPU Utilization (%)','Logical Reads Per Sec','Physical Reads Per Sec',
                       'Executions Per Sec','User Transaction Per Sec','Session Count')
   AND BEGIN_TIME BETWEEN  START_DATE AND END_DATE
 GROUP BY INST_ID,TO_CHAR(BEGIN_TIME,'YYYY-MM-DD HH24:MI') ;
 


  
  


-- #############################################################################################################################################
--
-- ERROR Summary 와 ERROR 상세 SQL List 확인
-- 
--      구분	        오류 유형	                                                            의견
--      ----------- ------------------------------------------------------------------- --------------------------------------------------------
--      ORA-00001	> ORA-00001: 무결성 제약 조건(...)에 위배됩니다	                            ===>  INSERT의 시점 차이로 무시해도 됨
--      ORA-01400	> ORA-01400: NULL을 (...) 안에 삽입할 수 없습니다	                        ===>  SELECT절의 BIND등은 Capture안되어 나타나는 문제. 무시 
--      ORA-14552	> ORA-14552: 질의 안에 또는 DML 안에 DDL, 커밋 또는 롤백을 수행할 수 없습니다      ===>  Function등에 Autonomous Transaction문제. 무시
--      	          ORA-06512: "xxx.xxxxxxx",  000행		
--      	          ORA-16962: SQL 문이 자율 트랜잭션을 시작하려고 시도했습니다.		
--      ORA-00979	> ORA-00979: GROUP BY 표현식이 아닙니다.	                                ===>  CURSOR_SHARING=SIMILAR or FORCE에 의해 발생. 무시해도 됨
--      ORA-01722	> ORA-01722: 수치가 부적합합니다                                          ===>  Bind값 관련. 무식
--      ORA-01840	> ORA-01840: 입력된 값의 길이가 날짜 형식에 비해 부족합니다	                    ===>  Bind값 관련. 무식
--      ORA-02019	> ORA-02019: 원격 데이터베이스 접속을 위한 접속 기술자를 찾을 수 없습니다.          ===>  DB*Link접속 차단하고 실행 원인. 무시
--      ORA-04092	> ORA-04092: 트리거 안에 ROLLBACK를 할 수 없습니다                          ===>  Autonomous Transaction문제. 무시
--      	          ORA-06512: "xxx.xxxxxxxxx",  000행		
--      	          ORA-16962: SQL 문이 자율 트랜잭션을 시작하려고 시도했습니다.		
-- #############################################################################################################################################



WITH MY_INPUT AS (
    SELECT
    --=====================================================================
    -- 아래의 2개의 값을 입력후 실행하세요~
    -- RUN_NAME, RUN_SOURCE가 NULL일 경우 가장 최근에 실행한 JOB의 값을 읽음
    --=====================================================================
    NULL                        RUN_NAME,
    NULL                        RUN_SOURCE    
    --=====================================================================
    FROM DUAL 
)
,LAST_JOB AS (
    SELECT RUN_NAME, RUN_SOURCE
    FROM (SELECT RUN_NAME,RUN_SOURCE FROM ILM_IRPMSPT_RUNINFO 
          ORDER BY SUBSTR(RUN_NAME,-14) DESC)
    WHERE ROWNUM <= 1 
)
SELECT A.RUN_NAME,
       A.ERROR_STR                                                   "Error String",
       A.ERROR_CNT                                                   "Error Count",
       ROUND(DECODE(B.PROC_E,0,0,NULL,0,A.ERROR_CNT/B.PROC_E),4)*100 "Error Pct(%)",
       B.TOT_CNT                                                     "Tot SQL Count",
       B.PROC_E                                                      "Tot SQL Err Count", 
       ROUND(DECODE(B.TOT_CNT,0,0,NULL,0,B.PROC_E/B.TOT_CNT),4)*100  "Total Error Pct(%)",
       -- Comment
       CASE WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-00001' THEN 'INSERT의 시점 차이로 무시해도 됨'
            WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-01008' THEN 'BIND변수 수집이 안된 대상 실행. (UPDATE SET절, SELECT List절, INSERT VALUES절등이 대상)'
            WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-14552' THEN 'Function등에 Autonomous Transaction문제. 무시'
            WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-16962' THEN 'Function등에 Autonomous Transaction문제. 무시'
            WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-16962' THEN 'Autonomous Transaction문제. 무시(TRIGGER는 Disabel후 실행 권장)'
            WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-01722' THEN 'Bind값 관련. 확인 및 무시'
            WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-01840' THEN 'DATE,TIMESTAMP 대상에 문자열로 입력되었으나 NLS_DATE_FORMAT과 맞지 않음'
            WHEN SUBSTR(A.ERROR_STR,1,9) = 'ORA-02019' THEN 'DB*Link접속 차단하고 실행 원인. 무시(DB*Link는 제거 또는 원본 연결 방지후 실행)'
            ELSE ''
       END                                                           "Comment"       
FROM  (SELECT /*+ LEADING(A,B) USE_NL(A B) */ 
               A.RUN_NAME, A.RUN_SOURCE, 
               SUBSTR(EXEC_ERROR,1,INSTR(EXEC_ERROR,'[')-1) ERROR_STR,  
               COUNT(*) ERROR_CNT
        FROM  ILM_IRPMSPT_RUN A
        WHERE 1=1
          AND A.RUN_NAME   = NVL((SELECT RUN_NAME FROM MY_INPUT),(SELECT RUN_NAME FROM LAST_JOB))
          AND A.RUN_SOURCE LIKE NVL((SELECT RUN_SOURCE FROM MY_INPUT),(SELECT RUN_SOURCE FROM LAST_JOB)) || '%'
          AND A.RUN_PROC_YN IN ('E')
        GROUP BY A.RUN_NAME,A.RUN_SOURCE,SUBSTR(EXEC_ERROR,1,INSTR(EXEC_ERROR,'[')-1)
      ) A
     ,ILM_IRPMSPT_RUNINFO B
WHERE A.RUN_NAME   = B.RUN_NAME
  AND SUBSTR(A.RUN_SOURCE,1,3) = B.RUN_SOURCE
ORDER BY 1,3 DESC,2;


-- =============================================================================================================================================
-- ERROR 상세 List
-- 	
-- =============================================================================================================================================

WITH MY_INPUT AS (
    SELECT
    --=====================================================================
    -- 아래의 2개의 값을 입력후 실행하세요~
    -- RUN_NAME, RUN_SOURCE가 NULL일 경우 가장 최근에 실행한 JOB의 값을 읽음
    --=====================================================================
    NULL                        RUN_NAME,
    NULL                        RUN_SOURCE    
    --=====================================================================
    FROM DUAL 
)
,LAST_JOB AS (
    SELECT RUN_NAME, RUN_SOURCE
    FROM (SELECT RUN_NAME,RUN_SOURCE FROM ILM_IRPMSPT_RUNINFO 
          ORDER BY SUBSTR(RUN_NAME,-14) DESC)
    WHERE ROWNUM <= 1 
)
SELECT A.RUN_NAME,A.RUN_SOURCE,A.SQL_ID,  
       SUBSTR(EXEC_ERROR,1,INSTR(EXEC_ERROR,'[')-1) ERROR_STR,
       (select sql_text from dba_hist_sqltext where rowid = A.AWR_ROWID)  SQL_TEXT 
FROM ILM_IRPMSPT_RUN A 
WHERE RUN_NAME   = NVL((SELECT RUN_NAME FROM MY_INPUT),(SELECT RUN_NAME FROM LAST_JOB))
  AND RUN_SOURCE LIKE NVL((SELECT RUN_SOURCE FROM MY_INPUT),(SELECT RUN_SOURCE FROM LAST_JOB)) || '%'
  AND RUN_PROC_YN IN ('E')
ORDER BY 1;  