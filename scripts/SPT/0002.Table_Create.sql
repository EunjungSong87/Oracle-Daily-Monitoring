-- ========================================================================================================================
-- 0002.Table_Create.sql 
-- [SCRIPT 0002 : iRPM SPT의 Repository Schema의 TABLE생성]
-- 
-- Change String --> Running
--
--    1. IRPM SPT Repository Owner 계정으로 실행
--    2. iRPM Repository용 Tablespace는 사전에 생성 (1GB이상 권장)
--    3. iRPM Repository Schema계정 생성 및 아래의 변경 절차로 변경후 Script 실행
--
--    @@TABLESPACE@@          : REPOSITORY Tablespace Name
--
--    > iRPM의 Repository의 TABLESPACE를 "USERS"로 할 경우 다음과 같이 모든 Script변경
--    @@TABLESPACE@@          --> USERS
--
-- ========================================================================================================================


-- ==================================================================================================================
-- iRPM SPT 실행 Summary Main Info 테이블 생성
-- ==================================================================================================================
--  DROP TABLE ILM_IRPMSPT_RUNINFO PURGE;
  
  CREATE TABLE ILM_IRPMSPT_RUNINFO
  ( 
     RUN_NAME                           VARCHAR2(256) NOT NULL   -- RUN_NAME (JOB_CODE(실행구분코드<=15Bytes) + _YYYYMMDDHH24MISS)
    ,RUN_SOURCE                         VARCHAR2(100) NOT NULL   -- SQL 수집 Source (STS, AWR)
    ,DESCRIPTION                        VARCHAR2(2000)           -- JOB Description
    ,RUN_PROCESS                        NUMBER                   -- Run Parallel Process
    ,RUN_START_DATE                     DATE                     -- Job STart Date 
    ,RUN_END_DATE                       DATE                     -- Job End Date
    ,RUN_SQL_TIMEOUT                    NUMBER(10) DEFAULT 0     -- SQL Timeout (0:No limit, >0 :Sec)
    ,RUN_REMAP_STRING                   CLOB                     -- REMAP String (EMP:EMP_$T,DEPT:SCOTT.DEPT_$T,...)
    ,RUN_REPLACE_SYSDATE                VARCHAR2(14)             -- YYYYMMDDHH24MISS FORMAT (14BYTE)
    ,RUN_NLS_DATE_FORMAT                VARCHAR2(100)            -- ALTER SESSION SET NLS_DATE_FORMAT ==> YYYY-MM-DD HH24:MI:SS 
    ,RUN_PRE_SQL                        CLOB                     -- Pre RUn SQL List (semicolon seperator)
    ,RUN_POST_SQL                       CLOB                     -- Post SQL         (semicolon seperator)  
    -- 실행통계 부문 -----------------------------------------------
    ,TOT_CNT                            NUMBER                   -- Total SQL Cnt for JOB_NAME 
    ,PROC_FINISH                        NUMBER                   -- Finished (T,E,Y,S) 
    ,PROC_REST                          NUMBER                   -- P + N (Processing + Not yet) 
    ,PROC_PCT                           NUMBER                   -- Process Percent (Y+T+E+S)/(Y+T+E+P+N+S) 
    ,PROC_P                             NUMBER                   -- Processing
    ,PROC_N                             NUMBER                   -- Not Yet     
    ,PROC_T                             NUMBER                   -- Finished, But Timeout    
    ,PROC_E                             NUMBER                   -- Finished, But Error 
    ,PROC_S                             NUMBER                   -- Finished, PLAN COMPARE, and Not Runned (RUN Skipped)
    ,PROC_Y                             NUMBER                   -- Finisied, OK
    -- PLAN Compare기능 부문 --------------------------------------
    ,PLAN_COMPARE_YN                    CHAR(1) DEFAULT 'N'      -- PLAN Compare Pre Run Y/N   
    ,PLAN_COMPARE_CHK_RUN_YN            CHAR(1) DEFAULT 'Y'      -- PLAN Compare,If Plan Diff then RUN. 'N' - Only Plan Check   
    -- SQL및 BIND변수 Replace 부문 --------------------------------
    ,USE_SQL_REPLACE                    CHAR(1) DEFAULT 'N'      -- SQL Replace Y/N 
    ,USE_BIND_REPLACE                   CHAR(1) DEFAULT 'N'      -- BIND Value Replace Y/N 
    -- Load Tester 부문 -----------------------------------------
    ,LOAD_REG_DATE                      DATE    DEFAULT SYSDATE  -- LOAD Job Registered Date
    ,LOAD_TEST_YN                       CHAR(1) DEFAULT 'N'      -- LOAD TEST Y/N (N-SPT, Y-Load Tester)
    ,LOAD_PROC_TYPE                     CHAR(1) DEFAULT 'C'      -- C(sql_id에 한시점에 여러 Process들이 동시 실행가능, Timeout가능 사용불가),O(sql_id에 한 시점에 한개의 Process만 실행가능, Timeout기능 가능)   
    ,LOAD_PROC_STATUS                   CHAR(1) DEFAULT 'N'      -- LOAD TEST Ready/PROCESS/STOP Sign (N --> P --> Y) 
    ,LOAD_PROC_THINKTIME                NUMBER                   -- 부하발생시 Thinktime (Sleeptime between SQLs) 1/100초 단위 (0.01 ~ ) 단위 초 
    ,LOAD_PROC_STARTTIME                DATE                     -- 부하발생기 STARTTIME (예약기능)
    ,LOAD_PROC_ENDTIME                  DATE                     -- 부하발생기 ENDTIME (종료예약기능 Duration : STARTTIME ~ ENDTIME)
    ,LOAD_PROC_COMMIT_YN                CHAR(1) DEFAULT 'N'      -- 부하발생기 COMMIT여부 (DEFAULT ROLLBACK처리) N-Rollback, Y-Commit
    -- SQL Query Result 부문 -----------------------------------
    ,USE_QUERY_RESULT_CHK               CHAR(1) DEFAULT 'N'      -- SQL Query Result Check Y/N (Wrong Result, Result Order)      
    ,USE_QUERY_RESULT_LOGGING           CHAR(1) DEFAULT 'N'      -- SQL Query Result SQL Logging  
    ,USE_QUERY_RESULT_ROWLIMIT          NUMBER  DEFAULT 0        -- SQL Query Result Return Row Check Limit (0-All Rows, n-First n Rows)
    -- SQL COMMENT Usage in SPT SQL ---------------------------
    ,USE_SQL_COMMENT                    CHAR(1) DEFAULT 'Y'      -- SQL COMMENT Usage in SPT SQL, Attach Comment in Oraginal SQL 
    -- Select Query Prefetch Count  ---------------------------
    ,PREFETCH_COUNT                     NUMBER  DEFAULT -1       -- Select Query Prefetch Count, PREFETCH_COUNT = -1 (1 ROW FETCH) , FETCH_COUNT = 0 (계산된 FETCH) , FETCH_COUNT > 0  : (FIXED FETCH)
  )
  PCTFREE 10  INITRANS 1  MAXTRANS 255
  TABLESPACE @@TABLESPACE@@;


  CREATE UNIQUE INDEX ILM_IRPMSPT_RUNINFO_PK ON ILM_IRPMSPT_RUNINFO ( RUN_NAME, RUN_SOURCE )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;
  
  COMMENT ON TABLE  ILM_IRPMSPT_RUNINFO                           IS 'iRPM SPT 실행 Summary Main Info 테이블';
  
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_NAME                  IS 'RUN_NAME (JOB_CODE(실행구분코드<=15Bytes) + _YYYYMMDDHH24MISS)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_SOURCE                IS 'SQL 수집 Source (STS, AWR)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.DESCRIPTION               IS 'JOB Description';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_PROCESS               IS 'Run Parallel Process';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_START_DATE            IS 'Job STart Date'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_END_DATE              IS 'Job End Date';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_SQL_TIMEOUT           IS 'SQL Timeout (0:No limit, >0 :Sec)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_REMAP_STRING          IS 'REMAP String (EMP:EMP_$T,DEPT:SCOTT.DEPT_$T,...)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_REPLACE_SYSDATE       IS 'YYYYMMDDHH24MISS FORMAT (14BYTE)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_NLS_DATE_FORMAT       IS 'ALTER SESSION SET NLS_DATE_FORMAT ==> YYYY-MM-DD HH24:MI:SS'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_PRE_SQL               IS 'Pre RUn SQL List (semicolon seperator)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.RUN_POST_SQL              IS 'Post SQL         (semicolon seperator)';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.TOT_CNT                   IS 'Total SQL Cnt for JOB_NAME'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_FINISH               IS 'Finished (T,E,Y,S)'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_REST                 IS 'P + N (Processing + Not yet)'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_PCT                  IS 'Process Percent (Y+T+E+S)/(Y+T+E+P+N+S)'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_P                    IS 'Processing';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_N                    IS 'Not Yet';     
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_T                    IS 'Finished, But Timeout';    
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_E                    IS 'Finished, But Error'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_S                    IS 'Finished, PLAN COMPARE, and Not Runned (RUN Skipped)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PROC_Y                    IS 'Finisied, OK';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PLAN_COMPARE_YN           IS 'PLAN Compare Pre Run Y/N';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PLAN_COMPARE_CHK_RUN_YN   IS 'PLAN Compare,If Plan Diff then RUN. N - Only Plan Check';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.USE_SQL_REPLACE           IS 'SQL Replace Y/N';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.USE_BIND_REPLACE          IS 'BIND Value Replace Y/N';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_REG_DATE             IS 'LOAD Job Registered Date'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_TEST_YN              IS 'LOAD TEST Y/N (N-SPT, Y-Load Tester)';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_PROC_TYPE            IS 'C(sql_id에 한시점에 여러 Process들이 동시 실행가능, Timeout가능 사용불가),O(sql_id에 한 시점에 한개의 Process만 실행가능, Timeout기능 가능)';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_PROC_STATUS          IS 'LOAD TEST Ready/PROCESS/STOP Sign (N --> P --> Y)';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_PROC_THINKTIME       IS '부하발생시 Thinktime (Sleeptime between SQLs) 1/100초 단위 (0.01 ~ ) 단위 초';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_PROC_STARTTIME       IS '부하발생기 STARTTIME (예약기능)';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_PROC_ENDTIME         IS '부하발생기 ENDTIME (종료예약기능 Duration : STARTTIME ~ ENDTIME)';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.LOAD_PROC_COMMIT_YN       IS '부하발생기 COMMIT여부 (DEFAULT ROLLBACK처리) N-Rollback, Y-Commit';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.USE_QUERY_RESULT_CHK      IS 'Query Result Check Y/N';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.USE_QUERY_RESULT_LOGGING  IS 'SQL Query Result SQL Logging';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.USE_QUERY_RESULT_ROWLIMIT IS 'SQL Query Result Return Row Check Limit (0-All Rows, n-First n Rows)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.USE_SQL_COMMENT           IS 'SQL COMMENT Usage in SPT SQL - Attach Comment in Oraginal SQL';
  COMMENT ON COLUMN ILM_IRPMSPT_RUNINFO.PREFETCH_COUNT            IS 'Select Query Prefetch Count, PREFETCH_COUNT = -1 (1 ROW FETCH) , FETCH_COUNT = 0 (계산된 FETCH) , FETCH_COUNT > 0  : (FIXED FETCH)';
  
  
