-- ======================================================================================================================================
-- 0016.COMPARE_SPT_Result_for_AWR(EXEC.vs.EXEC).sql 
-- [SCRIPT 0016 : iRPM SPT의 SQL실행결과 비교 - AWR Repository 사용 대상]
-- 
-- UGENS SPT 결과 비교하기
--
--    실행 완료된 결과를 비교 (수집 SQL성능정보 vs RUN정보)
-- 
--    > AWR Repository(DBA_HIST_SQLSTAT, DBA_HIST_SQLTEXT, DBA_HIST_SQL_PLAN)과 ILM_IRPMSPT_RUN 2개의 Table은 분석 대상으로 수정하여 실행
--    > 아래의 SQL로 분석 대상의 RUN_NAME을 찾아서  수정
--
--    > SQL1 : 통계분석 
--    > SQL2 : 개별SQL 상세 LIST
-- ======================================================================================================================================

-- --------------------------------------------------------------------------------------------------
-- 기존 실행정보 확인하여 분석 대상 RUN_NAME 선택 
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



-- --------------------------------------------------------------------------------------------------
-- SQL1 : 통계분석
-- --------------------------------------------------------------------------------------------------

SELECT B_RUN_NAME || '.vs.' || A_RUN_NAME RUN_NAME,                                                                                                
       -- -------------------------------------------------------------                                                                            
       -- SQL실행대상, Error발생수, Error 율                                                                                                          
       -- -------------------------------------------------------------                                                                            
       COUNT(SQL_ID)                                                                                         "Total SQL Cnt",                    
       COUNT(DISTINCT SQL_ID)                                                                                "Unique SQL Cnt",                   
       SUM(DECODE(A_EXEC_ERROR,NULL,1,0))                                                                    "Run OK Cnt",                       
       SUM(DECODE(A_EXEC_ERROR,NULL,0,1))                                                                    "Run Error Cnt",                    
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(DECODE(A_EXEC_ERROR,NULL,0,1))/COUNT(SQL_ID)),3)                   "Run Error Pct%",                   
       COUNT(DISTINCT PARSING_SCHEMA_NAME)                                                                   "Parsing Schema Cnt",               
       -- -------------------------------------------------------------                                                                            
       -- Plan 변경 통계 (주의. Table/Index구조가 바뀌는 경우는 Plan변경에 대한 Summary는 무의미 함)                                                       
       -- -------------------------------------------------------------                                                                            
       SUM(DECODE(PLAN_CHANGED,'N',1,0))                                                                     "Plan Unchange Cnt",                
       SUM(DECODE(PLAN_CHANGED,'Y',1,0))                                                                     "Plan Change Cnt",                  
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(DECODE(PLAN_CHANGED,'N',1,0))/COUNT(SQL_ID)),3)                    "Plan Unchange Pct%",               
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(DECODE(PLAN_CHANGED,'Y',1,0))/COUNT(SQL_ID)),3)                    "Plan Change Pct%",   
       -- PLAN String
       SUM(DECODE(CASE WHEN B_PLAN_RUNTIME_COMP_HASH IS NULL OR A_PLAN_RUNTIME_COMP_HASH IS NULL THEN 'X'  
                       WHEN B_PLAN_RUNTIME_COMP_HASH = A_PLAN_RUNTIME_COMP_HASH THEN 'N' ELSE 'Y' END,'N',1,0))                          "Plan Str Unchange Cnt",                
       SUM(DECODE(CASE WHEN B_PLAN_RUNTIME_COMP_HASH IS NULL OR A_PLAN_RUNTIME_COMP_HASH IS NULL THEN 'X'  
                       WHEN B_PLAN_RUNTIME_COMP_HASH = A_PLAN_RUNTIME_COMP_HASH THEN 'N' ELSE 'Y' END,'Y',1,0))                          "Plan Str Change Cnt",                  
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(DECODE(CASE WHEN B_PLAN_RUNTIME_COMP_HASH IS NULL OR A_PLAN_RUNTIME_COMP_HASH IS NULL THEN 'X'  
                       WHEN B_PLAN_RUNTIME_COMP_HASH = A_PLAN_RUNTIME_COMP_HASH THEN 'N' ELSE 'Y' END,'N',1,0))/COUNT(SQL_ID)),3)        "Plan Str Unchange Pct%",               
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(DECODE(CASE WHEN B_PLAN_RUNTIME_COMP_HASH IS NULL OR A_PLAN_RUNTIME_COMP_HASH IS NULL THEN 'X'  
                       WHEN B_PLAN_RUNTIME_COMP_HASH = A_PLAN_RUNTIME_COMP_HASH THEN 'N' ELSE 'Y' END,'Y',1,0))/COUNT(SQL_ID)),3)        "Plan Str Change Pct%",    
       
       -- -------------------------------------------------------------                                                                            
       -- Buffer I/O기준 성능 비교 (Pct%는 Ration이나 EXCEL에서 %처리하면 됨)                                                                           
       -- -------------------------------------------------------------                                                                            
       SUM(CASE WHEN BUFFER_IO_GAPS > 0 THEN 1 ELSE 0 END)                                                   "Buff Improved SQL Cnt",            
       SUM(CASE WHEN BUFFER_IO_GAPS = 0 THEN 1 ELSE 0 END)                                                   "Buff Unchange SQL Cnt",            
       SUM(CASE WHEN BUFFER_IO_GAPS < 0 THEN 1 ELSE 0 END)                                                   "Buff Regression SQL Cnt",          
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(CASE WHEN BUFFER_IO_GAPS > 0 THEN 1 ELSE 0 END)/COUNT(SQL_ID)),3)  "Buff Improved SQL Pct%",           
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(CASE WHEN BUFFER_IO_GAPS = 0 THEN 1 ELSE 0 END)/COUNT(SQL_ID)),3)  "Buff Unchange SQL Pct%",           
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(CASE WHEN BUFFER_IO_GAPS < 0 THEN 1 ELSE 0 END)/COUNT(SQL_ID)),3)  "Buff Regression SQL Pct%",         
       ROUND(AVG(BUFFER_IO_GAPS),2)                                                                          "Buff Avg Gaps(Blocks)",            
       ROUND(AVG(BUFFER_IO_GAPS*ASIS_EXECUTIONS),2)                                                          "Buff Avg Gaps(Blocks)*Exec",       
       ROUND(MIN(BUFFER_IO_GAPS),2)                                                                          "Buff Min Gaps(Blocks)",            
       ROUND(MAX(BUFFER_IO_GAPS),2)                                                                          "Buff Max Gaps(Blocks)",            
       ROUND(AVG(IO_IMPROVE_RATIO)/100,2)                                                                    "Buff IO Improve Ratio",            
       ROUND(MIN(IO_IMPROVE_RATIO)/100,2)                                                                    "Buff IO Min Improve Ratio",        
       ROUND(MAX(IO_IMPROVE_RATIO)/100,2)                                                                    "Buff IO Max Improve Ratio",        
       -- -------------------------------------------------------------                                                                            
       -- Elapsed Time기준 성능 비교 (Pct%는 Ration이나 EXCEL에서 %처리하면 됨)                                                                         
       -- -------------------------------------------------------------                                                                            
       SUM(CASE WHEN ELAPSE_TIME_GAP > 0 THEN 1 ELSE 0 END)                                                  "Elapsed Improved SQL Cnt",         
       SUM(CASE WHEN ELAPSE_TIME_GAP = 0 THEN 1 ELSE 0 END)                                                  "Elapsed Unchange SQL Cnt",         
       SUM(CASE WHEN ELAPSE_TIME_GAP < 0 THEN 1 ELSE 0 END)                                                  "Elapsed Regression SQL Cnt",       
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(CASE WHEN ELAPSE_TIME_GAP > 0 THEN 1 ELSE 0 END)/COUNT(SQL_ID)),3) "Elapsed Improved SQL Pct%",        
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(CASE WHEN ELAPSE_TIME_GAP = 0 THEN 1 ELSE 0 END)/COUNT(SQL_ID)),3) "Elapsed Unchange SQL Pct%",        
       ROUND(DECODE(COUNT(SQL_ID),0,0,SUM(CASE WHEN ELAPSE_TIME_GAP < 0 THEN 1 ELSE 0 END)/COUNT(SQL_ID)),3) "Elapsed Regression SQL Pct%",      
       ROUND(AVG(ELAPSE_TIME_GAP),2)                                                                         "Elapsed Avg Gaps(Blocks)",         
       ROUND(AVG(ELAPSE_TIME_GAP*ASIS_EXECUTIONS),2)                                                         "Elapsed Avg Gaps(Blocks)*Exec",    
       ROUND(MIN(ELAPSE_TIME_GAP),2)                                                                         "Elapsed Min Gaps(Blocks)",         
       ROUND(MAX(ELAPSE_TIME_GAP),2)                                                                         "Elapsed Max Gaps(Blocks)"          
