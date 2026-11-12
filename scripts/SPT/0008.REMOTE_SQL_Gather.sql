-- #####################################################################################################################################################
-- 0017.REMOTE_SQL_Gather.sql 
-- [SCRIPT 0017 : REMOTE DB의 CACHE에서 주기적으로 SQL을 수집을 위한 최소한의 처리 절차]
--
--    > 해당 수집은 SYS, SYSTEM 또는 이와 동등한 권한의 USER에 생성 및 실행하여 수집한다.
--    > 수집할 일수 및 주기, COMMIT단위, FILTER조건을을 지정하여 실행한다.
--    > 수집 기간 중 주기적으로 ILM_IRPMSPT_SQLSET_STAGE Table의 수집 ROW수 및 SQL_ID수를 확인한다.
--    > 사전 Check tkgkd V$parameter의 job_queue_process확인 => select name,value from v$parameter where name like 'job_queue_processes';
--    > job_queue_processess는 기존 Job(Scheduler, dbms_job)과 실행 Process수를 고려하여 충분히 설정
--      alter system set job_queue_processes=1000;     
--
--    STEP 1. SQL수깁용 Repository Table생성 
--            iRPM Repository용 Tablespace는 사전에 생성 (1GB이상 권장)
--            @@TBLSPACE@@          : REPOSITORY Tablespace Name으로 모두 변경 후 실행
--    STEP 2. SQL 수집을 위한 Procedure 생성
--    STEP 3. SQL 수집을 위한 Scheduler Job실행 (RAC일 경우 Node마다 Scheduler Job이 생성되어야 함)
--            현재 설정된 Scheduler JOb은 'FREQ=hourly; BYHOUR=2,4,6,8,10,12,14,16,18,20,22,0; BYMINUTE=5;'와 같이 짝수시간대 5분에 최근 2.2시간전에 실행된 SQL을 수집
--    STEP 4. 수집된 SQL 확인
--
-- ========================================================================================================================
-- REMOTE SQL수집
--    >> 용도 
--       1) 운영의 DML발생을 할 수 없는 경우 REMOTE 수집 사용
--       2) ADG(Active Data Guard)의 View DB의 경우 SQL을 Local에서 수집할 수 없는 경우
--       3) TEST DB (SPT실행 Site)에서 직접 수집하여 Table의 이전이 필요 없도록 하기 위해서
--       4) 하나의 DB에서 여러 시스템의 SQL을 수집하고자 하는 경우 (계정계, 정보계, 감사, ...) --> 이 경우 각각 
-- 
--    >> 사전 Check항목
--       1) 접속 시스템의 NODE마다 DB Link생성 (가능한 Target의 INSTANCE명과 같은 DB Link먕 생성) 및 접속하여 V$INSTANCE select Test
--       2) DB*Link접속 계정은 SYSTEM 또는 V$SQL, V$SQL_PLAN을 검색 가능한 계정 필요
--       3) Local 수집 DB의 job_queue_processes는 Scheduler Job 및 기타 다른 Job을 실행을 위한 충분한 값으로 설정
--       4) Local DB에 V_SQL_VIEW, V_SQL_PLAN_VIEW 및 Staging Table ILM_IRPMSPT_SQLSET_STAGE 미리 생성 
--          
--
--    >> DB*Link생성 및 Test
--
--       CREATE DATABASE LINK EORCL12C1 connect to rpmmgr identified by rpmmgr USING 
--         '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=192.168.0.72)(PORT=1521))(CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=ORCL12C)(INSTANCE_NAME=ORCL12C1)))';
--       
--       CREATE DATABASE LINK EORCL12C2 connect to rpmmgr identified by rpmmgr USING 
--         '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=192.168.0.73)(PORT=1521))(CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=ORCL12C)(INSTANCE_NAME=ORCL12C2)))';
--       
--       select * from v$instance@EORCL12C1 ;
--       select * from v$instance@EORCL12C2 ;
--
--    >> 수집 Map ----------------------------------------------------------------------------------------------------------- 
-- 
--         DB Link로 V$SQL, V$SQL_PLAN을 Join해서 CLOB를 가져올 수 없으므로 DB Link를 위한 REMOTE 수집은
--         V$SQL수집을 위한 V_SQL_VIEW, V$SQL_PLAN 수집을 위한 V_SQL_PLAN_VIEW 2개의 Temporary Table을 만들어서 사용
--
--
--           [REMOTE]       |    [LOCAL]     
--                          |
--                          | DB*Link
--           V$SQL ---------+------------>  V_SQL_VIEW       -----+
--                          |                                     |  Join & Merge
--                          |                                     +-------------------> ILM_IRPMSPT_SQLSET_STAGE
--                          | DB*Link                             |
--           V$SQL_PLAN ----+------------>  V_SQL_PLAN_VIEW  -----+    
--                          |
--                          |
--
-- ========================================================================================================================
--
-- #####################################################################################################################################################
 

-- ========================================================================================================================
-- STEP 1. Table생성
--         DB Link로 V$SQL, V$SQL_PLAN을 Join해서 CLOB를 가져올 수 없으므로 DB Link를 위한 REMOTE 수집은
--         V$SQL수집을 위한 V_SQL_VIEW, V$SQL_PLAN 수집을 위한 V_SQL_PLAN_VIEW 2개의 Temporary Table을 만들어서 사용
-- ========================================================================================================================

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
    --,CON_DBID                           NUMBER            /* 12C Only Container DB                */                   
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
    --,LAST_EXEC_START_TIME               VARCHAR2(19 BYTE)  /* 12C R2이상                           */                 
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
  TABLESPACE @@TBLSPACE@@