-- ==================================================================================================================
-- iRPM SPT - SQL ID별 실행정보 저장 Table
--            IRPM SPT엔진으로 SQL Play실행시 SQL_ID별 처리정보 저장
-- ==================================================================================================================  
--  DROP TABLE ILM_IRPMSPT_RUN PURGE;
  
  CREATE TABLE ILM_IRPMSPT_RUN
  (
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- SPT 실행의 KEY 및 실행 Process정보, 처리시간, 처리 Flag등 실행을 위한 기본 정보
    -- ---------------------------------------------------------------------------------------------------------------------------------------  
     RUN_NAME                       VARCHAR2(256 BYTE)           -- RUN_NAME (JOB_CODE(실행구분코드<=15Bytes) + _YYYYMMDDHH24MISS)  
    ,RUN_SOURCE                     VARCHAR2(100 BYTE)           -- SQL 수집 Source (STS, AWR)       
    ,RUN_PROC_ID                    VARCHAR2(100 BYTE)           -- RUN Process정보 (INST_ID,SID,OSPID)로 ','로 구분되어 실행시 저장       
    ,RUN_PROC_SEQ                   NUMBER                       -- RUN Process마다 처리한 순서, 1 ~ n       
    ,RUN_DATE                       DATE                         -- RUN Process가 해당 SQL을 실해시 Start일자 기록       
    ,RUN_ORDER                      NUMBER                       -- 전체 RUN_NAME에 해당 하는 SQL들의 실행 순서 지정. (단위 처리시간이 빠른 것 부터 1 ~ n)       
    ,RUN_TOTALCNT                   NUMBER                       -- 전체 RUN_NAME에 해당 하는 SQL전체 수        
    ,RUN_PROC_YN                    CHAR(1 BYTE)                 -- RUN Process 처리 Flag, 처음은 'N' ('N' --> 'P' --> 'Y'(정상완료), 'T'(Timeout), 'E'(Error) , 'S'(Skipped)      
    ,SQL_ID                         VARCHAR2(13 BYTE)            -- 분석 대상의 SQL_ID  
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- 수집대상의 Key 및 위치정보(ROWID)
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    ,CHILD_NUMBER                   VARCHAR2(13 BYTE)            -- 분석 대상의 SQL의 CHILD_NUMBER
    ,ID                             NUMBER                       -- STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 KEY - ID컬럼       
    ,NAME                           VARCHAR2(128 BYTE)           -- STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 KEY - NAME컬럼       
    ,OWNER                          VARCHAR2(128 BYTE)           -- STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 KEY - OWNER컬럼        
    ,STS_ROWID                      ROWID                        -- STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 수집된 SQL정보가 있는 Table의 ROWID                
    ,MIN_SNAP_ID                    NUMBER                       -- AWR Only : AWR Repository의 수집대상의 Start Snap ID (dba_hist_snapshot)
    ,MAX_SNAP_ID                    NUMBER                       -- AWR Only : AWR Repository의 수집대상의 End Snap ID (dba_hist_snapshot)        
    ,DBID                           NUMBER                       -- AWR Only : AWR Repository의 수집대상의 DBID (dba_hist_snapshot)       
    ,INSTANCE_NUMBER                NUMBER                       -- AWR Only : AWR Repository의 수집대상의 INSTANCE_NUMBER (dba_hist_snapshot)    
    ,AWR_PLAN_HASH_VALUE            NUMBER                       -- AWR Only : AWR Repository의 수집대상SQL의 PLAN_HASH_VALUE (dba_hist_sql_plan)
    ,AWR_ROWID                      ROWID                        -- AWR Only : AWR Repository의 수집대상SQL의 SQL TEXT의 ROWID (dba_hist_sqltext) 
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- SPT 실행 성능정보
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    ,ELAPSED_TIME                   NUMBER                       -- V$SQL.ELAPSED_TIME       
    ,CPU_TIME                       NUMBER                       -- V$SQL.CPU_TIME       
    ,APPLICATION_WAIT_TIME          NUMBER                       -- V$SQL.APPLICATION_WAIT_TIME       
    ,CONCURRENCY_WAIT_TIME          NUMBER                       -- V$SQL.CONCURRENCY_WAIT_TIME       
    ,CLUSTER_WAIT_TIME              NUMBER                       -- V$SQL.CLUSTER_WAIT_TIME       
    ,USER_IO_WAIT_TIME              NUMBER                       -- V$SQL.USER_IO_WAIT_TIME       
    ,PLSQL_EXEC_TIME                NUMBER                       -- V$SQL.PLSQL_EXEC_TIME       
    ,JAVA_EXEC_TIME                 NUMBER                       -- V$SQL.JAVA_EXEC_TIME       
    ,BUFFER_GETS                    NUMBER                       -- V$SQL.BUFFER_GETS       
    ,DISK_READS                     NUMBER                       -- V$SQL.DISK_READS       
    ,DIRECT_WRITES                  NUMBER                       -- V$SQL.DIRECT_WRITES       
    ,ROWS_PROCESSED                 NUMBER                       -- V$SQL.ROWS_PROCESSED       
    ,FETCHES                        NUMBER                       -- V$SQL.FETCHES       
    ,EXECUTIONS                     NUMBER                       -- V$SQL.EXECUTIONS       
    ,OPTIMIZER_COST                 NUMBER                       -- V$SQL.OPTIMIZER_COST       
    ,OPTIMIZER_ENV                  RAW(2000)                    -- V$SQL.OPTIMIZER_ENV       
    ,COMMAND_TYPE                   NUMBER                       -- V$SQL.COMMAND_TYPE       
    ,FIRST_LOAD_TIME                VARCHAR2(19 BYTE)            -- V$SQL.FIRST_LOAD_TIME       
    ,PLAN_HASH_VALUE                NUMBER                       -- V$SQL.PLAN_HASH_VALUE       
    ,OPTIMIZER_MODE                 VARCHAR2(10 BYTE)            -- V$SQL.OPTIMIZER_MODE       
    ,PX_SERVERS_EXECUTIONS          NUMBER                       -- V$SQL.PX_SERVERS_EXECUTIONS       
    ,SQL_PROFILE                    VARCHAR2(256)                -- V$SQL.SQL_PROFILE    
    ,SQL_PATCH                      VARCHAR2(256)                -- V$SQL.SQL_PATCH   
    ,SQL_PLAN_BASELINE              VARCHAR2(256)                -- V$SQL.SQL_PLAN_BASELINE      
    ,PLAN_RUNTIME                   CLOB                         -- Runtime Explain Plan (STATSITICS_LEVEL=ALL)으로 Plan Step별 성능정보 포함  
    ,PLAN_RUNTIME_COMP              CLOB                         -- EXPLAIN PLAN의 TEXT형태 비교를 위한 String
    ,PLAN_RUNTIME_COMP_HASH         VARCHAR2(1000)               -- PLAN String HASH Value (for PLAN String Compare)
    ,SPT_SQL_ID                     VARCHAR2(13 BYTE)            -- 실제 실행했던 SQL_ID (Origin SQL에 Comment가 붙어서 실행하므로 고유 SQL_ID와 다음), V$SQL.SQL_ID  
    ,SPT_PLAN_HASH_VALUE            NUMBER                       -- 실제 실행했던 PLAN_HASH_VALUE V$SQL.PLAN_HASH_VALUE  
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- SPT Exatra Performance Info (SQL Statistics Info)
    -- ---------------------------------------------------------------------------------------------------------------------------------------  
    ,SQL_BUFFER_GETS                NUMBER                       -- V$SQL_PLAN_STATISTICS_ALL.CR_BUFFER_GETS + CU_BUFFER_GETS       
    ,SQL_CR_BUFFER_GETS             NUMBER                       -- V$SQL_PLAN_STATISTICS_ALL.CR_BUFFER_GETS    
    ,SQL_CU_BUFFER_GETS             NUMBER                       -- V$SQL_PLAN_STATISTICS_ALL.CU_BUFFER_GETS   
    ,SQL_DISK_READS                 NUMBER                       -- V$SQL_PLAN_STATISTICS_ALL.DISK_READS       
    ,SQL_DISK_WRITES                NUMBER                       -- V$SQL_PLAN_STATISTICS_ALL.DISK_WRITES  
    ,SQL_ELAPSED_TIME               NUMBER                       -- V$SQL_PLAN_STATISTICS_ALL.ELAPSED_TIME     
    ,SQL_OUTPUT_ROWS                NUMBER                       -- V$SQL_PLAN_STATISTICS_ALL.OUTPUT_ROWS    
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- SQL PLAN Compare 정보 : PLAN만을 검증, 기존의 PLAN과 다른 경우만 SPT 실행 목정
    -- ---------------------------------------------------------------------------------------------------------------------------------------    
    ,COMP_EQUAL_FLAG                CHAR(1)                      -- PLAN Compare Only : Original SQL과 PLAN_HASH_VALUE가 같으면 'Y', 아니면 'N','E' - Explain Plan Error  
    ,COMP_EXPLAIN_PLAN              CLOB                         -- PLAN Compare Only : EXPLAIN PLAN 정보
    ,COMP_PLAN_HASH_VALUE           NUMBER                       -- PLAN Compare Only : PLAN_HASH_VALIE   
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- Load Tester 정보 : PLAN만을 검증, Load Test의 실행정보
    -- --------------------------------------------------------------------------------------------------------------------------------------- 
    ,LOAD_Y_CNT                     NUMBER  DEFAULT 0            -- 정상처리   
    ,LOAD_T_CNT                     NUMBER  DEFAULT 0            -- Timeout    
    ,LOAD_E_CNT                     NUMBER  DEFAULT 0            -- Error 
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- Query Result HASH
    -- --------------------------------------------------------------------------------------------------------------------------------------- 
    ,QUERY_RESULT_SHA1              RAW(512)   
    -- ---------------------------------------------------------------------------------------------------------------------------------------
    -- SPT실행 Runtime Error
    -- ---------------------------------------------------------------------------------------------------------------------------------------       
    ,EXEC_ERROR                     VARCHAR2(2000 BYTE)          -- EXEC Error 또는 EXPLAIN PLAN Error             
  )
  PCTFREE 10  INITRANS 7  MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;
  
  CREATE INDEX ILM_IRPMSPT_RUN_IDX1 ON ILM_IRPMSPT_RUN ( SQL_ID , NAME , OWNER, ID )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;
  
  CREATE INDEX ILM_IRPMSPT_RUN_IDX2 ON ILM_IRPMSPT_RUN ( MAX_SNAP_ID , DBID , INSTANCE_NUMBER, AWR_PLAN_HASH_VALUE )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;

  CREATE INDEX ILM_IRPMSPT_RUN_IDX3 ON ILM_IRPMSPT_RUN ( RUN_NAME, RUN_SOURCE, RUN_PROC_YN , RUN_ORDER )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;
  
  COMMENT ON TABLE ILM_IRPMSPT_RUN                                 IS 'iRPM SPT - SQL ID별 실행정보 저장 Table';
  
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_NAME                       IS 'RUN_NAME (JOB_CODE(실행구분코드<=15Bytes) + _YYYYMMDDHH24MISS)';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_SOURCE                     IS 'SQL 수집 Source (STS, AWR)';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_PROC_ID                    IS 'RUN Process정보 (INST_ID,SID,OSPID)로 ,(콤마)로 구분되어 실행시 저장 ';      
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_PROC_SEQ                   IS 'RUN Process마다 처리한 순서, 1 ~ n';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_DATE                       IS 'RUN Process가 해당 SQL을 실해시 Start일자 기록';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_ORDER                      IS '전체 RUN_NAME에 해당 하는 SQL들의 실행 순서 지정. (단위 처리시간이 빠른 것 부터 1 ~ n)';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_TOTALCNT                   IS '전체 RUN_NAME에 해당 하는 SQL전체 수';        
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.RUN_PROC_YN                    IS 'RUN Process 처리 Flag, 처음은 N (N->P->Y(정상완료),T(Timeout),E(Error),S(Skipped)';      
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.SQL_ID                         IS '분석 대상의 SQL_ID'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.CHILD_NUMBER                   IS '분석 대상의 SQL의 CHILD_NUMBER';
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.ID                             IS 'STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 KEY - ID컬럼';      
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.NAME                           IS 'STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 KEY - NAME컬럼';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.OWNER                          IS 'STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 KEY - OWNER컬럼';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.STS_ROWID                      IS 'STS Only : STS(SQL Tuning Set)의 SQL Staging Table의 수집된 SQL정보가 있는 Table의 ROWID';                
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.MIN_SNAP_ID                    IS 'AWR Only : AWR Repository의 수집대상의 Start Snap ID (dba_hist_snapshot)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.MAX_SNAP_ID                    IS 'AWR Only : AWR Repository의 수집대상의 End Snap ID (dba_hist_snapshot)';        
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.DBID                           IS 'AWR Only : AWR Repository의 수집대상의 DBID (dba_hist_snapshot)';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.INSTANCE_NUMBER                IS 'AWR Only : AWR Repository의 수집대상의 INSTANCE_NUMBER (dba_hist_snapshot)';    
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.AWR_PLAN_HASH_VALUE            IS 'AWR Only : AWR Repository의 수집대상SQL의 PLAN_HASH_VALUE (dba_hist_sql_plan)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.AWR_ROWID                      IS 'AWR Only : AWR Repository의 수집대상SQL의 SQL TEXT의 ROWID (dba_hist_sqltext)'; 
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.ELAPSED_TIME                   IS 'V$SQL.ELAPSED_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.CPU_TIME                       IS 'V$SQL.CPU_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.APPLICATION_WAIT_TIME          IS 'V$SQL.APPLICATION_WAIT_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.CONCURRENCY_WAIT_TIME          IS 'V$SQL.CONCURRENCY_WAIT_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.CLUSTER_WAIT_TIME              IS 'V$SQL.CLUSTER_WAIT_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.USER_IO_WAIT_TIME              IS 'V$SQL.USER_IO_WAIT_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.PLSQL_EXEC_TIME                IS 'V$SQL.PLSQL_EXEC_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.JAVA_EXEC_TIME                 IS 'V$SQL.JAVA_EXEC_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.BUFFER_GETS                    IS 'V$SQL.BUFFER_GETS';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.DISK_READS                     IS 'V$SQL.DISK_READS';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.DIRECT_WRITES                  IS 'V$SQL.DIRECT_WRITES';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.ROWS_PROCESSED                 IS 'V$SQL.ROWS_PROCESSED';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.FETCHES                        IS 'V$SQL.FETCHES';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.EXECUTIONS                     IS 'V$SQL.EXECUTIONS';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.OPTIMIZER_COST                 IS 'V$SQL.OPTIMIZER_COST';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.OPTIMIZER_ENV                  IS 'V$SQL.OPTIMIZER_ENV';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.COMMAND_TYPE                   IS 'V$SQL.COMMAND_TYPE';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.FIRST_LOAD_TIME                IS 'V$SQL.FIRST_LOAD_TIME';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.PLAN_HASH_VALUE                IS 'V$SQL.PLAN_HASH_VALUE';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.OPTIMIZER_MODE                 IS 'V$SQL.OPTIMIZER_MODE';       
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.PX_SERVERS_EXECUTIONS          IS 'V$SQL.PX_SERVERS_EXECUTIONS';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.SQL_PROFILE                    IS 'V$SQL.SQL_PROFILE';    
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.SQL_PATCH                      IS 'V$SQL.SQL_PATCH';    
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.SQL_PLAN_BASELINE              IS 'V$SQL.SQL_PLAN_BASELINE';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.PLAN_RUNTIME                   IS 'Runtime Explain Plan (STATSITICS_LEVEL=ALL)으로 Plan Step별 성능정보 포함';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.PLAN_RUNTIME_COMP              IS 'EXPLAIN PLAN의 TEXT형태 비교를 위한 String';
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.PLAN_RUNTIME_COMP_HASH         IS 'PLAN String HASH Value (for PLAN String Compare)';
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.SPT_SQL_ID                     IS '실제 실행했던 SQL_ID (Origin SQL에 Comment가 붙어서 실행하므로 고유 SQL_ID와 다음), V$SQL.SQL_ID';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.SPT_PLAN_HASH_VALUE            IS '실제 실행했던 PLAN_HASH_VALUE V$SQL.PLAN_HASH_VALUE';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.COMP_EQUAL_FLAG                IS 'PLAN Compare Only : Original SQL과 PLAN_HASH_VALUE가 같으면 Y, 아니면 N,E-Explain Plan Error';  
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.COMP_EXPLAIN_PLAN              IS 'PLAN Compare Only : EXPLAIN PLAN 정보';
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.COMP_PLAN_HASH_VALUE           IS 'PLAN Compare Only : PLAN_HASH_VALIE';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.LOAD_Y_CNT                     IS 'Load Test 정상처리 Count';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.LOAD_T_CNT                     IS 'Load Test Timeout Count';   
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.LOAD_E_CNT                     IS 'Load Test Error Count';     
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.QUERY_RESULT_SHA1              IS 'Query Result SHA1 Value';     
  COMMENT ON COLUMN ILM_IRPMSPT_RUN.EXEC_ERROR                     IS 'EXEC Error 또는 EXPLAIN PLAN Error';   
  
-- ==================================================================================================================
-- iRPM SPT - IRPM_SPT Package내에서 진행 LOG 및 ERROR LOG Table
-- ==================================================================================================================    
  DROP TABLE ILM_IRPMSPT_LOG_WORK PURGE;
  
  CREATE TABLE ILM_IRPMSPT_LOG_WORK
  (
     LOGTIME                            TIMESTAMP
    ,LOGITEM                            VARCHAR2(4000 BYTE)                 
  )
  PCTFREE 10  INITRANS 1  MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;


-- ==================================================================================================================
-- iRPM SPT - SQL수집 및 저장용도 사용
--         > 해당 Table은 STS(SQL Tuning Set)의 사용자 Table인 User Staging Table 구조와 같은 형태로 구성 
--         > DBMS_SQLTUNE.UNPACK으로 DBA_SQLSET으로 Loading할 수 있는 형태로 최대한 맞춘 것임
--         > 차이점
--           1) 불필요한 정보 및 수집과정의 성능에 영향을 주는 부분은 수집 안함. (예. SQL_SEQ)
--           2) CHILD_NUMBER 컬럼 추가.-- FOR Standard Edition에서는 추가필요 (해당 컬럼 없으면, MERGE문 조인 시 정합성 맞지 않음)
--           3) CON_DBID, LAST_EXEC_START_TIME - 12C R2 이상의 경우 추가할 수 있음
--           4) DBMS_SQLTUNE으로 수집한 경우 호환을 위해서 CHILD_NUMBER컬럼 ADD 필요
--           SQL> ALTER TABLE ILM_IRPMSPT_SQLSET_STAGE ADD (CHILD_NUMBER NUMBER DEFAULT 0);
--         > 12c R2환경으로 DBMS_SQLTUNE.UNPACK으로 DBA_SQLSET으로 Loading할 경우 CON_DBID, LAST_EXEC_START_TIME 컬럼 추가 후 적용      
-- ================================================================================================================== 
-- DROP TABLE ILM_IRPMSPT_SQLSET_STAGE PURGE;

  CREATE TABLE ILM_IRPMSPT_SQLSET_STAGE
  (
     ID                                 NUMBER                              
    ,NAME                               VARCHAR2(128 BYTE)                  
    ,OWNER                              VARCHAR2(128 BYTE)                  
    ,DESCRIPTION                        VARCHAR2(256 BYTE)                  
    ,SQL_ID                             VARCHAR2(13 BYTE)                   
    ,CHILD_NUMBER                       NUMBER              /* 해당 컬럼 없으면, MERGE문 조인 시 정합성 맞지 않음 */
    ,SQL_SEQ                            NUMBER                              
    ,FORCE_MATCHING_SIGNATURE           NUMBER                               
    --,CON_DBID                           NUMBER            /* 12C R2이상   */                         
    ,SQL_TEXT                           CLOB                                
    ,PARSING_SCHEMA_NAME                VARCHAR2(128 BYTE)                  
    ,BIND_DATA                          RAW(2000)                           
    ,BINDS_CAPTURED                     CHAR(1 BYTE)                        
    ,BIND_POSITION                      NUMBER                              
    ,BIND_VALUE                         ANYDATA                             
    ,MODULE                             VARCHAR2(64 BYTE)                   
    ,ACTION                             VARCHAR2(64 BYTE)                   
    ,ELAPSED_TIME                       NUMBER                              
    ,CPU_TIME                           NUMBER                              
    ,BUFFER_GETS                        NUMBER                              
    ,DISK_READS                         NUMBER                              
    ,DIRECT_WRITES                      NUMBER                              
    ,ROWS_PROCESSED                     NUMBER                              
    ,FETCHES                            NUMBER                              
    ,EXECUTIONS                         NUMBER                              
    ,END_OF_FETCH_COUNT                 NUMBER                              
    ,OPTIMIZER_COST                     NUMBER                              
    ,OPTIMIZER_ENV                      RAW(2000)                           
    ,PRIORITY                           NUMBER                              
    ,COMMAND_TYPE                       NUMBER                              
    ,FIRST_LOAD_TIME                    VARCHAR2(19 BYTE)                   
    ,STAT_PERIOD                        NUMBER                              
    ,ACTIVE_STAT_PERIOD                 NUMBER                              
    ,OTHER                              CLOB                                
    --,LAST_EXEC_START_TIME               VARCHAR2(19 BYTE)  /* 12C R2이상   */                 
    ,PLAN_HASH_VALUE                    NUMBER                              
    ,PLAN_STATEMENT_ID                  VARCHAR2(128 BYTE)                  
    ,PLAN_PLAN_ID                       NUMBER                              
    ,PLAN_TIMESTAMP                     DATE                                
    ,PLAN_REMARKS                       VARCHAR2(4000 BYTE)                 
    ,PLAN_OPERATION                     VARCHAR2(128 BYTE)                  
    ,PLAN_OPTIONS                       VARCHAR2(255 BYTE)                  
    ,PLAN_OBJECT_NODE                   VARCHAR2(128 BYTE)                  
    ,PLAN_OBJECT_OWNER                  VARCHAR2(128 BYTE)                  
    ,PLAN_OBJECT_NAME                   VARCHAR2(128 BYTE)                  
    ,PLAN_OBJECT_ALIAS                  VARCHAR2(261 BYTE)                  
    ,PLAN_OBJECT_INSTANCE               NUMBER                              
    ,PLAN_OBJECT_TYPE                   VARCHAR2(128 BYTE)                  
    ,PLAN_OPTIMIZER                     VARCHAR2(255 BYTE)                  
    ,PLAN_SEARCH_COLUMNS                NUMBER                              
    ,PLAN_ID                            NUMBER                              
    ,PLAN_PARENT_ID                     NUMBER                              
    ,PLAN_DEPTH                         NUMBER                              
    ,PLAN_POSITION                      NUMBER                              
    ,PLAN_COST                          NUMBER                              
    ,PLAN_CARDINALITY                   NUMBER                              
    ,PLAN_BYTES                         NUMBER                              
    ,PLAN_OTHER_TAG                     VARCHAR2(255 BYTE)                  
    ,PLAN_PARTITION_START               VARCHAR2(255 BYTE)                  
    ,PLAN_PARTITION_STOP                VARCHAR2(255 BYTE)                  
    ,PLAN_PARTITION_ID                  NUMBER                              
    ,PLAN_DISTRIBUTION                  VARCHAR2(128 BYTE)                  
    ,PLAN_CPU_COST                      NUMBER                              
    ,PLAN_IO_COST                       NUMBER                              
    ,PLAN_TEMP_SPACE                    NUMBER                              
    ,PLAN_ACCESS_PREDICATES             VARCHAR2(4000 BYTE)                 
    ,PLAN_FILTER_PREDICATES             VARCHAR2(4000 BYTE)                 
    ,PLAN_PROJECTION                    VARCHAR2(4000 BYTE)                 
    ,PLAN_TIME                          NUMBER                              
    ,PLAN_QBLOCK_NAME                   VARCHAR2(128 BYTE)                  
    ,PLAN_OTHER_XML                     CLOB                                
    ,PLAN_EXECUTIONS                    NUMBER                              
    ,PLAN_STARTS                        NUMBER                              
    ,PLAN_OUTPUT_ROWS                   NUMBER                              
    ,PLAN_CR_BUFFER_GETS                NUMBER                              
    ,PLAN_CU_BUFFER_GETS                NUMBER                              
    ,PLAN_DISK_READS                    NUMBER                              
    ,PLAN_DISK_WRITES                   NUMBER                              
    ,PLAN_ELAPSED_TIME                  NUMBER                              
    ,PLAN_LAST_STARTS                   NUMBER                              
    ,PLAN_LAST_OUTPUT_ROWS              NUMBER                              
    ,PLAN_LAST_CR_BUFFER_GETS           NUMBER                              
    ,PLAN_LAST_CU_BUFFER_GETS           NUMBER                              
    ,PLAN_LAST_DISK_READS               NUMBER                              
    ,PLAN_LAST_DISK_WRITES              NUMBER                              
    ,PLAN_LAST_ELAPSED_TIME             NUMBER                              
    ,PLAN_POLICY                        VARCHAR2(10 BYTE)                   
    ,PLAN_ESTIMATED_OPTIMAL_SIZE        NUMBER                              
    ,PLAN_ESTIMATED_ONEPASS_SIZE        NUMBER                              
    ,PLAN_LAST_MEMORY_USED              NUMBER                              
    ,PLAN_LAST_EXECUTION                VARCHAR2(10 BYTE)                   
    ,PLAN_LAST_DEGREE                   NUMBER                              
    ,PLAN_TOTAL_EXECUTIONS              NUMBER                              
    ,PLAN_OPTIMAL_EXECUTIONS            NUMBER                              
    ,PLAN_ONEPASS_EXECUTIONS            NUMBER                              
    ,PLAN_MULTIPASSES_EXECUTIONS        NUMBER                              
    ,PLAN_ACTIVE_TIME                   NUMBER                              
    ,PLAN_MAX_TEMPSEG_SIZE              NUMBER                              
    ,PLAN_LAST_TEMPSEG_SIZE             NUMBER                              
    ,SPARE1                             NUMBER                              
    ,SPARE2                             NUMBER                              
    ,SPARE3                             BLOB                                
    ,SPARE4                             CLOB                                
    ,SPARE5                             NUMBER                              
    ,SPARE6                             NUMBER                              
    ,SPARE7                             CLOB                                
    ,SPARE8                             CLOB               
    ,SYSTEM_NAME                        VARCHAR2(100)        DEFAULT SYS_CONTEXT('USERENV','DB_NAME') NOT NULL
    ,SNAPTIME                           DATE                 DEFAULT TRUNC(SYSDATE) NOT NULL
  )
  PCTFREE 10  INITRANS 1  MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
