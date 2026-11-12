-- #####################################################################################################################################################
-- 0007.SQL_Gather_for_NO_IRPMSPT.sql 
-- [SCRIPT 0007 : iRPM_SPT가 설치가 없는 운영DB의 CACHE에서 주기적으로 SQL을 수집을 위한 최소한의 처리 절차]
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
-- #####################################################################################################################################################


-- ========================================================================================================================
-- STEP 1. SQL수깁용 Repository Table생성 
-- ========================================================================================================================
  DROP TABLE ILM_IRPMSPT_SQLSET_STAGE PURGE;

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
    ,CON_DBID                           NUMBER              /* 12C Only Container DB                */                   
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
    ,LAST_EXEC_START_TIME               VARCHAR2(19 BYTE)  /* 12C R2이상                           */                 
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
-- STEP 2. SQL수집용 MAIN Procedure 생성
--
-- ========================================================================================================================
CREATE OR REPLACE PROCEDURE IRPM_SPT_SQLGATHER(in_STS_OWNER IN VARCHAR2, in_STS_TABLE_NAME IN VARCHAR2, in_COMMIT_ROWS IN NUMBER DEFAULT 1000, 
                                               in_FILTER_PREDICATE IN VARCHAR2 DEFAULT NULL, in_DEBUG IN VARCHAR2 DEFAULT 'FALSE')  AUTHID CURRENT_USER 