--  LOB (SQL_TEXT)                    STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TBLSPACE@@)
--  LOB (OTHER)                       STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TBLSPACE@@)
--  LOB (PLAN_OTHER_XML)              STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TBLSPACE@@)
--  LOB (SPARE3)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TBLSPACE@@)
--  LOB (SPARE4)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TBLSPACE@@)
--  LOB (SPARE7)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TBLSPACE@@)
--  LOB (SPARE8)                      STORE AS  SECUREFILE ( ENABLE STORAGE IN ROW NOCACHE TABLESPACE @@TBLSPACE@@)
  ;
  
  
  CREATE INDEX ILM_IRPMSPT_SQLSET_STAGE_IDX1 ON ILM_IRPMSPT_SQLSET_STAGE ( SQL_ID , NAME , PLAN_HASH_VALUE  )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TBLSPACE@@
  ;
  
  CREATE INDEX ILM_IRPMSPT_SQLSET_STAGE_IDX2 ON ILM_IRPMSPT_SQLSET_STAGE ( SQL_ID , CHILD_NUMBER , PLAN_HASH_VALUE , PLAN_ID )
  PCTFREE 10 INITRANS 2 MAXTRANS 255
  TABLESPACE @@TBLSPACE@@
  ;


  COMMENT ON  TABLE ILM_IRPMSPT_SQLSET_STAGE IS 'iRPM SPT분석 비교분석 결과 Table';
  
  
-- ========================================================================================================================
-- STEP 2. DB Link를 이용한 SQL수집용 Procedure 생성
--
-- ========================================================================================================================
CREATE OR REPLACE PROCEDURE IRPM_SQLGATHER_REMOTE(in_DBLINK_NAME IN VARCHAR2,in_SYSTEM_NAME IN VARCHAR2,in_ID IN NUMBER,  in_STS_OWNER IN VARCHAR2, in_STS_TABLE_NAME IN VARCHAR2,
                              in_COMMIT_ROWS IN NUMBER DEFAULT 1000, in_FILTER_PREDICATE IN VARCHAR2 DEFAULT NULL)  AUTHID CURRENT_USER   
IS
    v_code                   NUMBER          := NULL;
    v_errm                   VARCHAR2(2048)  := '';
    v_filter_predicate       VARCHAR2(32767) := in_FILTER_PREDICATE;
    V_SQL_CNT                NUMBER;
    V_SQL_PLAN_CNT           NUMBER;
    V_RUN_SQL                VARCHAR2(32767);  