--  LOB (SQL_TEXT)                    STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TABLESPACE@@)
--  LOB (OTHER)                       STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TABLESPACE@@)
--  LOB (PLAN_OTHER_XML)              STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TABLESPACE@@)
--  LOB (SPARE3)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TABLESPACE@@)
--  LOB (SPARE4)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TABLESPACE@@)
--  LOB (SPARE7)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TABLESPACE@@)
--  LOB (SPARE8)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TABLESPACE@@)
  ;
  
  
  CREATE INDEX ILM_IRPMSPT_SQLSET_STAGE_IDX1 ON ILM_IRPMSPT_SQLSET_STAGE ( SQL_ID , NAME , PLAN_HASH_VALUE  )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;
  
  CREATE INDEX ILM_IRPMSPT_SQLSET_STAGE_IDX2 ON ILM_IRPMSPT_SQLSET_STAGE ( SQL_ID , CHILD_NUMBER , PLAN_HASH_VALUE , PLAN_ID )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;  

  COMMENT ON  TABLE ILM_IRPMSPT_SQLSET_STAGE IS 'iRPM SPT분석 비교분석 결과 Table';



  -- ==================================================================================================================
  -- iRPM SPT - STS Staging Temporary Table for PLAN Fix : STAGING TABLE --> STS --> SQL BASELINE     
  --     DEFAULT로 12c이상 Version에 맞춰진 것임
  --     11g일 경우 2개 컬럼 COMMENT처리 
  -- ================================================================================================================== 
  DROP TABLE  ILM_IRPMSPT_SQLSET_STAGE_TEMP PURGE; 

  CREATE GLOBAL TEMPORARY TABLE ILM_IRPMSPT_SQLSET_STAGE_TEMP
  (
     ID                                 NUMBER               
    ,NAME                               VARCHAR2(30)         
    ,OWNER                              VARCHAR2(30)         
    ,DESCRIPTION                        VARCHAR2(256)        
    ,SQL_ID                             VARCHAR2(13)         
    ,SQL_SEQ                            NUMBER               
    ,FORCE_MATCHING_SIGNATURE           NUMBER               
    ,CON_DBID                           NUMBER            /* 12C R2이상 , 11g는 COMMENT처리 */    
    ,SQL_TEXT                           CLOB                 
    ,PARSING_SCHEMA_NAME                VARCHAR2(30)         
    ,BIND_DATA                          RAW(2000)            
    ,BINDS_CAPTURED                     CHAR(1)              
    ,BIND_POSITION                      NUMBER               
    ,BIND_VALUE                         ANYDATA              
    ,MODULE                             VARCHAR2(64)         
    ,ACTION                             VARCHAR2(64)         
    ,ELAPSED_TIME                       NUMBER               
    ,CPU_TIME                           NUMBER               
    ,BUFFER_GETS                        NUMBER               
    ,DISK_READS                         NUMBER               
    ,DIRECT_WRITES                      NUMBER               
    ,ROWS_PROCESSED                     NUMBER               
    ,FETCHES                            NUMBER               
    ,EXECUTIONS                         NUMBER               
    ,END_OF_FETCH_COUNT                 NUMBER               
    ,OPTIMIZER_COST                     NUMBER               
    ,OPTIMIZER_ENV                      RAW(2000)            
    ,PRIORITY                           NUMBER               
    ,COMMAND_TYPE                       NUMBER               
    ,FIRST_LOAD_TIME                    VARCHAR2(19)         
    ,STAT_PERIOD                        NUMBER               
    ,ACTIVE_STAT_PERIOD                 NUMBER               
    ,OTHER                              CLOB  
    ,LAST_EXEC_START_TIME               VARCHAR2(19 BYTE)  /* 12C R2이상 , 11g는 COMMENT처리 */ 
    ,PLAN_HASH_VALUE                    NUMBER               
    ,PLAN_STATEMENT_ID                  VARCHAR2(30)         
    ,PLAN_PLAN_ID                       NUMBER               
    ,PLAN_TIMESTAMP                     DATE                 
    ,PLAN_REMARKS                       VARCHAR2(4000)       
    ,PLAN_OPERATION                     VARCHAR2(30)         
    ,PLAN_OPTIONS                       VARCHAR2(255)        
    ,PLAN_OBJECT_NODE                   VARCHAR2(128)        
    ,PLAN_OBJECT_OWNER                  VARCHAR2(30)         
    ,PLAN_OBJECT_NAME                   VARCHAR2(30)         
    ,PLAN_OBJECT_ALIAS                  VARCHAR2(65)         
    ,PLAN_OBJECT_INSTANCE               NUMBER               
    ,PLAN_OBJECT_TYPE                   VARCHAR2(30)         
    ,PLAN_OPTIMIZER                     VARCHAR2(255)        
    ,PLAN_SEARCH_COLUMNS                NUMBER               
    ,PLAN_ID                            NUMBER               
    ,PLAN_PARENT_ID                     NUMBER               
    ,PLAN_DEPTH                         NUMBER               
    ,PLAN_POSITION                      NUMBER               
    ,PLAN_COST                          NUMBER               
    ,PLAN_CARDINALITY                   NUMBER               
    ,PLAN_BYTES                         NUMBER               
    ,PLAN_OTHER_TAG                     VARCHAR2(255)        
    ,PLAN_PARTITION_START               VARCHAR2(255)        
    ,PLAN_PARTITION_STOP                VARCHAR2(255)        
    ,PLAN_PARTITION_ID                  NUMBER               
    ,PLAN_DISTRIBUTION                  VARCHAR2(30)         
    ,PLAN_CPU_COST                      NUMBER               
    ,PLAN_IO_COST                       NUMBER               
    ,PLAN_TEMP_SPACE                    NUMBER               
    ,PLAN_ACCESS_PREDICATES             VARCHAR2(4000)       
    ,PLAN_FILTER_PREDICATES             VARCHAR2(4000)       
    ,PLAN_PROJECTION                    VARCHAR2(4000)       
    ,PLAN_TIME                          NUMBER               
    ,PLAN_QBLOCK_NAME                   VARCHAR2(30)         
    ,PLAN_OTHER_XML                     CLOB                 
    ,PLAN_EXECUTIONS                    NUMBER               
    ,PLAN_STARTS                        NUMBER               
    ,PLAN_OUTPUT_ROWS                   NUMBER               
    ,PLAN_CR_BUFFER_GETS                NUMBER               
    ,PLAN_CU_BUFFER_GETS                NUMBER               
    ,PLAN_DISK_READS                    NUMBER               
    ,PLAN_DISK_WRITES                   NUMBER               
    ,PLAN_ELAPSED_TIME                  NUMBER               
    ,PLAN_LAST_STARTS                   NUMBER               
    ,PLAN_LAST_OUTPUT_ROWS              NUMBER               
    ,PLAN_LAST_CR_BUFFER_GETS           NUMBER               
    ,PLAN_LAST_CU_BUFFER_GETS           NUMBER               
    ,PLAN_LAST_DISK_READS               NUMBER               
    ,PLAN_LAST_DISK_WRITES              NUMBER               
    ,PLAN_LAST_ELAPSED_TIME             NUMBER               
    ,PLAN_POLICY                        VARCHAR2(10)         
    ,PLAN_ESTIMATED_OPTIMAL_SIZE        NUMBER               
    ,PLAN_ESTIMATED_ONEPASS_SIZE        NUMBER               
    ,PLAN_LAST_MEMORY_USED              NUMBER               
    ,PLAN_LAST_EXECUTION                VARCHAR2(10)         
    ,PLAN_LAST_DEGREE                   NUMBER               
    ,PLAN_TOTAL_EXECUTIONS              NUMBER               
    ,PLAN_OPTIMAL_EXECUTIONS            NUMBER               
    ,PLAN_ONEPASS_EXECUTIONS            NUMBER               
    ,PLAN_MULTIPASSES_EXECUTIONS        NUMBER               
    ,PLAN_ACTIVE_TIME                   NUMBER               
    ,PLAN_MAX_TEMPSEG_SIZE              NUMBER               
    ,PLAN_LAST_TEMPSEG_SIZE             NUMBER               
    ,SPARE1                             NUMBER               
    ,SPARE2                             NUMBER               
    ,SPARE3                             BLOB                 
    ,SPARE4                             CLOB                 
    ,SPARE5                             NUMBER               
    ,SPARE6                             NUMBER               
    ,SPARE7                             CLOB                 
    ,SPARE8                             CLOB             
  )
  ON COMMIT PRESERVE ROWS ;
  