IS
    
    v_code                   NUMBER          := NULL;
    v_errm                   VARCHAR2(2048)  := '';
    v_filter_predicate       VARCHAR2(32767) := in_FILTER_PREDICATE;
 
    v_cur_sql VARCHAR2(32767) := 'DECLARE
                            i NUMBER := 0;
                       BEGIN
                            FOR c1 IN (SELECT  ''1''                                                    AS ID
                                             ,  SYS_CONTEXT(''USERENV'',''INSTANCE_NAME'')||''_SQLSET'' AS NAME        -- STS_NAME
                                             ,  '''||in_STS_OWNER||'''                                  AS OWNER       -- STS USER
                                             ,  ''iRPM SPT SQL Gather''                                 AS DESCRIPTION -- STS DESCRIPTION
                                             ,  S.SQL_ID                                                AS SQL_ID 
                                             ,  S.CHILD_NUMBER                                          AS CHILD_NUMBER
                                             ,  DECODE(SP.ID,NULL,S.FORCE_MATCHING_SIGNATURE, 1, S.FORCE_MATCHING_SIGNATURE, NULL)      AS FORCE_MATCHING_SIGNATURE
                                             ,  DECODE(SP.ID,NULL,S.SQL_FULLTEXT            , 1, S.SQL_FULLTEXT, NULL)                  AS SQL_TEXT
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
                                             ,  SYS_CONTEXT(''USERENV'',''DB_NAME'')                    AS SYSTEM_NAME
                                             ,  TRUNC(SYSDATE)                                          AS SNAPTIME
                                        FROM V$SQL S
                                           , V$SQL_PLAN SP
                                        WHERE S.SQL_ID         = SP.SQL_ID(+)
                                        AND S.CHILD_NUMBER     = SP.CHILD_NUMBER(+)
                                        AND S.PLAN_HASH_VALUE  = SP.PLAN_HASH_VALUE(+)
                                        AND S.SQL_TEXT NOT LIKE ''%sys.plan_table$''
                                        AND S.SQL_TEXT NOT LIKE ''%PLAN_TABLE$%''
                                        AND S.PARSING_SCHEMA_NAME not in (''SYS'',''SYSTEM'',''DBSNMP'',''SYSMAN'',''MGMT_VIEW'',''ORACLE_OCM'',''DIP'',''OUTLN'',''XDB'',''ORANGE'',''MAXGAUGE'',''CTXSYS'',''EXFSYS'',''MDSYS'',''STRMADMIN'',''APEX_030200'',''WMSYS'',''PETRA'') '
                                        || in_FILTER_PREDICATE ||
                                   ' )
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

BEGIN

    IF  UPPER(in_DEBUG) = 'TRUE' THEN
         DBMS_OUTPUT.PUT_LINE(v_cur_sql);
    ELSE
       EXECUTE IMMEDIATE v_cur_sql;
    END IF;
 

    EXCEPTION WHEN OTHERS THEN
        v_code := SQLCODE;
        v_errm := SQLERRM;
        DBMS_OUTPUT.PUT_LINE ('[iRPM_SPT]:( '  || v_code || ': ' || v_errm || ')'); 

 
END;
/



-- ========================================================================================================================
-- STEP 3. SQL수집을 위한 JOB(Scheduler Job실행)
-- ========================================================================================================================
DECLARE
    in_GATHER_DAYS      NUMBER(10)    ;
    in_SYSTEM_NAME      VARCHAR2(256) ; 
    in_STS_OWNER        VARCHAR2(256) ;  
    in_STS_TABLE_NAME   VARCHAR2(256) ;
    in_REPEAT_INTERVAL  VARCHAR2(4000);
    in_FILTER_PREDICATE VARCHAR2(4000);
    in_COMMIT_COUNT     NUMBER(10)    ;
    v_code              NUMBER;
    v_errm              VARCHAR2(2048); 
    v_NodeCount         NUMBER;
    v_WORK_PREDICATE    VARCHAR2(4000);
    v_RUN_JOB_STRING    VARCHAR2(4000);
BEGIN 
    -- ============================================================
    -- 아래 변수를 수정하여 실행
    --   in_GATHER_DAYS      : 수집 일수
    --   in_SYSTEM_NAME      : 주로 DB명으로 수집된 정보의 출처 DB를 확인 목적
    --   in_STS_OWNER        : IRPM SPT의 수집동 Table의 Owner
    --   in_STS_TABLE_NAME   : IRPM SPT의 수집용 Table
    --   in_REPEAT_INTERVAL  : dbms_scheduler.create_job 의 repeat_interval Parameter
    --   in_COMMIT_COUNT     : SQL수집의 Commit단위
    --   in_FILTER_PREDICATE : SQL수집 FILTER조건 (... FROM V$SQL S, V$SQL_PLAN SP WHERE ...)의 WHERE조건
    -- ------------------------------------------------------------
    in_GATHER_DAYS     := 3;
    in_SYSTEM_NAME     := sys_context('USERENV', 'DB_NAME');
    in_STS_OWNER       := sys_context('USERENV', 'SESSION_USER');
    in_STS_TABLE_NAME  := 'ILM_IRPMSPT_SQLSET_STAGE'; 
    in_REPEAT_INTERVAL := 'FREQ=hourly; BYHOUR=2,4,6,8,10,12,14,16,18,20,22,0; BYMINUTE=5;';
    in_COMMIT_COUNT    := 5000;
    in_FILTER_PREDICATE := ' AND S.EXECUTIONS > 1 AND S.LAST_ACTIVE_TIME >= to_date(to_char(sysdate - 2.2/24,''yyyy/mm/dd hh24:mi:ss''),''yyyy/mm/dd hh24:mi:ss'') ';
    -- ============================================================
 
 
    v_WORK_PREDICATE := ' ' || REPLACE(in_FILTER_PREDICATE,'''','''''') || ' ';
    v_RUN_JOB_STRING := 'BEGIN IRPM_SPT_SQLGATHER(''' || in_STS_OWNER || ''',''' || in_STS_TABLE_NAME || 
                        ''',' || TRIM(TO_CHAR(in_COMMIT_COUNT)) || ',''' || v_WORK_PREDICATE || '''); END;' ;

    BEGIN
       SELECT count(THREAD#) into v_NodeCount FROM v$thread;
       
    EXCEPTION WHEN others THEN 
       v_code := SQLCODE;
       v_errm := SQLERRM;
       DBMS_OUTPUT.PUT_LINE ('Unable get NODE count ' || v_code || ': ' || v_errm); 
       RETURN;
    END;
     
    -- --------------------------------------------------------------------------------------------------- 
    -- RAC 전체 Node에 대한 Job실행, 특정 Node만 실행할 경우 FOR Loop대신 각 Node마다 JOB실행, ii 변수는 RAC INST_ID에 해당함 
    -- --------------------------------------------------------------------------------------------------- 
    FOR ii in 1 .. v_NodeCount loop
      BEGIN

        dbms_scheduler.create_job(
          job_name        => 'IRPM_SPT_SQLG_' || in_SYSTEM_NAME || TRIM(TO_CHAR(ii))
         ,job_type        => 'PLSQL_BLOCK'
         ,job_action      => v_RUN_JOB_STRING
         ,start_date      => sysdate 
         ,end_date        => sysdate + in_GATHER_DAYS
         ,repeat_interval => in_REPEAT_INTERVAL
         ,enabled         => TRUE
         ,comments        => 'iRPM SPT SQL GATHER for '  || in_SYSTEM_NAME || TRIM(TO_CHAR(ii)) );
         dbms_scheduler.set_attribute(name=>'IRPM_SPT_SQLG_' || in_SYSTEM_NAME || TRIM(TO_CHAR(ii)),attribute=>'instance_id', value=>ii);   
       EXCEPTION WHEN others THEN 
           v_code := SQLCODE;
           v_errm := SQLERRM;
           DBMS_OUTPUT.PUT_LINE ('iRPM : ' || 'IRPM_SPT_SQLG_' || in_SYSTEM_NAME || TRIM(TO_CHAR(ii)) || ' Gather Error ('  || v_code || ': ' || v_errm);          
      END;
    END LOOP;
    
END;
/


-- ========================================================================================================================
-- STEP 4. 수집된 SQL 확인. 수집되는 중간에 확인해도 됨.
-- ========================================================================================================================

-- Scheduler Job등록 확인 (Node마다 1개씩의 Scheduelr Job
select OWNER,JOB_NAME,INSTANCE_ID,STATE,RUN_COUNT,JOB_ACTION,REPEAT_INTERVAL,START_DATE,NEXT_RUN_DATE
from dba_scheduler_jobs 
where job_name like 'IRPM_SPT_SQLG%' 
order by job_name;

-- 전체 ROW수
select count(*) from ILM_IRPMSPT_SQLSET_STAGE;

-- 수집된 SQL_ID, CHILD_NUMBER의 수
select count(sql_id) from ILM_IRPMSPT_SQLSET_STAGE where parsing_schema_name is not null;

-- 수집된 Distinct SQL_ID 수
select count(distinct sql_id) from ILM_IRPMSPT_SQLSET_STAGE where parsing_schema_name is not null;


-- ========================================================================================================================
-- STEP 5. 수집 완료된 Repository Table은 iRPM SPT 실행을 위한 TEST DB로 Data Pump 또는 CTAS로 이전 
-- ========================================================================================================================