FROM

-- ############################################################################################## START
(SELECT /*+ LEADING(AA BB) USE_HASH(AA BB CC) AWR_EXEC_VS_EXEC */
       TRUNC(SYSDATE)                      RUN_DATE,
       'AWR_SPT[INST,AWR Snap]: [' || TO_CHAR(AA.INSTANCE_NUMBER) ||','|| AA.MIN_SNAP_ID || ' ~ ' || AA.MAX_SNAP_ID || ']'      RUN_INFO,
       BB.RUN_NAME                         B_RUN_NAME,
       AA.RUN_NAME                         A_RUN_NAME,
       CC.SQL_ID,
       DECODE(DD.BASELINE_SQL_ID,NULL,'N','Y')        SQL_PLAN_BASELINE_YN,
       DECODE(EE.SQLPROFILE_SQL_ID,NULL,'N','Y')      SQL_PROFILS_YN,
       CC.PARSING_SCHEMA_NAME,
       CC.MODULE,
       (select sql_text from dba_hist_sqltext where rowid = AA.AWR_ROWID)  SQL_TEXT,
       RANK() OVER (ORDER BY CC.CPU_TIME DESC)                                                 CPU_USAGE_RANK,
       ROUND(nvl(ratio_to_report(CC.CPU_TIME) over (),0),5)                                    CPU_USAGE_RATIO,
       B_PLAN,
       A_PLAN,
       B_PLAN_COMPARE,
       A_PLAN_COMPARE,
       B_PLAN_HASH,
       A_PLAN_HASH,
       DECODE(A_PLAN_HASH,NULL,'',B_PLAN_HASH,'N','Y')   PLAN_CHANGED,
       CC.EXECUTIONS AS ASIS_EXECUTIONS,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P')  OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE CASE WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) > 0 THEN
               round(decode(B_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/B_BUFFER_GETS)*100,2)),2)
            WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) < 0 THEN
               round(decode(A_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/A_BUFFER_GETS)*100,2)),2)
            ELSE 0.00
       END END IO_IMPROVE_RATIO,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P')  OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE  CASE WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) > 0 THEN
               round(decode(B_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/B_BUFFER_GETS)*100,2)),2)
            WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) < 0 THEN
               round(decode(A_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/A_BUFFER_GETS)*100,2)),2)
            ELSE 0.00
       END * CC.EXECUTIONS END IO_IMPACT_ESTIMATE,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P')  OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE  B_BUFFER_GETS - A_BUFFER_GETS END BUFFER_IO_GAPS,
       B_BUFFER_GETS,
       A_BUFFER_GETS,
       round(decode(CC.executions,null,0,0,0,(nvl(CC.buffer_gets,0)/CC.executions)),0)                ASIS_BUFFER_GETS,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P') OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE B_ELAPSED_TIME - A_ELAPSED_TIME END ELAPSE_TIME_GAP,
       B_ELAPSED_TIME,
       A_ELAPSED_TIME,
       round(decode(CC.executions,null,0,0,0,(nvl(CC.ELAPSED_TIME,0)/CC.executions)/ 1000000),5)      ASIS_ELAPSED_TIME,
       B_CPU_TIME,
       A_CPU_TIME,
       B_EXECUTIONS,
       A_EXECUTIONS,
       B_DISK_READS,
       A_DISK_READS,
       B_USER_IO_TIME,
       A_USER_IO_TIME,
       B_ROWS_PROCESSED,
       A_ROWS_PROCESSED,
       round(decode(CC.executions,null,0,0,0,(nvl(CC.ROWS_PROCESSED,0)/CC.executions)),0)             ASIS_ROWS_PROCESSED,
       B_PREFETCH_CNT,
       A_PREFETCH_CNT,
       B_BUFFER_GETS_2 ,
       A_BUFFER_GETS_2 ,
       B_ELAPSED_TIME_2 ,
       A_ELAPSED_TIME_2 ,
       B_DISK_READS_2 ,
       A_DISK_READS_2 ,
       B_ROWS_PROCESSED_2 ,
       A_ROWS_PROCESSED_2 ,
       iRPM_SPT.GET_SQLBIND_STS(CC.BIND_DATA) AS BIND_VALUE,
       CC.ELAPSED_TIME,
       CC.CPU_TIME,
       CC.BUFFER_GETS,
       CC.DIRECT_WRITES,
       CC.FETCHES,
       AA.COMMAND_TYPE,
       CC.FORCE_MATCHING_SIGNATURE,
       CC.FIRST_LOAD_TIME,
       BB.SPT_SQL_ID           B_SPT_SQL_ID,
       BB.SPT_PLAN_HASH_VALUE  B_SPT_PLAN_HASH_VALUE,
       AA.SPT_SQL_ID           A_SPT_SQL_ID,
       AA.SPT_PLAN_HASH_VALUE  A_SPT_PLAN_HASH_VALUE,

       CASE WHEN BB.QUERY_RESULT_SHA1 IS NULL AND AA.QUERY_RESULT_SHA1 IS NULL THEN NULL
            WHEN BB.QUERY_RESULT_SHA1 = AA.QUERY_RESULT_SHA1 THEN 'Query Result Same'
            WHEN BB.QUERY_RESULT_SHA1 = AA.QUERY_RESULT_SHA1 THEN 'Query Result Not Same'
            ELSE NULL
       END QUERY_RESULT_COMP,
       UTL_RAW.CAST_TO_VARCHAR2(BB.QUERY_RESULT_SHA1) B_QUERY_RESULT_SHA1,
       UTL_RAW.CAST_TO_VARCHAR2(AA.QUERY_RESULT_SHA1) A_QUERY_RESULT_SHA1,
       BB.SQL_PROFILE B_SQL_PROFILE,
       AA.SQL_PROFILE A_SQL_PROFILE,
       BB.SQL_PATCH   B_SQL_PATCH,
       AA.SQL_PATCH   A_SQL_PATCH,
       BB.SQL_PLAN_BASELINE B_SQL_PLAN_BASELINE,
       AA.SQL_PLAN_BASELINE A_SQL_PLAN_BASELINE,
       B_EXEC_ERROR,
       A_EXEC_ERROR,
       B_PLAN_RUNTIME_COMP_HASH,
       A_PLAN_RUNTIME_COMP_HASH,
       NULL CHILD_NUMBER