-- ==================================================================================================================
-- iRPM SPT - SQL수집 LOG Table
--            수집 Procedure (IRPM_SPT_SQLGATHER)에서 SQL수집 정보 LOGGING
-- ================================================================================================================== 
  DROP TABLE ILM_IRPMSPT_SQLSET_LOG PURGE;

  CREATE TABLE ILM_IRPMSPT_SQLSET_LOG
  (
     NODE              NUMBER
    ,OWNER             VARCHAR2(128 BYTE)
    ,TABLE_NAME        VARCHAR2(256 BYTE)
    ,SQLSET_NAME       VARCHAR2(256 BYTE)
    ,GATHER_DATE       DATE
    ,MERGE_ROW_CNT     NUMBER
    ,TOTAL_SQL_CNT     NUMBER
    ,ERROR_MESSAGE     VARCHAR2(4000 BYTE)
  ) 
  PCTFREE 10  INITRANS 1  MAXTRANS 255  
  TABLESPACE @@TABLESPACE@@;


-- ==================================================================================================================
-- iRPM SPT - SQL 튜닝 (HINT등으로 조정)된 SQL로 대체해서 실행
--            
-- ================================================================================================================== 
  DROP TABLE ILM_IRPMSPT_SQL_REPLACE PURGE;

  CREATE TABLE ILM_IRPMSPT_SQL_REPLACE
  ( 
     SQL_ID                         VARCHAR2(13 BYTE) NOT NULL 
    ,USE_YN                         VARCHAR2(1 BYTE) DEFAULT 'Y'  
    ,DESCRIPTION                    VARCHAR2(1000) 
    ,REPLACE_SQL                    CLOB     
  ) 
  PCTFREE 10  INITRANS 1  MAXTRANS 255  
  TABLESPACE @@TABLESPACE@@;
  
  CREATE UNIQUE INDEX ILM_IRPMSPT_SQL_REPLACE_IDX1 ON ILM_IRPMSPT_SQL_REPLACE ( SQL_ID )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;
  
  