BEGIN

    -- -----------------------------------------------------
    -- 1. Temporary table truncate
    -- -----------------------------------------------------
    EXECUTE IMMEDIATE 'TRUNCATE TABLE V_SQL_VIEW';
    EXECUTE IMMEDIATE 'TRUNCATE TABLE V_SQL_PLAN_VIEW';
    
    
    -- -----------------------------------------------------
    -- 2. Select for remote V$SQL
    -- -----------------------------------------------------
    V_RUN_SQL := 'INSERT INTO V_SQL_VIEW
       SELECT ''' || in_DBLINK_NAME || ''' NAME, TRUNC(SYSDATE,''HH24'') SNAPTIME
              ,S.SQL_ID,S.CHILD_NUMBER,S.FORCE_MATCHING_SIGNATURE,S.SQL_FULLTEXT,S.PARSING_SCHEMA_NAME
              ,S.BIND_DATA,S.MODULE,S.ACTION,S.ELAPSED_TIME,S.CPU_TIME,S.BUFFER_GETS,S.DISK_READS
              ,S.DIRECT_WRITES,S.ROWS_PROCESSED,S.FETCHES,S.EXECUTIONS,S.END_OF_FETCH_COUNT,S.OPTIMIZER_COST
              ,S.OPTIMIZER_ENV,S.COMMAND_TYPE,S.FIRST_LOAD_TIME,S.PLAN_HASH_VALUE,S.PROGRAM_ID,S.PROGRAM_LINE#
       FROM   V$SQL@' || in_DBLINK_NAME || ' S
       WHERE  1=1
              AND S.PARSING_SCHEMA_NAME not in (''SYS'',''SYSTEM'',''DBSNMP'',''SYSMAN'',''MGMT_VIEW'',''ORACLE_OCM'',
                                                ''DIP'',''OUTLN'',''XDB'',''ORANGE'',''MAXGAUGE'',''CTXSYS'',''EXFSYS'',
                                                ''MDSYS'',''STRMADMIN'',''APEX_030200'',''WMSYS'',''PETRA'') 
              AND UPPER(MODULE) not like ''TOAD%''
              AND UPPER(MODULE) not like ''T.O.A.D%''
              AND UPPER(MODULE) not like ''SQL DEV%''
              AND UPPER(MODULE) not like ''ORANGE%''
              AND UPPER(MODULE) not like ''GOLDEN%''
              AND UPPER(MODULE) not like ''PL/SQL%''
              AND UPPER(MODULE) not like ''DATA PUMP%''
              AND UPPER(MODULE) not like ''DBMS_SCHEDULER%''
              AND UPPER(MODULE) not like ''IMP%''
              AND UPPER(MODULE) not like ''EXP%''
              AND UPPER(MODULE) not like ''%IMPEXP%''
              AND UPPER(MODULE) not like ''GEN%''
              AND UPPER(MODULE) not like ''GOLDVW%''
              AND UPPER(MODULE) not like ''ORASCOPE%''
              AND UPPER(MODULE) not like ''TYS_META%''
              AND UPPER(MODULE) not like ''XMONITOR%''
              AND UPPER(MODULE) not like ''ENCORE%''
              AND UPPER(MODULE) not like ''FRMBLD%''
              AND UPPER(MODULE) not like ''EXCEL%''
              AND UPPER(MODULE) not like ''SQLGATE%''
              AND UPPER(MODULE) not like ''DBAMASTER%''
              AND S.SQL_TEXT NOT LIKE ''%sys.plan_table$''
              AND S.SQL_TEXT NOT LIKE ''%PLAN_TABLE$%'' ' || in_FILTER_PREDICATE   ;
              
    DBMS_OUTPUT.PUT_LINE('[iRPM_SPT Remote SQL Gather] RUN_SQL => ' || V_RUN_SQL );  
    
    EXECUTE IMMEDIATE V_RUN_SQL;
              
    -- -----------------------------------------------------   
    -- 3. Select for remote V$SQL_PLAN   
    -- -----------------------------------------------------
    V_RUN_SQL :=  'INSERT INTO V_SQL_PLAN_VIEW
       SELECT /*+ LEADING(S SP) USE_HASH(S SP) */ 
             ''' || in_DBLINK_NAME || ''' NAME, TRUNC(SYSDATE,''HH24'') SNAPTIME
            ,SP.SQL_ID,SP.CHILD_NUMBER,SP.PLAN_HASH_VALUE,SP.TIMESTAMP,SP.REMARKS,SP.OPERATION
            ,SP.OPTIONS,SP.OBJECT_NODE,SP.OBJECT_OWNER,SP.OBJECT_NAME,SP.OBJECT_ALIAS
            ,SP.OBJECT_TYPE,SP.OPTIMIZER,SP.SEARCH_COLUMNS,SP.ID,SP.PARENT_ID,SP.DEPTH
            ,SP.POSITION,SP.COST,SP.CARDINALITY,SP.BYTES,SP.OTHER_TAG,SP.PARTITION_START
            ,SP.PARTITION_STOP,SP.PARTITION_ID,SP.DISTRIBUTION,SP.CPU_COST,SP.IO_COST
            ,SP.TEMP_SPACE,SP.TIME,SP.QBLOCK_NAME,SP.ACCESS_PREDICATES,SP.FILTER_PREDICATES,SP.PROJECTION, SP.OTHER_XML
       FROM  V$SQL@' || in_DBLINK_NAME || ' S,
             V$SQL_PLAN@' || in_DBLINK_NAME || ' SP
       WHERE 1=1
             AND S.SQL_ID           = SP.SQL_ID
             AND S.CHILD_NUMBER     = SP.CHILD_NUMBER
             AND S.PLAN_HASH_VALUE  = SP.PLAN_HASH_VALUE
             AND S.PARSING_SCHEMA_NAME not in (''SYS'',''SYSTEM'',''DBSNMP'',''SYSMAN'',''MGMT_VIEW'',''ORACLE_OCM'',
                                               ''DIP'',''OUTLN'',''XDB'',''ORANGE'',''MAXGAUGE'',''CTXSYS'',''EXFSYS'',
                                               ''MDSYS'',''STRMADMIN'',''APEX_030200'',''WMSYS'',''PETRA'') 
             AND UPPER(S.MODULE) not like ''TOAD%''
             AND UPPER(S.MODULE) not like ''T.O.A.D%''
             AND UPPER(S.MODULE) not like ''SQL DEV%''
             AND UPPER(S.MODULE) not like ''ORANGE%''
             AND UPPER(S.MODULE) not like ''GOLDEN%''
             AND UPPER(S.MODULE) not like ''PL/SQL%''
             AND UPPER(S.MODULE) not like ''DATA PUMP%''
             AND UPPER(S.MODULE) not like ''DBMS_SCHEDULER%''
             AND UPPER(S.MODULE) not like ''IMP%''
             AND UPPER(S.MODULE) not like ''EXP%''
             AND UPPER(S.MODULE) not like ''%IMPEXP%''
             AND UPPER(S.MODULE) not like ''GEN%''
             AND UPPER(S.MODULE) not like ''GOLDVW%''
             AND UPPER(S.MODULE) not like ''ORASCOPE%''
             AND UPPER(S.MODULE) not like ''TYS_META%''
             AND UPPER(S.MODULE) not like ''XMONITOR%''
             AND UPPER(S.MODULE) not like ''ENCORE%''
             AND UPPER(S.MODULE) not like ''FRMBLD%''
             AND UPPER(S.MODULE) not like ''EXCEL%''
             AND UPPER(S.MODULE) not like ''SQLGATE%''
             AND UPPER(S.MODULE) not like ''DBAMASTER%''
             AND S.SQL_TEXT NOT LIKE ''%sys.plan_table$''
             AND S.SQL_TEXT NOT LIKE ''%PLAN_TABLE$%'' ' || in_FILTER_PREDICATE ;
    
    DBMS_OUTPUT.PUT_LINE('[iRPM_SPT Remote SQL Gather] RUN_SQL => ' || V_RUN_SQL );    
    
    EXECUTE IMMEDIATE V_RUN_SQL;
       
    COMMIT;      

    EXECUTE IMMEDIATE 'select count(sql_id) from V_SQL_VIEW ' INTO V_SQL_CNT;
    EXECUTE IMMEDIATE 'select count(sql_id) from V_SQL_PLAN_VIEW ' INTO V_SQL_PLAN_CNT;
    
    DBMS_OUTPUT.PUT_LINE('[iRPM_SPT Remote SQL Gather] V_SQL_VIEW      Cnt => ' || V_SQL_CNT ); 
    DBMS_OUTPUT.PUT_LINE('[iRPM_SPT Remote SQL Gather] V_SQL_PLAN_VIEW Cnt => ' || V_SQL_PLAN_CNT ); 

    -- -----------------------------------------------------   
    -- MERGE to STS Staging Table  
    -- -----------------------------------------------------
    V_RUN_SQL := 'DECLARE
                i NUMBER := 0;
           BEGIN
                FOR c1 IN (SELECT  ''' || TRUNC(TO_CHAR(in_ID)) || '''                                                      AS ID
                                 ,  S.NAME || ''_SQLSET''                                                                   AS NAME        -- STS_NAME
                                 ,  '''||in_STS_OWNER||'''                                                                  AS OWNER       -- STS USER
                                 ,  ''iRPM SPT REMOTE SQLGather''                                                           AS DESCRIPTION -- STS DESCRIPTION
                                 ,  S.SQL_ID                                                                                AS SQL_ID 
                                 ,  S.CHILD_NUMBER                                                                          AS CHILD_NUMBER
                                 ,  DECODE(SP.ID,NULL,S.FORCE_MATCHING_SIGNATURE, 1, S.FORCE_MATCHING_SIGNATURE, NULL)      AS FORCE_MATCHING_SIGNATURE
                                 ,  DECODE(SP.ID,NULL,S.SQL_TEXT                , 1, S.SQL_TEXT, NULL)                      AS SQL_TEXT
                                 ,  DECODE(SP.ID,NULL,S.PARSING_SCHEMA_NAME     , 1, S.PARSING_SCHEMA_NAME, NULL)           AS PARSING_SCHEMA_NAME
                                 ,  DECODE(SP.ID,NULL,S.BIND_DATA               , 1, S.BIND_DATA, NULL)                     AS BIND_DATA
                                 ,  DECODE(SP.ID,NULL,DECODE(S.BIND_DATA, NULL, NULL, ''Y''), 1, DECODE(S.BIND_DATA, NULL, NULL, ''Y'')) AS BINDS_CAPTURED
                                 ,  NULL                                                                                    AS BIND_POSITION
                                 ,  NULL                                                                                    AS BIND_VALUE
                                 ,  DECODE(SP.ID,NULL,S.MODULE                  , 1, S.MODULE, NULL)                        AS MODULE
                                 ,  DECODE(SP.ID,NULL,S.ACTION                  , 1, S.ACTION, NULL)                        AS ACTION
                                 ,  DECODE(SP.ID,NULL,S.ELAPSED_TIME            , 1, S.ELAPSED_TIME, NULL)                  AS ELAPSED_TIME
                                 ,  DECODE(SP.ID,NULL,S.CPU_TIME                , 1, S.CPU_TIME, NULL)                      AS CPU_TIME
                                 ,  DECODE(SP.ID,NULL,S.BUFFER_GETS             , 1, S.BUFFER_GETS, NULL)                   AS BUFFER_GETS
                                 ,  DECODE(SP.ID,NULL,S.DISK_READS              , 1, S.DISK_READS, NULL)                    AS DISK_READS
                                 ,  DECODE(SP.ID,NULL,S.DIRECT_WRITES           , 1, S.DIRECT_WRITES, NULL)                 AS DIRECT_WRITES
                                 ,  DECODE(SP.ID,NULL,S.ROWS_PROCESSED          , 1, S.ROWS_PROCESSED, NULL)                AS ROWS_PROCESSED
                                 ,  DECODE(SP.ID,NULL,S.FETCHES                 , 1, S.FETCHES, NULL)                       AS FETCHES
                                 ,  DECODE(SP.ID,NULL,S.EXECUTIONS              , 1, S.EXECUTIONS, NULL)                    AS EXECUTIONS
                                 ,  DECODE(SP.ID,NULL,S.END_OF_FETCH_COUNT      , 1, S.END_OF_FETCH_COUNT, NULL)            AS END_OF_FETCH_COUNT
                                 ,  DECODE(SP.ID,NULL,S.OPTIMIZER_COST          , 1, S.OPTIMIZER_COST, NULL)                AS OPTIMIZER_COST
                                 ,  DECODE(SP.ID,NULL,S.OPTIMIZER_ENV           , 1, S.OPTIMIZER_ENV, NULL)                 AS OPTIMIZER_ENV
                                 ,  NULL                                                                                    AS PRIORITY
                                 ,  DECODE(SP.ID,NULL,S.COMMAND_TYPE            , 1, S.COMMAND_TYPE, NULL)                  AS COMMAND_TYPE
                                 ,  DECODE(SP.ID,NULL,S.FIRST_LOAD_TIME         , 1, S.FIRST_LOAD_TIME, NULL)               AS FIRST_LOAD_TIME
                                 ,  DECODE(SP.ID,NULL,S.PROGRAM_ID              , 1, S.PROGRAM_ID, NULL)                    AS STAT_PERIOD
                                 ,  DECODE(SP.ID,NULL,S.PROGRAM_LINE#           , 1, S.PROGRAM_LINE#, NULL)                 AS ACTIVE_STAT_PERIOD                                 
                                 ,  NULL                                                    AS OTHER
                                 ,  S.PLAN_HASH_VALUE                                       AS PLAN_HASH_VALUE
                                 ,  NULL                                                    AS PLAN_STATEMENT_ID
                                 ,  NULL                                                    AS PLAN_PLAN_ID
                                 ,  SP.TIMESTAMP                                            AS PLAN_TIMESTAMP
                                 ,  SP.REMARKS                                              AS PLAN_REMARKS
                                 ,  SP.OPERATION                                            AS PLAN_OPERATION
                                 ,  SP.OPTIONS                                              AS PLAN_OPTIONS
                                 ,  SP.OBJECT_NODE                                          AS PLAN_OBJECT_NODE
                                 ,  SP.OBJECT_OWNER                                         AS PLAN_OBJECT_OWNER
                                 ,  SP.OBJECT_NAME                                          AS PLAN_OBJECT_NAME
                                 ,  SP.OBJECT_ALIAS                                         AS PLAN_OBJECT_ALIAS
                                 ,  NULL                                                    AS PLAN_OBJECT_INSTANCE
                                 ,  SP.OBJECT_TYPE                                          AS PLAN_OBJECT_TYPE
                                 ,  SP.OPTIMIZER                                            AS PLAN_OPTIMIZER 
                                 ,  SP.SEARCH_COLUMNS                                       AS PLAN_SEARCH_COLUMNS
                                 ,  SP.ID                                                   AS PLAN_ID
                                 ,  SP.PARENT_ID                                            AS PLAN_PARENT_ID
                                 ,  SP.DEPTH                                                AS PLAN_DEPTH
                                 ,  SP.POSITION                                             AS PLAN_POSITION
                                 ,  SP.COST                                                 AS PLAN_COST
                                 ,  SP.CARDINALITY                                          AS PLAN_CARDINALITY
                                 ,  SP.BYTES                                                AS PLAN_BYTES
                                 ,  SP.OTHER_TAG                                            AS PLAN_OTHER_TAG
                                 ,  SP.PARTITION_START                                      AS PLAN_PARTITION_START
                                 ,  SP.PARTITION_STOP                                       AS PLAN_PARTITION_STOP
                                 ,  SP.PARTITION_ID                                         AS PLAN_PARTITION_ID
                                 ,  SP.DISTRIBUTION                                         AS PLAN_DISTRIBUTION
                                 ,  SP.CPU_COST                                             AS PLAN_CPU_COST
                                 ,  SP.IO_COST                                              AS PLAN_IO_COST
                                 ,  SP.TEMP_SPACE                                           AS PLAN_TEMP_SPACE
                                 ,  SP.ACCESS_PREDICATES                                    AS PLAN_ACCESS_PREDICATES
                                 ,  SP.FILTER_PREDICATES                                    AS PLAN_FILTER_PREDICATES
                                 ,  SP.PROJECTION                                           AS PLAN_PROJECTION
                                 ,  SP.TIME                                                 AS PLAN_TIME
                                 ,  SP.QBLOCK_NAME                                          AS PLAN_QBLOCK_NAME
                                 ,  SP.OTHER_XML                                            AS PLAN_OTHER_XML
                                 ,  ''' || in_SYSTEM_NAME || '''                            AS SYSTEM_NAME
                                 ,  S.SNAPTIME                                              AS SNAPTIME
                            FROM V_SQL_VIEW S
                               , V_SQL_PLAN_VIEW SP
                            WHERE S.SQL_ID         = SP.SQL_ID(+)
                            AND S.CHILD_NUMBER     = SP.CHILD_NUMBER(+)
                            AND S.PLAN_HASH_VALUE  = SP.PLAN_HASH_VALUE(+) )
                 LOOP
                    MERGE INTO '||in_STS_OWNER||'.'||in_STS_TABLE_NAME||' ISS
                    USING (SELECT c1.ID                             AS ID
                                , c1.NAME                           AS NAME
                                , c1.OWNER                          AS OWNER
                                , c1.DESCRIPTION                    AS DESCRIPTION
                                , c1.SQL_ID                         AS SQL_ID
                                , c1.CHILD_NUMBER                   AS CHILD_NUMBER
                                , c1.FORCE_MATCHING_SIGNATURE       AS FORCE_MATCHING_SIGNATURE
                                , c1.SQL_TEXT                       AS SQL_TEXT
                                , c1.PARSING_SCHEMA_NAME            AS PARSING_SCHEMA_NAME
                                , c1.BIND_DATA                      AS BIND_DATA
                                , c1.BINDS_CAPTURED                 AS BINDS_CAPTURED
                                , c1.BIND_POSITION                  AS BIND_POSITION
                                , c1.BIND_VALUE                     AS BIND_VALUE
                                , c1.MODULE                         AS MODULE
                                , c1.ACTION                         AS ACTION
                                , c1.ELAPSED_TIME                   AS ELAPSED_TIME
                                , c1.CPU_TIME                       AS CPU_TIME
                                , c1.BUFFER_GETS                    AS BUFFER_GETS
                                , c1.DISK_READS                     AS DISK_READS
                                , c1.DIRECT_WRITES                  AS DIRECT_WRITES
                                , c1.ROWS_PROCESSED                 AS ROWS_PROCESSED
                                , c1.FETCHES                        AS FETCHES
                                , c1.EXECUTIONS                     AS EXECUTIONS
                                , c1.END_OF_FETCH_COUNT             AS END_OF_FETCH_COUNT
                                , c1.OPTIMIZER_COST                 AS OPTIMIZER_COST
                                , c1.OPTIMIZER_ENV                  AS OPTIMIZER_ENV
                                , c1.PRIORITY                       AS PRIORITY
                                , c1.COMMAND_TYPE                   AS COMMAND_TYPE
                                , c1.FIRST_LOAD_TIME                AS FIRST_LOAD_TIME
                                , c1.STAT_PERIOD                    AS STAT_PERIOD
                                , c1.ACTIVE_STAT_PERIOD             AS ACTIVE_STAT_PERIOD
                                , c1.OTHER                          AS OTHER
                                , c1.PLAN_HASH_VALUE                AS PLAN_HASH_VALUE
                                , c1.PLAN_STATEMENT_ID              AS PLAN_STATEMENT_ID
                                , c1.PLAN_PLAN_ID                   AS PLAN_PLAN_ID
                                , c1.PLAN_TIMESTAMP                 AS PLAN_TIMESTAMP
                                , c1.PLAN_REMARKS                   AS PLAN_REMARKS
                                , c1.PLAN_OPERATION                 AS PLAN_OPERATION
                                , c1.PLAN_OPTIONS                   AS PLAN_OPTIONS
                                , c1.PLAN_OBJECT_NODE               AS PLAN_OBJECT_NODE
                                , c1.PLAN_OBJECT_OWNER              AS PLAN_OBJECT_OWNER
                                , c1.PLAN_OBJECT_NAME               AS PLAN_OBJECT_NAME
                                , c1.PLAN_OBJECT_ALIAS              AS PLAN_OBJECT_ALIAS
                                , c1.PLAN_OBJECT_INSTANCE           AS PLAN_OBJECT_INSTANCE
                                , c1.PLAN_OBJECT_TYPE               AS PLAN_OBJECT_TYPE
                                , c1.PLAN_OPTIMIZER                 AS PLAN_OPTIMIZER
                                , c1.PLAN_SEARCH_COLUMNS            AS PLAN_SEARCH_COLUMNS
                                , c1.PLAN_ID                        AS PLAN_ID
                                , c1.PLAN_PARENT_ID                 AS PLAN_PARENT_ID
                                , c1.PLAN_DEPTH                     AS PLAN_DEPTH
                                , c1.PLAN_POSITION                  AS PLAN_POSITION
                                , c1.PLAN_COST                      AS PLAN_COST
                                , c1.PLAN_CARDINALITY               AS PLAN_CARDINALITY
                                , c1.PLAN_BYTES                     AS PLAN_BYTES
                                , c1.PLAN_OTHER_TAG                 AS PLAN_OTHER_TAG
                                , c1.PLAN_PARTITION_START           AS PLAN_PARTITION_START
                                , c1.PLAN_PARTITION_STOP            AS PLAN_PARTITION_STOP
                                , c1.PLAN_PARTITION_ID              AS PLAN_PARTITION_ID
                                , c1.PLAN_DISTRIBUTION              AS PLAN_DISTRIBUTION
                                , c1.PLAN_CPU_COST                  AS PLAN_CPU_COST
                                , c1.PLAN_IO_COST                   AS PLAN_IO_COST
                                , c1.PLAN_TEMP_SPACE                AS PLAN_TEMP_SPACE
                                , c1.PLAN_ACCESS_PREDICATES         AS PLAN_ACCESS_PREDICATES
                                , c1.PLAN_FILTER_PREDICATES         AS PLAN_FILTER_PREDICATES
                                , c1.PLAN_PROJECTION                AS PLAN_PROJECTION
                                , c1.PLAN_TIME                      AS PLAN_TIME
                                , c1.PLAN_QBLOCK_NAME               AS PLAN_QBLOCK_NAME
                                , c1.PLAN_OTHER_XML                 AS PLAN_OTHER_XML
                                , c1.SYSTEM_NAME                    AS SYSTEM_NAME
                                , c1.SNAPTIME                       AS SNAPTIME
                           FROM DUAL
                          ) U
                    ON (    ISS.SQL_ID          = U.SQL_ID 
                        AND ISS.CHILD_NUMBER    = U.CHILD_NUMBER 
                        AND ISS.PLAN_HASH_VALUE = U.PLAN_HASH_VALUE 
                        AND ISS.PLAN_ID         = U.PLAN_ID
                       )
                    WHEN MATCHED THEN
                    UPDATE 
                    SET
                        ISS.BIND_DATA                   = U.BIND_DATA
                      , ISS.BINDS_CAPTURED              = U.BINDS_CAPTURED
                      , ISS.BIND_POSITION               = U.BIND_POSITION
                      , ISS.ELAPSED_TIME                = U.ELAPSED_TIME
                      , ISS.CPU_TIME                    = U.CPU_TIME
                      , ISS.BUFFER_GETS                 = U.BUFFER_GETS
                      , ISS.DISK_READS                  = U.DISK_READS
                      , ISS.DIRECT_WRITES               = U.DIRECT_WRITES
                      , ISS.ROWS_PROCESSED              = U.ROWS_PROCESSED
                      , ISS.FETCHES                     = U.FETCHES
                      , ISS.EXECUTIONS                  = U.EXECUTIONS
                      , ISS.END_OF_FETCH_COUNT          = U.END_OF_FETCH_COUNT
                      , ISS.OPTIMIZER_COST              = U.OPTIMIZER_COST
                      , ISS.OPTIMIZER_ENV               = U.OPTIMIZER_ENV
                      , ISS.PRIORITY                    = U.PRIORITY
                      , ISS.FIRST_LOAD_TIME             = U.FIRST_LOAD_TIME
                      , ISS.PLAN_TIMESTAMP              = U.PLAN_TIMESTAMP
                      , ISS.PLAN_COST                   = U.PLAN_COST
                      , ISS.PLAN_CARDINALITY            = U.PLAN_CARDINALITY
                      , ISS.PLAN_BYTES                  = U.PLAN_BYTES
                      , ISS.PLAN_CPU_COST               = U.PLAN_CPU_COST
                      , ISS.PLAN_IO_COST                = U.PLAN_IO_COST
                      , ISS.PLAN_ACCESS_PREDICATES      = U.PLAN_ACCESS_PREDICATES
                      , ISS.PLAN_FILTER_PREDICATES      = U.PLAN_FILTER_PREDICATES
                      , ISS.SYSTEM_NAME                 = U.SYSTEM_NAME
                      , ISS.SNAPTIME                    = U.SNAPTIME
                    WHEN NOT MATCHED THEN
                    INSERT ( ISS.ID, ISS.NAME, ISS.OWNER, ISS.DESCRIPTION, ISS.SQL_ID, ISS.CHILD_NUMBER, ISS.FORCE_MATCHING_SIGNATURE, ISS.SQL_TEXT, ISS.PARSING_SCHEMA_NAME
                           , ISS.BIND_DATA, ISS.BINDS_CAPTURED, ISS.BIND_POSITION, ISS.BIND_VALUE, ISS.MODULE, ISS.ACTION, ISS.ELAPSED_TIME, ISS.CPU_TIME, ISS.BUFFER_GETS, ISS.DISK_READS
                           , ISS.DIRECT_WRITES, ISS.ROWS_PROCESSED, ISS.FETCHES, ISS.EXECUTIONS, ISS.END_OF_FETCH_COUNT, ISS.OPTIMIZER_COST, ISS.OPTIMIZER_ENV, ISS.PRIORITY, ISS.COMMAND_TYPE
                           , ISS.FIRST_LOAD_TIME, ISS.STAT_PERIOD, ISS.ACTIVE_STAT_PERIOD, ISS.OTHER, ISS.PLAN_HASH_VALUE, ISS.PLAN_STATEMENT_ID, ISS.PLAN_PLAN_ID, ISS.PLAN_TIMESTAMP
                           , ISS.PLAN_REMARKS, ISS.PLAN_OPERATION, ISS.PLAN_OPTIONS, ISS.PLAN_OBJECT_NODE, ISS.PLAN_OBJECT_OWNER, ISS.PLAN_OBJECT_NAME, ISS.PLAN_OBJECT_ALIAS
                           , ISS.PLAN_OBJECT_INSTANCE, ISS.PLAN_OBJECT_TYPE, ISS.PLAN_OPTIMIZER, ISS.PLAN_SEARCH_COLUMNS, ISS.PLAN_ID, ISS.PLAN_PARENT_ID, ISS.PLAN_DEPTH, ISS.PLAN_POSITION
                           , ISS.PLAN_COST, ISS.PLAN_CARDINALITY, ISS.PLAN_BYTES, ISS.PLAN_OTHER_TAG, ISS.PLAN_PARTITION_START, ISS.PLAN_PARTITION_STOP, ISS.PLAN_PARTITION_ID, ISS.PLAN_DISTRIBUTION
                           , ISS.PLAN_CPU_COST, ISS.PLAN_IO_COST, ISS.PLAN_TEMP_SPACE, ISS.PLAN_ACCESS_PREDICATES, ISS.PLAN_FILTER_PREDICATES, ISS.PLAN_PROJECTION, ISS.PLAN_TIME, ISS.PLAN_QBLOCK_NAME
                           , ISS.PLAN_OTHER_XML, ISS.SYSTEM_NAME, ISS.SNAPTIME
                           )
                    VALUES ( U.ID, U.NAME, U.OWNER, U.DESCRIPTION, U.SQL_ID, U.CHILD_NUMBER, U.FORCE_MATCHING_SIGNATURE, U.SQL_TEXT, U.PARSING_SCHEMA_NAME
                           , U.BIND_DATA, U.BINDS_CAPTURED, U.BIND_POSITION, SYS.ANYDATA.CONVERTVARCHAR2(U.BIND_VALUE), U.MODULE, U.ACTION, U.ELAPSED_TIME, U.CPU_TIME, U.BUFFER_GETS, U.DISK_READS
                           , U.DIRECT_WRITES, U.ROWS_PROCESSED, U.FETCHES, U.EXECUTIONS, U.END_OF_FETCH_COUNT, U.OPTIMIZER_COST, U.OPTIMIZER_ENV, U.PRIORITY, U.COMMAND_TYPE
                           , U.FIRST_LOAD_TIME, U.STAT_PERIOD, U.ACTIVE_STAT_PERIOD, U.OTHER, U.PLAN_HASH_VALUE, U.PLAN_STATEMENT_ID, U.PLAN_PLAN_ID, U.PLAN_TIMESTAMP
                           , U.PLAN_REMARKS, U.PLAN_OPERATION, U.PLAN_OPTIONS, U.PLAN_OBJECT_NODE, U.PLAN_OBJECT_OWNER, U.PLAN_OBJECT_NAME, U.PLAN_OBJECT_ALIAS
                           , U.PLAN_OBJECT_INSTANCE, U.PLAN_OBJECT_TYPE, U.PLAN_OPTIMIZER, U.PLAN_SEARCH_COLUMNS, U.PLAN_ID, U.PLAN_PARENT_ID, U.PLAN_DEPTH, U.PLAN_POSITION
                           , U.PLAN_COST, U.PLAN_CARDINALITY, U.PLAN_BYTES, U.PLAN_OTHER_TAG, U.PLAN_PARTITION_START, U.PLAN_PARTITION_STOP, U.PLAN_PARTITION_ID, U.PLAN_DISTRIBUTION
                           , U.PLAN_CPU_COST, U.PLAN_IO_COST, U.PLAN_TEMP_SPACE, U.PLAN_ACCESS_PREDICATES, U.PLAN_FILTER_PREDICATES, U.PLAN_PROJECTION, U.PLAN_TIME, U.PLAN_QBLOCK_NAME
                           , U.PLAN_OTHER_XML, U.SYSTEM_NAME, U.SNAPTIME
                           );
                           
                i := i + 1;              
                IF i > '||in_COMMIT_ROWS||' THEN   -- COMMIT 단위 설정
                   COMMIT;
                   i := 0;
                END IF;
             
           END LOOP;
             COMMIT;
       END;';
    
  
    EXECUTE IMMEDIATE V_RUN_SQL;
 
    
    EXCEPTION WHEN OTHERS THEN
        v_code := SQLCODE;
        v_errm := SQLERRM;
        DBMS_OUTPUT.PUT_LINE ('[iRPM_SPT]:( '  || v_code || ': ' || v_errm || ')'); 

END;
/


 
-- ========================================================================================================================
-- STEP 3. REMOTE SQL수집을 위한 JOB(Scheduler Job실행)
-- ========================================================================================================================
DECLARE
    in_GATHER_DAYS      NUMBER(10)    ;
    in_REPEAT_INTERVAL  VARCHAR2(4000);
    in_SYSTEM_NAME      VARCHAR2(256) ; 
    in_STS_OWNER        VARCHAR2(256) ;  
    in_STS_TABLE_NAME   VARCHAR2(256) ;
    in_FILTER_PREDICATE VARCHAR2(4000);
    in_COMMIT_COUNT     NUMBER(10)    ;
    in_STS_ID           NUMBER(10)    ;
    
    v_code              NUMBER;
    v_errm              VARCHAR2(2048); 
    v_NodeCount         NUMBER;
    v_RUN_JOB_STRING    VARCHAR2(4000);
    v_ii                NUMBER;  
    v_WORK_PREDICATE    VARCHAR2(4000);   
    
    TYPE DBLINK_LIST_TYP   IS TABLE OF VARCHAR2(64) INDEX BY PLS_INTEGER;    
    DBLINK_LIST DBLINK_LIST_TYP;
    
BEGIN 
    -- =============================================================================
    -- 아래 변수를 수정하여 실행
    --   DBLINK_LIST(1..n)   : 수집할 DB Link List나열
    --   in_REPEAT_INTERVAL  : dbms_scheduler.create_job 의 repeat_interval Parameter
    --   in_GATHER_DAYS      : JOB으로 수집할 Day수
    --   in_SYSTEM_NAME      : 주로 DB명으로 수집된 정보의 출처 DB를 확인 목적
    --   in_STS_OWNER        : IRPM SPT의 수집동 Table의 Owner
    --   in_STS_TABLE_NAME   : IRPM SPT의 수집용 Table
    --   in_COMMIT_COUNT     : SQL수집의 Commit단위
    --   in_FILTER_PREDICATE : SQL수집 FILTER조건 (... FROM V$SQL S, V$SQL_PLAN SP WHERE ...)의 WHERE조건
    -- ------------------------------------------------------------
    in_GATHER_DAYS      := 3;
    in_REPEAT_INTERVAL  := 'FREQ=hourly; BYHOUR=2,4,6,8,10,12,14,16,18,20,22,0; BYMINUTE=5;';
    in_STS_OWNER        := sys_context('USERENV', 'SESSION_USER');
    in_STS_TABLE_NAME   := 'ILM_IRPMSPT_SQLSET_STAGE'; 
    in_COMMIT_COUNT     := 5000;
    in_FILTER_PREDICATE := ' AND S.EXECUTIONS > 1 AND S.LAST_ACTIVE_TIME >= to_date(to_char(sysdate - 2.2/24,''yyyy/mm/dd hh24:mi:ss''),''yyyy/mm/dd hh24:mi:ss'') ';

    -- -----------------------------------------
    -- DB Link의 REMOTE DB명 지정
    -- 아래의 수집 대상 DB Link는 미리 생성되어 있어야 하며 Query실행 결과 문제 없어야 함
    -- DB Link의 수집 대상을 N개 까지 추가하여 나열하면 됨
    -- in_STS_ID 는 Staging Table의 ID로 REMOTE일 경우 1000 이상 권장
    -- -----------------------------------------
    in_SYSTEM_NAME     := 'ORCL12C';
    in_STS_ID          := 1000;
    DBLINK_LIST(1)     := 'EORCL12C1';
    DBLINK_LIST(2)     := 'EORCL12C2';
    --DBLINK_LIST(3)   := 'EORCL12C3';
    --DBLINK_LIST(4)   := 'EORCL12C4';
    -- =============================================================================
    
    
    v_WORK_PREDICATE := ' ' || REPLACE(in_FILTER_PREDICATE,'''','''''') || ' ';
        
    v_RUN_JOB_STRING := '';
    v_ii := DBLINK_LIST.FIRST;
    
    WHILE v_ii IS NOT NULL LOOP
       v_RUN_JOB_STRING := v_RUN_JOB_STRING || chr(10) || '    ' || 'IRPM_SQLGATHER_REMOTE(''' || DBLINK_LIST(v_ii) || ''',''' || in_SYSTEM_NAME || ''',' || in_STS_ID || ',''' ||
                            in_STS_OWNER || ''','''  || in_STS_TABLE_NAME || ''', ' || in_COMMIT_COUNT || ',''' || v_WORK_PREDICATE || ''');';
       v_ii := DBLINK_LIST.NEXT(v_ii);  
    END LOOP;
    
    IF v_RUN_JOB_STRING <> '' THEN
       DBMS_OUTPUT.PUT_LINE ('iRPM_SPT : DB Link List not found!!');  
       RETURN;
    END IF;
 
    v_RUN_JOB_STRING := 'BEGIN ' || v_RUN_JOB_STRING || chr(10) || 'END;' ;
    DBMS_OUTPUT.PUT_LINE ('iRPM_SPT Job String :' || chr(10) || v_RUN_JOB_STRING);  
    
    -- FOR DEBUG
    -- RETURN;

    BEGIN 
        dbms_scheduler.create_job(
          job_name        => 'IRPM_REMOTE_SQL_GATHER'
         ,job_type        => 'PLSQL_BLOCK'
         ,job_action      => v_RUN_JOB_STRING
         ,start_date      => sysdate 
         ,end_date        => sysdate + in_GATHER_DAYS
         ,repeat_interval => in_REPEAT_INTERVAL
         ,enabled         => TRUE
         ,comments        => 'IRPM_REMOTE_SQL_GATHER'
       );
    EXCEPTION WHEN others THEN 
           v_code := SQLCODE;
           v_errm := SQLERRM;
           DBMS_OUTPUT.PUT_LINE ('iRPM : ' || 'IRPM_REMOTE_SQL_GATHER Gather Error ('  || v_code || ': ' || v_errm);          
    END;
    
END;
/
 
-- ========================================================================================================================
-- STEP 4. 수집된 SQL 확인. 수집되는 중간에 확인해도 됨.
-- ========================================================================================================================

-- Scheduler Job등록 확인 (Node마다 1개씩의 Scheduelr Job
select OWNER,JOB_NAME,INSTANCE_ID,STATE,RUN_COUNT,JOB_ACTION,REPEAT_INTERVAL,START_DATE,NEXT_RUN_DATE
from dba_scheduler_jobs 
where job_name like 'IRPM_REMOTE_SQL_GATHER' 
order by job_name;
 

-- 전체 ROW수
select count(*) from ILM_IRPMSPT_SQLSET_STAGE;

select * from ILM_IRPMSPT_SQLSET_STAGE;

-- 수집된 SQL_ID수
select 'SQL    =>' || count(sql_id) from ILM_IRPMSPT_SQLSET_STAGE where parsing_schema_name is not null AND COMMAND_TYPE IN (2,3,6,7,189)
union all
select 'PL/SQL =>' || count(sql_id) from ILM_IRPMSPT_SQLSET_STAGE where parsing_schema_name is not null AND COMMAND_TYPE IN (47)
;
 
 
 
-- ========================================================================================================================
-- STEP 5. for MANUAL Execution
--         Scheduler Job에 의해 실행되는 것이 아니라 Manual하게 실행, 각 DB
-- ========================================================================================================================
--BEGIN 
--    IRPM_SQLGATHER_REMOTE('EORCL12C1','ORCL12C',1000,'IRPMSPT','ILM_IRPMSPT_SQLSET_STAGE', 5000,'  AND S.EXECUTIONS > 1 AND S.LAST_ACTIVE_TIME >= to_date(to_char(sysdate - 2.2/24,''yyyy/mm/dd hh24:mi:ss''),''yyyy/mm/dd hh24:mi:ss'')  ');
--END;
--/

--BEGIN 
--    IRPM_SQLGATHER_REMOTE('EORCL12C1','ORCL12C',1000,'IRPMSPT','ILM_IRPMSPT_SQLSET_STAGE', 5000,'  AND S.EXECUTIONS > 1 AND S.LAST_ACTIVE_TIME >= to_date(to_char(sysdate - 2.2/24,''yyyy/mm/dd hh24:mi:ss''),''yyyy/mm/dd hh24:mi:ss'')  ');
--END;
--/