FROM
    (select
            y.RUN_NAME
           ,y.sql_id
           ,MIN_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 Start Snap ID (윰_hist_snapshot)
           ,MAX_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 End Snap ID (dba_hist_snapshot)
           ,DBID                                 -- AWR Only : AWR Repository의 수집대상의 DBID (dba_hist_snapshot)
           ,INSTANCE_NUMBER                      -- AWR Only : AWR Repository의 수집대상의 INSTANCE_NUMBER (dba_hist_snapshot)
           ,AWR_PLAN_HASH_VALUE                  -- AWR Only : AWR Repository의 수집대상SQL의 PLAN_HASH_VALUE (dba_hist_sql_plan)
           ,AWR_ROWID                            -- AWR Only : AWR Repository의 수집대상SQL의 SQL TEXT의 ROWID (dba_hist_sqltext)
           ,PLAN_RUNTIME       B_PLAN
           ,PLAN_RUNTIME_COMP  B_PLAN_COMPARE
           ,y.PLAN_HASH_VALUE  B_PLAN_HASH
           ,round(decode(executions,null,0,0,0,(nvl(SQL_BUFFER_GETS,0)/executions)),0)                B_BUFFER_GETS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_ELAPSED_TIME,0)/executions)/ 1000000),5)      B_ELAPSED_TIME
           ,round(decode(executions,null,0,0,0,(nvl(CPU_TIME,0)/executions)/ 1000000),5)              B_CPU_TIME
           ,round(decode(executions,null,0,0,0,(nvl(USER_IO_WAIT_TIME,0)/executions)/ 1000000),5)     B_USER_IO_TIME
           ,EXECUTIONS                                                                                B_EXECUTIONS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_DISK_READS,0)/executions)),0)                 B_DISK_READS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_OUTPUT_ROWS,0)/executions)),0)                B_ROWS_PROCESSED
           ,round(decode(executions,null,0,0,0,(nvl(buffer_gets,0)/executions)),0)                    B_BUFFER_GETS_2
           ,round(decode(executions,null,0,0,0,(nvl(ELAPSED_TIME,0)/executions)/ 1000000),5)          B_ELAPSED_TIME_2
           ,round(decode(executions,null,0,0,0,(nvl(DISK_READS,0)/executions)),0)                     B_DISK_READS_2
           ,round(decode(executions,null,0,0,0,(nvl(ROWS_PROCESSED,0)/executions)),0)                 B_ROWS_PROCESSED_2
           ,DECODE(FETCHES,0,1,NULL,1,DECODE(ROWS_PROCESSED,0,1,CEIL(ROWS_PROCESSED/FETCHES)))        B_PREFETCH_CNT
           ,EXEC_ERROR                                                                                B_EXEC_ERROR
           ,STS_ROWID
           ,SPT_SQL_ID
           ,SPT_PLAN_HASH_VALUE
           ,QUERY_RESULT_SHA1
           ,SQL_PROFILE
           ,SQL_PATCH
           ,SQL_PLAN_BASELINE , RUN_PROC_YN
           ,PLAN_RUNTIME_COMP_HASH B_PLAN_RUNTIME_COMP_HASH
    from   ILM_IRPMSPT_RUN y
    WHERE 1 = 1
      AND RUN_NAME = '@@RUNNAME_BEFORE@@'
      AND RUN_SOURCE like 'AWR%'
    ) BB,
    (select
            y.RUN_NAME
           ,y.sql_id
           ,MIN_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 Start Snap ID (dba_hist_snapshot)
           ,MAX_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 End Snap ID (dba_hist_snapshot)
           ,DBID                                 -- AWR Only : AWR Repository의 수집대상의 DBID (dba_hist_snapshot)
           ,INSTANCE_NUMBER                      -- AWR Only : AWR Repository의 수집대상의 INSTANCE_NUMBER (dba_hist_snapshot)
           ,AWR_PLAN_HASH_VALUE                  -- AWR Only : AWR Repository의 수집대상SQL의 PLAN_HASH_VALUE (dba_hist_sql_plan)
           ,AWR_ROWID                            -- AWR Only : AWR Repository의 수집대상SQL의 SQL TEXT의 ROWID (dba_hist_sqltext)
           ,PLAN_RUNTIME       A_PLAN
           ,PLAN_RUNTIME_COMP  A_PLAN_COMPARE
           ,y.PLAN_HASH_VALUE  A_PLAN_HASH
           ,round(decode(executions,null,0,0,0,(nvl(SQL_BUFFER_GETS,0)/executions)),0)                A_BUFFER_GETS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_ELAPSED_TIME,0)/executions)/ 1000000),5)      A_ELAPSED_TIME
           ,round(decode(executions,null,0,0,0,(nvl(CPU_TIME,0)/executions)/ 1000000),5)              A_CPU_TIME
           ,round(decode(executions,null,0,0,0,(nvl(USER_IO_WAIT_TIME,0)/executions)/ 1000000),5)     A_USER_IO_TIME
           ,EXECUTIONS                                                                                A_EXECUTIONS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_DISK_READS,0)/executions)),0)                 A_DISK_READS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_OUTPUT_ROWS,0)/executions)),0)                A_ROWS_PROCESSED
           --V$SQL (여기서 가져오는 컬럼은 _2로 했음)
           ,round(decode(executions,null,0,0,0,(nvl(buffer_gets,0)/executions)),0)                    A_BUFFER_GETS_2
           ,round(decode(executions,null,0,0,0,(nvl(ELAPSED_TIME,0)/executions)/ 1000000),5)          A_ELAPSED_TIME_2
           ,round(decode(executions,null,0,0,0,(nvl(DISK_READS,0)/executions)),0)                     A_DISK_READS_2
           ,round(decode(executions,null,0,0,0,(nvl(ROWS_PROCESSED,0)/executions)),0)                 A_ROWS_PROCESSED_2
           ,DECODE(FETCHES,0,1,NULL,1,DECODE(ROWS_PROCESSED,0,1,CEIL(ROWS_PROCESSED/FETCHES)))        A_PREFETCH_CNT
           ,EXEC_ERROR                                                                                A_EXEC_ERROR
           ,STS_ROWID
           ,SPT_SQL_ID
           ,SPT_PLAN_HASH_VALUE
           ,QUERY_RESULT_SHA1
           ,SQL_PROFILE
           ,SQL_PATCH
           ,SQL_PLAN_BASELINE
           ,COMMAND_TYPE  , RUN_PROC_YN
           ,PLAN_RUNTIME_COMP_HASH A_PLAN_RUNTIME_COMP_HASH
    from   ILM_IRPMSPT_RUN y
    WHERE 1 = 1
     AND RUN_NAME = '@@RUNNAME_AFTER@@'
     AND RUN_SOURCE like 'AWR%'
    ) AA ,
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
            , MIN('SNAP_ID:' || SNAP_ID)                FIRST_LOAD_TIME
      from  (SELECT DBID,INSTANCE_NUMBER,SQL_ID ,MIN_SNAP_ID ,MAX_SNAP_ID
            from   ILM_IRPMSPT_RUN y
            WHERE  RUN_NAME = '@@RUNNAME_BEFORE@@'
              AND  RUN_SOURCE like 'AWR%'
            ) V1,
            dba_hist_sqlstat  sy
     WHERE  1=1
       and sy.snap_id         BETWEEN V1.MIN_SNAP_ID AND V1.MAX_SNAP_ID
       and sy.dbid            = V1.dbid
       and sy.instance_number = V1.instance_number
       and sy.sql_id          = V1.sql_id
     group by sy.dbid,sy.sql_id,sy.plan_hash_value) CC,
    (SELECT DISTINCT IRPM_SPT.SQLTEXT_TO_SQLID(SQL_TEXT) BASELINE_SQL_ID FROM DBA_SQL_PLAN_BASELINES) DD,
    (SELECT DISTINCT IRPM_SPT.SQLTEXT_TO_SQLID(SQL_TEXT) SQLPROFILE_SQL_ID FROM DBA_SQL_PROFILES) EE