-- ==================================================================================================================
-- iRPM SPT - BIND변수 Replace 
--            INSERT의 Value절의 BIND값, UPDATE의 SET절의 BInd값, SELECT List의 BIND값 등은 BInd변수가 Capture되지 않음
--            이에 BIND변수를 임의의 값으로 대체해서 지정하여 실행할 경우 지정
--       > BIND_NAME_LIST  : BIND변수 NAME을 |문자열을 구별자로 나열
--       > BIND_VALUE_LIST : BIND변수 NAME순으로 |문자열을 구별자로 나열
--
--       > LOAD TEST일 경우 BIND변수 적용방법 및 정보  
-- ================================================================================================================== 
  DROP TABLE ILM_IRPMSPT_BIND_INFO PURGE;

  CREATE TABLE ILM_IRPMSPT_BIND_INFO
  ( 
     SQL_ID                         VARCHAR2(13 BYTE) NOT NULL 
    ,USE_YN                         VARCHAR2(1 BYTE) DEFAULT 'Y'  
    ,DESCRIPTION                    VARCHAR2(1000 BYTE) 
    ,BIND_NAME_LIST                 VARCHAR2(4000 BYTE) 
    ,BIND_VALUE_LIST                VARCHAR2(4000 BYTE) 
    -- LOAD TEST의 경우사용 ---------------------------------------
    ,LOAD_PROC_TYPE                 CHAR(1 BYTE) DEFAULT 'N' -- (S,R,N) S:SEQUENCE 1~MAX~1~, R:RANDOM SEQ (MIN ~ MAX), N:Not Used 
    ,LOAD_PROC_MIN                  NUMBER                   -- ILM_IRPMSPT_BIND_LIST의 MIN SEQ
    ,LOAD_PROC_MAX                  NUMBER                   -- ILM_IRPMSPT_BIND_LIST의 MAX SEQ    
    ,LOAD_PROC_CURR                 NUMBER                   -- LOAD_PROC_TYPE=S일 경우 현재의 SEQ 
  ) 
  PCTFREE 10  INITRANS 10  MAXTRANS 255  
  TABLESPACE @@TABLESPACE@@
  --PARTITION BY HASH(SQL_ID) PARTITIONS 32
  ;
  
  CREATE UNIQUE INDEX ILM_IRPMSPT_BIND_INFO_IDX1 ON ILM_IRPMSPT_BIND_INFO ( SQL_ID )
  PCTFREE 10 INITRANS 10 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  --LOCAL
  ;
    
    
-- ==================================================================================================================
-- iRPM SPT - Load Test의 경우 BIND변수 List 
--       > BIND_VALUE_LIST : BIND변수 NAME순으로 |문자열을 구별자로 나열
-- ==================================================================================================================    
  DROP TABLE ILM_IRPMSPT_BIND_LIST PURGE;

  CREATE TABLE ILM_IRPMSPT_BIND_LIST
  ( 
     SQL_ID                         VARCHAR2(13 BYTE) NOT NULL 
    ,SEQ                            NUMBER  
    ,BIND_VALUE_LIST                VARCHAR2(4000 BYTE) 
  ) 
  PCTFREE 10  INITRANS 1  MAXTRANS 255  
  TABLESPACE @@TABLESPACE@@
  --PARTITION BY HASH(SQL_ID) PARTITIONS 32
  ;
  
  CREATE UNIQUE INDEX ILM_IRPMSPT_BIND_LIST_IDX1 ON ILM_IRPMSPT_BIND_LIST ( SQL_ID , SEQ)
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  --LOCAL
  ;
        
  
-- ==================================================================================================================
-- iRPM SPT - REMOTE SQL Gather
--            
-- ==================================================================================================================   
 CREATE GLOBAL TEMPORARY TABLE V_SQL_VIEW
 (
     NAME                      VARCHAR2(128 BYTE)
    ,SNAPTIME                  DATE
    ,SQL_ID		               VARCHAR2(13 BYTE)
    ,CHILD_NUMBER		       NUMBER
    ,FORCE_MATCHING_SIGNATURE  NUMBER
    ,SQL_TEXT		           CLOB
    ,PARSING_SCHEMA_NAME	   VARCHAR2(128 BYTE)
    ,BIND_DATA                 RAW(2000)                           
    ,MODULE		               VARCHAR2(64 BYTE)
    ,ACTION		               VARCHAR2(64 BYTE)
    ,ELAPSED_TIME		       NUMBER
    ,CPU_TIME		           NUMBER
    ,BUFFER_GETS		       NUMBER
    ,DISK_READS		           NUMBER
    ,DIRECT_WRITES		       NUMBER
    ,ROWS_PROCESSED		       NUMBER
    ,FETCHES		           NUMBER
    ,EXECUTIONS		           NUMBER
    ,END_OF_FETCH_COUNT		   NUMBER
    ,OPTIMIZER_COST		       NUMBER
    ,OPTIMIZER_ENV		       RAW(2000)
    ,COMMAND_TYPE		       NUMBER
    ,FIRST_LOAD_TIME		   VARCHAR2(76 BYTE)
    ,PLAN_HASH_VALUE		   NUMBER
    ,PROGRAM_ID                NUMBER
    ,PROGRAM_LINE#             NUMBER
 )
 ON COMMIT PRESERVE ROWS 
 ;


 CREATE GLOBAL TEMPORARY TABLE V_SQL_PLAN_VIEW
 (
     NAME                      VARCHAR2(128 BYTE)
    ,SNAPTIME                  DATE
    ,SQL_ID		               VARCHAR2(13 BYTE)
    ,CHILD_NUMBER		       NUMBER
    ,PLAN_HASH_VALUE		   NUMBER
    ,TIMESTAMP		           DATE
    ,REMARKS		           VARCHAR2(4000 BYTE)
    ,OPERATION		           VARCHAR2(120 BYTE)
    ,OPTIONS		           VARCHAR2(120 BYTE)
    ,OBJECT_NODE		       VARCHAR2(160 BYTE)
    ,OBJECT_OWNER		       VARCHAR2(128 BYTE)
    ,OBJECT_NAME		       VARCHAR2(128 BYTE)
    ,OBJECT_ALIAS		       VARCHAR2(261 BYTE)
    ,OBJECT_TYPE		       VARCHAR2(80 BYTE)
    ,OPTIMIZER		           VARCHAR2(80 BYTE)
    ,SEARCH_COLUMNS	           NUMBER
    ,ID		                   NUMBER
    ,PARENT_ID		           NUMBER
    ,DEPTH		               NUMBER
    ,POSITION		           NUMBER
    ,COST		               NUMBER
    ,CARDINALITY		       NUMBER
    ,BYTES		               NUMBER
    ,OTHER_TAG		           VARCHAR2(140 BYTE)
    ,PARTITION_START	       VARCHAR2(256 BYTE)
    ,PARTITION_STOP            VARCHAR2(256 BYTE)
    ,PARTITION_ID		       NUMBER
    ,DISTRIBUTION		       VARCHAR2(80 BYTE)
    ,CPU_COST		           NUMBER
    ,IO_COST		           NUMBER
    ,TEMP_SPACE		           NUMBER
    ,TIME		               NUMBER
    ,QBLOCK_NAME		       VARCHAR2(128 BYTE)
    ,ACCESS_PREDICATES         VARCHAR2(4000 BYTE) 
    ,FILTER_PREDICATES         VARCHAR2(4000 BYTE)   
    ,PROJECTION                VARCHAR2(4000)
    ,OTHER_XML                 CLOB 
 )
 ON COMMIT PRESERVE ROWS ;
  
  