WHERE 1=1
  AND AA.MIN_SNAP_ID           = BB.MIN_SNAP_ID
  AND AA.MAX_SNAP_ID           = BB.MAX_SNAP_ID
  AND AA.DBID                  = BB.DBID
  AND AA.INSTANCE_NUMBER       = BB.INSTANCE_NUMBER
  AND AA.AWR_PLAN_HASH_VALUE   = BB.AWR_PLAN_HASH_VALUE
  AND AA.SQL_ID                = BB.SQL_ID
  AND AA.DBID                  = CC.DBID
  AND AA.SQL_ID                = CC.SQL_ID
  AND AA.AWR_PLAN_HASH_VALUE   = CC.PLAN_HASH_VALUE
  AND AA.SQL_ID                = DD.BASELINE_SQL_ID(+)
  AND AA.SQL_ID                = EE.SQLPROFILE_SQL_ID(+)
  --WHERE_PREDICATE
 ) MAIN
-- ############################################################################################## END
GROUP BY B_RUN_NAME || '.vs.' || A_RUN_NAME; 




-- --------------------------------------------------------------------------------------------------
-- SQL2 : 개별SQL 상세 LIST
-- --------------------------------------------------------------------------------------------------

SELECT QQ.*
FROM (SELECT ROW_NUMBER() OVER(ORDER BY ASIS_EXECUTIONS DESC) SEQ, RUN_DATE, RUN_INFO, B_RUN_NAME, A_RUN_NAME, SQL_ID, ASIS_EXECUTIONS, IO_IMPROVE_RATIO, IO_IMPACT_ESTIMATE, BUFFER_IO_GAPS,
       B_BUFFER_GETS, A_BUFFER_GETS, ASIS_BUFFER_GETS, PARSING_SCHEMA_NAME, MODULE, SQL_TEXT, CPU_USAGE_RANK, CPU_USAGE_RATIO, B_PLAN, A_PLAN,
       B_PLAN_COMPARE,A_PLAN_COMPARE, B_PLAN_RUNTIME_COMP_HASH B_PLAN_STRING_HASH, A_PLAN_RUNTIME_COMP_HASH A_PLAN_STRING_HASH, 
       CASE WHEN  B_PLAN_RUNTIME_COMP_HASH IS NULL OR A_PLAN_RUNTIME_COMP_HASH IS NULL THEN 'X'  WHEN B_PLAN_RUNTIME_COMP_HASH = A_PLAN_RUNTIME_COMP_HASH THEN 'N' ELSE 'Y' END   PLAN_STRING_CHANGED, 
       B_PLAN_HASH, A_PLAN_HASH, PLAN_CHANGED, ELAPSE_TIME_GAP, B_ELAPSED_TIME, A_ELAPSED_TIME,ASIS_ELAPSED_TIME,B_CPU_TIME, A_CPU_TIME,
       B_EXECUTIONS, A_EXECUTIONS, B_DISK_READS, A_DISK_READS, B_USER_IO_TIME, A_USER_IO_TIME, B_ROWS_PROCESSED, A_ROWS_PROCESSED  , ASIS_ROWS_PROCESSED, B_PREFETCH_CNT,
       A_PREFETCH_CNT,  B_BUFFER_GETS_2 ,A_BUFFER_GETS_2 ,B_ELAPSED_TIME_2,A_ELAPSED_TIME_2 , B_DISK_READS_2, A_DISK_READS_2 , B_ROWS_PROCESSED_2, A_ROWS_PROCESSED_2 , BIND_VALUE,ELAPSED_TIME,
       CPU_TIME, BUFFER_GETS, DIRECT_WRITES, FETCHES, COMMAND_TYPE, FORCE_MATCHING_SIGNATURE, FIRST_LOAD_TIME ,CHILD_NUMBER, B_SPT_SQL_ID, B_SPT_PLAN_HASH_VALUE,
       A_SPT_SQL_ID, A_SPT_PLAN_HASH_VALUE, QUERY_RESULT_COMP, B_QUERY_RESULT_SHA1, A_QUERY_RESULT_SHA1, B_SQL_PROFILE, A_SQL_PROFILE, B_SQL_PATCH,
       A_SQL_PATCH, B_SQL_PLAN_BASELINE, A_SQL_PLAN_BASELINE, SQL_PLAN_BASELINE_YN, SQL_PROFILS_YN, COUNT(*) OVER() TOT_COUNT , B_EXEC_ERROR, A_EXEC_ERROR
FROM
-- ############################################################################################## START
(SELECT /*+ LEADING(AA BB) USE_HASH(AA BB CC) AWR_EXEC_VS_EXEC */
       TRUNC(SYSDATE)                      RUN_DATE,
       'AWR_SPT[INST,AWR Snap]: [' || TO_CHAR(AA.INSTANCE_NUMBER) ||','|| AA.MIN_SNAP_ID || ' ~ ' || AA.MAX_SNAP_ID || ']'      RUN_INFO,
       BB.RUN_NAME                         B_RUN_NAME,
       AA.RUN_NAME                         A_RUN_NAME,
       CC.SQL_ID,
       DECODE(DD.BASELINE_SQL_ID,NULL,'N','Y')        SQL_PLAN_BASELINE_YN,
       DECODE(EE.SQLPROFILE_SQL_ID,NULL,'N','Y')      SQL_PROFILS_YN,
       CC.PARSING_SCHEMA_NAME,
       CC.MODULE,
       (select sql_text from dba_hist_sqltext where rowid = AA.AWR_ROWID)  SQL_TEXT,
       RANK() OVER (ORDER BY CC.CPU_TIME DESC)                                                 CPU_USAGE_RANK,
       ROUND(nvl(ratio_to_report(CC.CPU_TIME) over (),0),5)                                    CPU_USAGE_RATIO,
       B_PLAN,
       A_PLAN,
       B_PLAN_COMPARE,
       A_PLAN_COMPARE,
       B_PLAN_HASH,
       A_PLAN_HASH,
       DECODE(A_PLAN_HASH,NULL,'',B_PLAN_HASH,'N','Y')   PLAN_CHANGED,
       CC.EXECUTIONS AS ASIS_EXECUTIONS,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P')  OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE CASE WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) > 0 THEN
               round(decode(B_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/B_BUFFER_GETS)*100,2)),2)
            WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) < 0 THEN
               round(decode(A_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/A_BUFFER_GETS)*100,2)),2)
            ELSE 0.00
       END END IO_IMPROVE_RATIO,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P')  OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE  CASE WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) > 0 THEN
               round(decode(B_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/B_BUFFER_GETS)*100,2)),2)
            WHEN  (B_BUFFER_GETS - A_BUFFER_GETS) < 0 THEN
               round(decode(A_BUFFER_GETS,0,0,round(((B_BUFFER_GETS - A_BUFFER_GETS)/A_BUFFER_GETS)*100,2)),2)
            ELSE 0.00
       END * CC.EXECUTIONS END IO_IMPACT_ESTIMATE,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P')  OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE  B_BUFFER_GETS - A_BUFFER_GETS END BUFFER_IO_GAPS,
       B_BUFFER_GETS,
       A_BUFFER_GETS,
       round(decode(CC.executions,null,0,0,0,(nvl(CC.buffer_gets,0)/CC.executions)),0)                ASIS_BUFFER_GETS,
       CASE WHEN AA.RUN_PROC_YN IN ('T','E','S','P') OR BB.RUN_PROC_YN IN ('T','E','S','P')  THEN NULL ELSE B_ELAPSED_TIME - A_ELAPSED_TIME END ELAPSE_TIME_GAP,
       B_ELAPSED_TIME,
       A_ELAPSED_TIME,
       round(decode(CC.executions,null,0,0,0,(nvl(CC.ELAPSED_TIME,0)/CC.executions)/ 1000000),5)      ASIS_ELAPSED_TIME,
       B_CPU_TIME,
       A_CPU_TIME,
       B_EXECUTIONS,
       A_EXECUTIONS,
       B_DISK_READS,
       A_DISK_READS,
       B_USER_IO_TIME,
       A_USER_IO_TIME,
       B_ROWS_PROCESSED,
       A_ROWS_PROCESSED,
       round(decode(CC.executions,null,0,0,0,(nvl(CC.ROWS_PROCESSED,0)/CC.executions)),0)             ASIS_ROWS_PROCESSED,
       B_PREFETCH_CNT,
       A_PREFETCH_CNT,
       B_BUFFER_GETS_2 ,
       A_BUFFER_GETS_2 ,
       B_ELAPSED_TIME_2 ,
       A_ELAPSED_TIME_2 ,
       B_DISK_READS_2 ,
       A_DISK_READS_2 ,
       B_ROWS_PROCESSED_2 ,
       A_ROWS_PROCESSED_2 ,
       iRPM_SPT.GET_SQLBIND_STS(CC.BIND_DATA) AS BIND_VALUE,
       CC.ELAPSED_TIME,
       CC.CPU_TIME,
       CC.BUFFER_GETS,
       CC.DIRECT_WRITES,
       CC.FETCHES,
       AA.COMMAND_TYPE,
       CC.FORCE_MATCHING_SIGNATURE,
       CC.FIRST_LOAD_TIME,
       BB.SPT_SQL_ID           B_SPT_SQL_ID,
       BB.SPT_PLAN_HASH_VALUE  B_SPT_PLAN_HASH_VALUE,
       AA.SPT_SQL_ID           A_SPT_SQL_ID,
       AA.SPT_PLAN_HASH_VALUE  A_SPT_PLAN_HASH_VALUE,

       CASE WHEN BB.QUERY_RESULT_SHA1 IS NULL AND AA.QUERY_RESULT_SHA1 IS NULL THEN NULL
            WHEN BB.QUERY_RESULT_SHA1 = AA.QUERY_RESULT_SHA1 THEN 'Query Result Same'
            WHEN BB.QUERY_RESULT_SHA1 = AA.QUERY_RESULT_SHA1 THEN 'Query Result Not Same'
            ELSE NULL
       END QUERY_RESULT_COMP,
       UTL_RAW.CAST_TO_VARCHAR2(BB.QUERY_RESULT_SHA1) B_QUERY_RESULT_SHA1,
       UTL_RAW.CAST_TO_VARCHAR2(AA.QUERY_RESULT_SHA1) A_QUERY_RESULT_SHA1,
       BB.SQL_PROFILE B_SQL_PROFILE,
       AA.SQL_PROFILE A_SQL_PROFILE,
       BB.SQL_PATCH   B_SQL_PATCH,
       AA.SQL_PATCH   A_SQL_PATCH,
       BB.SQL_PLAN_BASELINE B_SQL_PLAN_BASELINE,
       AA.SQL_PLAN_BASELINE A_SQL_PLAN_BASELINE,
       B_EXEC_ERROR,
       A_EXEC_ERROR,
       B_PLAN_RUNTIME_COMP_HASH,
       A_PLAN_RUNTIME_COMP_HASH,
       NULL CHILD_NUMBER