-- ==================================================================================================================
-- iRPM SPT - Digital Signature LOG Table
-- ==================================================================================================================    
  DROP TABLE ILM_IRPMSPT_DIGITALSLOG PURGE;
  
  CREATE TABLE ILM_IRPMSPT_DIGITALSLOG
  (
     RUN_NAME                           VARCHAR2(256)  
    ,LOGTIME                            TIMESTAMP
    ,SQL_ID                             VARCHAR2(13 BYTE)
    ,SQL_CHECK                          CLOB
    ,DIGITAL_SIGNATURE_VAL              RAW(512)
    ,ERR_LOG                            VARCHAR2(2048)
  )
  PCTFREE 10  INITRANS 1  MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;  
  
-- ===============================================================================================================
-- iRPM SPT - Performance Logging Table
-- ===============================================================================================================
 
  CREATE TABLE ILM_PERFORMANCE_LOG
  (
     RUN_NAME                        VARCHAR2(256 BYTE)                  NOT NULL
    ,RUN_SOURCE                      VARCHAR2(100 BYTE)                  NOT NULL
    ,INST_ID                         NUMBER                              NOT NULL       
    ,SNAPTIME                        VARCHAR2(16 BYTE)                   NOT NULL
    ,HOST_CPU_UTIL                   NUMBER                              
    ,LOGICAL_READS_PER_SEC           NUMBER                              
    ,PHYSICAL_READS_PER_SEC          NUMBER                              
    ,EXECUTIONS_PER_EXEC             NUMBER                              
    ,TPS                             NUMBER                              
    ,SESSION_COUNT                   NUMBER                              
  )
  SEGMENT CREATION IMMEDIATE
  PCTFREE 10  INITRANS 1  MAXTRANS 255
  LOGGING
  TABLESPACE @@TABLESPACE@@
  ;
 
  CREATE UNIQUE INDEX ILM_PERFORMANCE_LOG_IDX1 ON ILM_PERFORMANCE_LOG ( RUN_NAME , RUN_SOURCE, INST_ID, SNAPTIME)
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TABLESPACE@@
  ;
  