FROM
    (select
            y.RUN_NAME
           ,y.sql_id
           ,MIN_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 Start Snap ID (윰_hist_snapshot)
           ,MAX_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 End Snap ID (dba_hist_snapshot)
           ,DBID                                 -- AWR Only : AWR Repository의 수집대상의 DBID (dba_hist_snapshot)
           ,INSTANCE_NUMBER                      -- AWR Only : AWR Repository의 수집대상의 INSTANCE_NUMBER (dba_hist_snapshot)
           ,AWR_PLAN_HASH_VALUE                  -- AWR Only : AWR Repository의 수집대상SQL의 PLAN_HASH_VALUE (dba_hist_sql_plan)
           ,AWR_ROWID                            -- AWR Only : AWR Repository의 수집대상SQL의 SQL TEXT의 ROWID (dba_hist_sqltext)
           ,PLAN_RUNTIME       B_PLAN
           ,PLAN_RUNTIME_COMP  B_PLAN_COMPARE
           ,y.PLAN_HASH_VALUE  B_PLAN_HASH
           ,round(decode(executions,null,0,0,0,(nvl(SQL_BUFFER_GETS,0)/executions)),0)                B_BUFFER_GETS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_ELAPSED_TIME,0)/executions)/ 1000000),5)      B_ELAPSED_TIME
           ,round(decode(executions,null,0,0,0,(nvl(CPU_TIME,0)/executions)/ 1000000),5)              B_CPU_TIME
           ,round(decode(executions,null,0,0,0,(nvl(USER_IO_WAIT_TIME,0)/executions)/ 1000000),5)     B_USER_IO_TIME
           ,EXECUTIONS                                                                                B_EXECUTIONS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_DISK_READS,0)/executions)),0)                 B_DISK_READS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_OUTPUT_ROWS,0)/executions)),0)                B_ROWS_PROCESSED
           ,round(decode(executions,null,0,0,0,(nvl(buffer_gets,0)/executions)),0)                    B_BUFFER_GETS_2
           ,round(decode(executions,null,0,0,0,(nvl(ELAPSED_TIME,0)/executions)/ 1000000),5)          B_ELAPSED_TIME_2
           ,round(decode(executions,null,0,0,0,(nvl(DISK_READS,0)/executions)),0)                     B_DISK_READS_2
           ,round(decode(executions,null,0,0,0,(nvl(ROWS_PROCESSED,0)/executions)),0)                 B_ROWS_PROCESSED_2
           ,DECODE(FETCHES,0,1,NULL,1,DECODE(ROWS_PROCESSED,0,1,CEIL(ROWS_PROCESSED/FETCHES)))        B_PREFETCH_CNT
           ,EXEC_ERROR                                                                                B_EXEC_ERROR
           ,STS_ROWID
           ,SPT_SQL_ID
           ,SPT_PLAN_HASH_VALUE
           ,QUERY_RESULT_SHA1
           ,SQL_PROFILE
           ,SQL_PATCH
           ,SQL_PLAN_BASELINE , RUN_PROC_YN
           ,PLAN_RUNTIME_COMP_HASH B_PLAN_RUNTIME_COMP_HASH
    from   ILM_IRPMSPT_RUN y
    WHERE 1 = 1
      AND RUN_NAME = '@@RUNNAME_BEFORE@@'
      AND RUN_SOURCE like 'AWR%'
    ) BB,
    (select
            y.RUN_NAME
           ,y.sql_id
           ,MIN_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 Start Snap ID (dba_hist_snapshot)
           ,MAX_SNAP_ID                          -- AWR Only : AWR Repository의 수집대상의 End Snap ID (dba_hist_snapshot)
           ,DBID                                 -- AWR Only : AWR Repository의 수집대상의 DBID (dba_hist_snapshot)
           ,INSTANCE_NUMBER                      -- AWR Only : AWR Repository의 수집대상의 INSTANCE_NUMBER (dba_hist_snapshot)
           ,AWR_PLAN_HASH_VALUE                  -- AWR Only : AWR Repository의 수집대상SQL의 PLAN_HASH_VALUE (dba_hist_sql_plan)
           ,AWR_ROWID                            -- AWR Only : AWR Repository의 수집대상SQL의 SQL TEXT의 ROWID (dba_hist_sqltext)
           ,PLAN_RUNTIME       A_PLAN
           ,PLAN_RUNTIME_COMP  A_PLAN_COMPARE
           ,y.PLAN_HASH_VALUE  A_PLAN_HASH
           ,round(decode(executions,null,0,0,0,(nvl(SQL_BUFFER_GETS,0)/executions)),0)                A_BUFFER_GETS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_ELAPSED_TIME,0)/executions)/ 1000000),5)      A_ELAPSED_TIME
           ,round(decode(executions,null,0,0,0,(nvl(CPU_TIME,0)/executions)/ 1000000),5)              A_CPU_TIME
           ,round(decode(executions,null,0,0,0,(nvl(USER_IO_WAIT_TIME,0)/executions)/ 1000000),5)     A_USER_IO_TIME
           ,EXECUTIONS                                                                                A_EXECUTIONS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_DISK_READS,0)/executions)),0)                 A_DISK_READS
           ,round(decode(executions,null,0,0,0,(nvl(SQL_OUTPUT_ROWS,0)/executions)),0)                A_ROWS_PROCESSED
           --V$SQL (여기서 가져오는 컬럼은 _2로 했음)
           ,round(decode(executions,null,0,0,0,(nvl(buffer_gets,0)/executions)),0)                    A_BUFFER_GETS_2
           ,round(decode(executions,null,0,0,0,(nvl(ELAPSED_TIME,0)/executions)/ 1000000),5)          A_ELAPSED_TIME_2
           ,round(decode(executions,null,0,0,0,(nvl(DISK_READS,0)/executions)),0)                     A_DISK_READS_2
           ,round(decode(executions,null,0,0,0,(nvl(ROWS_PROCESSED,0)/executions)),0)                 A_ROWS_PROCESSED_2
           ,DECODE(FETCHES,0,1,NULL,1,DECODE(ROWS_PROCESSED,0,1,CEIL(ROWS_PROCESSED/FETCHES)))        A_PREFETCH_CNT
           ,EXEC_ERROR                                                                                A_EXEC_ERROR
           ,STS_ROWID
           ,SPT_SQL_ID
           ,SPT_PLAN_HASH_VALUE
           ,QUERY_RESULT_SHA1
           ,SQL_PROFILE
           ,SQL_PATCH
           ,SQL_PLAN_BASELINE
           ,COMMAND_TYPE  , RUN_PROC_YN
           ,PLAN_RUNTIME_COMP_HASH A_PLAN_RUNTIME_COMP_HASH
    from   ILM_IRPMSPT_RUN y
    WHERE 1 = 1
     AND RUN_NAME = '@@RUNNAME_AFTER@@'
     AND RUN_SOURCE like 'AWR%'
    ) AA ,
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
            , MIN('SNAP_ID:' || SNAP_ID)                FIRST_LOAD_TIME
      from  (SELECT DBID,INSTANCE_NUMBER,SQL_ID ,MIN_SNAP_ID ,MAX_SNAP_ID
            from   ILM_IRPMSPT_RUN y
            WHERE  RUN_NAME = '@@RUNNAME_BEFORE@@'
              AND  RUN_SOURCE like 'AWR%'
            ) V1,
            dba_hist_sqlstat  sy
     WHERE  1=1
       and sy.snap_id         BETWEEN V1.MIN_SNAP_ID AND V1.MAX_SNAP_ID
       and sy.dbid            = V1.dbid
       and sy.instance_number = V1.instance_number
       and sy.sql_id          = V1.sql_id
     group by sy.dbid,sy.sql_id,sy.plan_hash_value) CC,
    (SELECT DISTINCT IRPM_SPT.SQLTEXT_TO_SQLID(SQL_TEXT) BASELINE_SQL_ID FROM DBA_SQL_PLAN_BASELINES) DD,
    (SELECT DISTINCT IRPM_SPT.SQLTEXT_TO_SQLID(SQL_TEXT) SQLPROFILE_SQL_ID FROM DBA_SQL_PROFILES) EE
WHERE 1=1
  AND AA.MIN_SNAP_ID           = BB.MIN_SNAP_ID
  AND AA.MAX_SNAP_ID           = BB.MAX_SNAP_ID
  AND AA.DBID                  = BB.DBID
  AND AA.INSTANCE_NUMBER       = BB.INSTANCE_NUMBER
  AND AA.AWR_PLAN_HASH_VALUE   = BB.AWR_PLAN_HASH_VALUE
  AND AA.SQL_ID                = BB.SQL_ID
  AND AA.DBID                  = CC.DBID
  AND AA.SQL_ID                = CC.SQL_ID
  AND AA.AWR_PLAN_HASH_VALUE   = CC.PLAN_HASH_VALUE
  AND AA.SQL_ID                = DD.BASELINE_SQL_ID(+)
  AND AA.SQL_ID                = EE.SQLPROFILE_SQL_ID(+)
  --WHERE_PREDICATE
 ) MAIN
-- ############################################################################################## END
 
) QQ
ORDER BY ASIS_EXECUTIONS DESC;