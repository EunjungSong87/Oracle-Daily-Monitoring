-- ======================================================================================================================================
-- 0101.LOAD_TEST.sql 
-- [SCRIPT 0101 : iRPM SPT의 수집된 SQL들의 LOAD TEST Sample ]
-- 
-- UGENS SPT 부하발생기 
--    in_RUN_SOURCE==> 'STS' : from iRPM SQL수집 대상 또는 STS(SQL Tuning Set) Source사용. ILM_IRPMSPT_SQLSET_STAGE에 수집된 대상을 이용하여 SPT실행시 사용
--    in_RUN_SOURCE==> 'AWR' : from AWR Source사용 (AWR에서 분석대상 직접 취합하여 실행)
--
--    아래의 입력변수 및 in_PREDICATE 조건을 지정하여 실행
-- 
--    > job_queue_processess는 기존 Job(Scheduler, dbms_job)과 실행 Process수를 고려하여 충분히 설정
--      alter system set job_queue_processes=1000;
--    
--    > 예) 아래의 예는 SOE.ORDERS에 속한 SQL문장들을  LOAD TEST (Stop할 떄까지 Random하게 계속 실행)
--          -->  in_USE_SQL_REPLACE_YN    := 'Y';     SQL_ID가 ILM_IRPMSPT_SQL_REPLACE Table에 변경(튜닝 및 조정)될 대상이 있을 경우 Replace해서 실행
--          -->  in_USE_BIND_REPLACE_YN   := 'N';     BIND Value Replace 기능은 사용하지 않음 (ILM_IRPMSPT_BIND_INFO에 Replace대상 Bind변수가 등록이 되어 있어도 사용하지 않고 Original 수집된 Bind값 사용)
--          -->  in_LOAD_TEST_YN          := 'Y';     부하 발생기로 Start/Stop할 떄까지 계속 실행
--          -->  in_LOAD_PROC_TYPE        := 'C';     부하발생기는 SQL_ID를 동시(Concurrently)에 여러 Process에서 동시 실행하도록 설덩 ('O'일 경우는 Only One - 한 시점에 1개의 Process만 특정 SQL_ID를 실행
--          -->  참고) ILM_IRPMSPT_BIND_LIST에 Bind변수 List들이 등록이 돠어 있고 ILM_IRPMSPT_BIND_INFO.LOAD_PROC_TYPE 에 따라 (S,R,N) S:SEQUENCE 1~MAX~1~, R:RANDOM SEQ (MIN ~ MAX), N:Not Used 
--                    Bind변수가 바뀌면서 실행될 수 있음. 즉 ILM_IRPMSPT_BIND_LIST Table은 부하발생기의 총알 Table임                        
-- ======================================================================================================================================

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
    --   in_USE_QUERY_RESULT_CHK                   : Query Result 비교목적 DBMS_SQLHASH를 이용한 SQL결과 저장 
    --   in_USE_QUERY_RESULT_LOG                   : Query Result 비교목적 DBMS_SQLHASH를 이용한 RUN SQL Logging in ILM_IRPMSPT_DIGITALSLOG    
    --   in_USE_QUERY_RESULT_ROWLIMIT              : SQL Query Result Return Row Check Limit (0-All Rows, n-First n Rows)
    --   in_PREFETCH_COUNT                         : Select Query Prefetch Count, PREFETCH_COUNT = -1 (1 ROW FETCH) , FETCH_COUNT = 0 (계산된 FETCH) , FETCH_COUNT > 0  : (FIXED FETCH) 
    --   in_USE_SQL_COMMENT                        : SQL COMMENT Usage in SPT SQL, Attach Comment in Oraginal SQL    
    -- =======================================================================================================================================================
    
    in_LICENSE_KEY           := 'cLmVj83ycCv7eCsH3KsgfQ==';              -- iRPM_SPT License Key
    in_SPT_LOGTBL_OWNER      := sys_context('USERENV', 'SESSION_USER');  -- ILM_IRPMSPT_LOG_WORK Table Owner
    in_SPT_LOGTBL_NAME       := 'ILM_IRPMSPT_LOG_WORK';                  -- ILM_IRPMSPT_LOG_WORK 고정, 변경 불가 
    in_SPT_WORKTBL_OWNER     := sys_context('USERENV', 'SESSION_USER');  -- WORK Table의 OWNER
    in_SPT_WORKTBL_NAME      := 'ILM_IRPMSPT_RUN';                       -- WORK Table Name (사용자 지정 Table, 조정 가능)
    in_STS_OWNER             := sys_context('USERENV', 'SESSION_USER');  -- STS일경우 STS Staging Table의 OWNER
    in_STS_TABLE_NAME        := 'ILM_IRPMSPT_SQLSET_STAGE';              -- STS일경우 STS Staging Table (사용자 지정 Table, 조정 가능)  
    in_AWR_SQLTARGET_DAYS    := 14;                                      -- AWR일 경우 현재로 부터 지정된 일자 전까지의 SQL을 대상으로 수집 , STS는 무시
    in_AWR_STARTDT           := TRIM(TO_CHAR(SYSDATE - 14,'YYYY-MM-DD'));-- AWR일 경우 AWR START DATE - YYYY-MM-DD Format
    in_AWR_ENDDT             := TRIM(TO_CHAR(SYSDATE     ,'YYYY-MM-DD'));-- AWR일 경우 AWR END DATE - YYYY-MM-DD Format 
    
    in_JOB_CODE              := 'LOAD_TEST';                             -- JOB을 구별하기 위한 고유 STRING, MAX (15 Bytes)      
    in_RUN_SOURCE            := 'STS';                                   -- 'STS' or 'AWR' (Reserved KEY로 STS 또는 AWR이어야 함) 
    in_DESCRIPTION           := 'LOAD_TEST';                             -- JOB Description
    in_PARALLEL_PROC         := 3;                                       -- Parallel Process (동시 처리를 위한 병렬도) 
    in_RUN_NODE_LIST         := NULL;                                    -- RAC Node에서 특별히 지정된 Node LIst에서 실행하도록 설정, RAC Node번호 (NULL-현재 접속 Node에서만 실행, '1,2,3' - 1 -> 2 -> 3번 Node에서 Round robin방식으로 실행, Main Control은 첫번쨰 지정 Node)
    in_RUN_SQL_TIMEOUT       := 0;                                       -- SQL 실행 Timeout (Sec)
    in_RUN_REMAP_STRING      := NULL;                                    -- REMAP STring : 'EMP:EMP_$T,DEPT:DEPT_$T,EMP_PK:EMP_PK_$T'
    in_RUN_REPLACE_SYSDATE   := NULL;                                    -- SYSDATE, SYSTIMESTAMP를 지정한 날짜로 변경하여 실행 (FORMAT : YYYYMMDDHH24MISS)
    in_RUN_NLS_DATE_FORMAT   := 'YYYY-MM-DD HH24:MI:SS';                 -- SQL들이 날짜 Type에 대해 String으로 지정할 경우 사용될 Date Format, NULL --> 'YYYY-MM-DD HH24:MI:SS'
    in_RUN_PRE_SQL           := NULL;                                    -- 위의 설명과 같이 SQL실행전 환경 설정을 위한 Pre SQL
    in_RUN_POST_SQL          := NULL;                                    -- Post SQL, ;로 구분한 여러 SQL문장 
    in_PRE_PLAN_COMPARE_YN   := 'N';                                     -- Repository의 수집 SQL과 PLAN (EXPLAIN PLAN)비교 후 같은 PLAN여부 확인 Y/N, Y일 경우 PLAN비교 
    in_PLAN_COMP_CHK_RUN_YN  := 'Y';                                     -- Repository의 수집 SQL과 PLAN (EXPLAIN PLAN)비교 후 다를 경우 SPT로 SQL실행 여부 Y/N, N일 경우 PLAN만 비교  
                             
    in_USE_SQL_REPLACE_YN    := 'Y';                                     -- EPLACE SQL_TEXT to 튜닝 SQL_TEXT on ILM_IRPMSPT_SQL_REPLACE Table  
    in_USE_BIND_REPLACE_YN   := 'N';                                     -- BIND Value Replace Y/N
    
    in_LOAD_TEST_YN          := 'Y';                                     -- SPT Load Test Y or N
    in_LOAD_PROC_TYPE        := 'C';                                     -- C or O : C(sql_id에 한시점에 여러 Process들이 동시 실행가능, Timeout가능 사용불가),O(sql_id에 한 시점에 한개의 Process만 실행가능, Timeout기능 가능)
    in_LOAD_PROC_THINKTIME   := NULL;                                    -- 부하발생시 Thinktime (Sleeptime between SQLs) 1/100초 단위 (0.01 ~ ) 단위 초 
    
    in_USE_QUERY_RESULT_CHK  := 'N';                                     -- Query Result 비교목적 DBMS_SQLHASH를 이용한 SQL결과 저장 
    in_USE_QUERY_RESULT_LOG  := 'N';                                     -- Query Result 비교목적 DBMS_SQLHASH를 이용한 RUN SQL Logging in ILM_IRPMSPT_DIGITALSLOG
    in_USE_QUERY_RESULT_ROWLIMIT := 0;                                   -- Query Result 비교목적 Result결과의 HASH처리 LIMIT (100000 ROW 이상일 경우 시간이 늘어남, 10만 ROW일 경우 1분정도 소요)
    
    in_PREFETCH_COUNT        := -1 ;                                     -- Select Query Prefetch Count, PREFETCH_COUNT = -1 (1 ROW FETCH) , FETCH_COUNT = 0 (계산된 FETCH) , FETCH_COUNT > 0  : (FIXED FETCH)
    in_USE_SQL_COMMENT       := 'Y';                                     -- SQL에 Comment를 붙여 실행 (고유한 실행 목적, COMMENT제거('N')일 경우 SQL Plan Baseline, SQL Profile적용 후 사용여부 Check목적         
    -- -----------------------------------------------------------------------------------------------------------------------------------------
    -- Table 구조분석을 위한 OWNER.TABLE_NAME에 속한 SQL문장들만 찾아서 SPT를 싱행하기 위해서 아래 설정
    -- Migration과 환경을 위한 전체 SQL SPT실행을 위해서는 in_TABLE_OWNER, in_TABLE_NAME NULL 지정
    -- -----------------------------------------------------------------------------------------------------------------------------------------
    in_TABLE_OWNER           := 'SOE';                                   -- AWR, STS 대상에서 특별히 지정된 TABLE을 찿고자 할 경우 , OWNER 
    in_TABLE_NAME            := 'ORDERS';                                -- AWR, STS 대상에서 특별히 지정된 TABLE을 찿고자 할 경우 , TABLE_NAME 
    
    IF in_RUN_SOURCE = 'STS' AND in_TABLE_OWNER IS NOT NULL AND in_TABLE_NAME IS NOT NULL THEN   -- OWNER,TABLE_NAME이 지정된 경우 해당 Table의 Object들을 참조하는 SQL문장들만 추출
       in_TABLE_OWNER := TRIM(in_TABLE_OWNER);
       in_TABLE_NAME  := TRIM(in_TABLE_NAME);
       
       in_PREDICATE :=' AND COMMAND_TYPE IN (2,3,6,7,189) ' || 
                      ' AND PARSING_SCHEMA_NAME NOT IN (''APEX_030200'',''CTXSYS'',''DBSNMP'',''EXFSYS'',''MAXGAUGE'',''MDSYS'',''ORACLE_OCM'',
                                                        ''STRMADMIN'',''SYS'',''SYSTEM'',''WMSYS'') ' ||
                      ' AND (NAME , OWNER, SQL_ID) IN   
                        (select /*+ UNNEST QB_NAME(SUB1) HASH_SJ */ distinct NAME , OWNER, SQL_ID FROM (select NAME , OWNER, SQL_ID
                         from   ' || in_STS_TABLE_NAME || '  where  (plan_object_owner , plan_object_name)  in
                                (select ''' || in_TABLE_OWNER || ''' object_owner, ''' || in_TABLE_NAME || ''' object_name from dual union all
                                 select owner object_owner, index_name object_name from dba_indexes
                                 where table_owner = ''' || in_TABLE_OWNER || ''' and table_name = ''' || in_TABLE_NAME || ''')
                       /* -----------------------------------------------------------------------------------------------------
                         union all  select NAME , OWNER, SQL_ID  from   ' || in_STS_TABLE_NAME || '
                         where  COMMAND_TYPE = 2 and REGEXP_INSTR(upper(SQL_TEXT), ''[^[:alpha:]]INTO[^[:alpha:]]+'' || ''' || 
                         in_TABLE_NAME || ''' || ''\W'' ) > 1  
                       -------------------------------------------------------------------------------------------------------*/
                         )) '  ;
    ELSE
       in_PREDICATE :=' AND COMMAND_TYPE IN (2,3,6,7,189) ' || 
                      ' AND PARSING_SCHEMA_NAME NOT IN (''APEX_030200'',''CTXSYS'',''DBSNMP'',''EXFSYS'',''MAXGAUGE'',''MDSYS'',''ORACLE_OCM'',
                                                        ''STRMADMIN'',''SYS'',''SYSTEM'',''WMSYS'') '   ;
    END IF;
    -- -----------------------------------------------------------------------------------------------------------------------------------------
    
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
    --END LOOP;
    -- 기존 Running Job이 있다면 DROP Job -------------------------------------------------------------------------------
    
    IRPM_SPT.INIT(in_LICENSE_KEY); 

    -- STEP 3: MAIN IRPM SPT Play(SQL Run)를 위한 초기 구성  -------------------------------------------------------------
    IF in_RUN_SOURCE = 'STS' THEN
        IRPM_SPT.SPT_INIT_FROM_STS(in_SPT_WORKTBL_OWNER,in_SPT_WORKTBL_NAME,in_JOB_CODE, in_STS_OWNER, in_STS_TABLE_NAME, out_RUN_NAME ,in_PREDICATE );
    ELSIF in_RUN_SOURCE = 'AWR' THEN         
        --in_AWR_SQLTARGET_DAYS로 지정할 경우  
        --IRPM_SPT.SPT_INIT_FROM_AWR(in_SPT_WORKTBL_OWNER,in_SPT_WORKTBL_NAME,in_JOB_CODE, in_AWR_SQLTARGET_DAYS, out_RUN_NAME ,in_PREDICATE );   
        IF in_TABLE_OWNER IS NOT NULL AND in_TABLE_NAME IS NOT NULL THEN 
           IRPM_SPT.SPT_INIT_FROM_AWR2(in_SPT_WORKTBL_OWNER, in_SPT_WORKTBL_NAME, in_JOB_CODE,  in_AWR_STARTDT, in_AWR_ENDDT, NULL , out_RUN_NAME  , in_PREDICATE )  ;    
        ELSE
           IRPM_SPT.SPT_INIT_FROM_AWR2(in_SPT_WORKTBL_OWNER, in_SPT_WORKTBL_NAME, in_JOB_CODE,  in_AWR_STARTDT, in_AWR_ENDDT, in_TABLE_OWNER || '.' || in_TABLE_NAME , out_RUN_NAME  , in_PREDICATE )  ; 
        END IF; 
    END IF;         
    -- MAIN IRPM SPT Play(SQL Run)를 위한 초기 구성  ---------------------------------------------------------------------
    
    
    -- STEP 4: RUN Configuration (ILM_IRPMSPT_RUNINFO Table에 등록)----------------------------------------------------
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
        -- iRPM_SPT.SPT_LOAD_START (out_RUN_NAME, in_RUN_SOURCE, SYSDATE + 1/(24*60) , SYSDATE + 11/(24*60) ); 
    ELSE
        IRPM_SPT.SPT_START_JOB(in_SPT_WORKTBL_OWNER,in_SPT_WORKTBL_NAME,in_JOB_CODE, in_STS_OWNER, in_STS_TABLE_NAME, out_RUN_NAME, in_RUN_SOURCE, in_PARALLEL_PROC, in_RUN_NODE_LIST);
    END IF;
 
    
    DBMS_OUTPUT.PUT_LINE(out_RUN_NAME);
END;
/

 
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



--RUN_NAME                  RUN_SOURCE  Run Type     Description    Run Status  Job Start Date       Job End Date         Target SQL Cnt   Finished SQL Cnt    Rest SQL Cnt    Progress %    Running SQL Cnt    Not Run Yet    Timeout SQL Cnt  Error SQL Cnt  Skip SQL Cnt   Run OK Cnt   Total Runned SQL Cnt   Load Duration(Sec)   TPS	   ...
--------------------------- ----------- ------------ -------------- ----------- -------------------- -------------------- ---------------- ------------------- --------------- ------------- ------------------ -------------- ---------------- -------------- -------------- ------------ ---------------------- -------------------- ------
--LOAD_TEST_20190824213445  STS         Load Tester  LOAD_TEST      Running...											...



-- =============================================================================================================================================
-- 부하발생기 JOB Start  : 위에서 나온 가장 처음 대상의 RUN_NAME이 START대상임 (START를 하지 않으면 SQL이 실행 안됨 - 부하 START)
--    아래 'LOAD_TEST_20190824213445'은 RUN_NAME으로 바꿔줘야 함
--    다음은 1분 뒤에 START하여 11분 뒤에 끝나도록 설정 (10분간 부하 발생 예)
-- =============================================================================================================================================
BEGIN iRPM_SPT.SPT_LOAD_START ('LOAD_TEST_20190824213445', 'STS', SYSDATE + 1/(24*60) , SYSDATE + 11/(24*60) ,'N' ); END;
/
 

-- =============================================================================================================================================
-- 부하발생기 진행상태 확인
-- =============================================================================================================================================
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


--RUN_NAME                  RUN_SOURCE  Run Type     Description    Run Status  Job Start Date       Job End Date         Target SQL Cnt   Finished SQL Cnt    Rest SQL Cnt    Progress %    Running SQL Cnt    Not Run Yet    Timeout SQL Cnt  Error SQL Cnt  Skip SQL Cnt   Run OK Cnt   Total Runned SQL Cnt   Load Duration(Sec)   TPS	   ...
--------------------------- ----------- ------------ -------------- ----------- -------------------- -------------------- ---------------- ------------------- --------------- ------------- ------------------ -------------- ---------------- -------------- -------------- ------------ ---------------------- -------------------- ------
--LOAD_TEST_20190824213445  STS         Load Tester  LOAD_TEST      Running...  2019/08/24 21:34:58                       123              82                  122             66.7          0                  122            0                1              0              81           82                     7                    11.71  ...


-- =============================================================================================================================================
-- 부하발생기 JOB Stop  : 아래 'LOAD_TEST_20190818231254'은 RUN_NAME으로 바꿔줘야 함 
-- =============================================================================================================================================
--BEGIN iRPM_SPT.SPT_LOAD_STOP ('LOAD_TEST_20190818231254', 'STS'); END;
--/


-- =============================================================================================================================================
-- 부하발생기 완료상태 확인
-- =============================================================================================================================================
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


--RUN_NAME                  RUN_SOURCE  Run Type     Description    Run Status  Job Start Date       Job End Date         Target SQL Cnt   Finished SQL Cnt    Rest SQL Cnt    Progress %    Running SQL Cnt    Not Run Yet    Timeout SQL Cnt  Error SQL Cnt  Skip SQL Cnt   Run OK Cnt   Total Runned SQL Cnt   Load Duration(Sec)   TPS	   ...
--------------------------- ----------- ------------ -------------- ----------- -------------------- -------------------- ---------------- ------------------- --------------- ------------- ------------------ -------------- ---------------- -------------- -------------- ------------ ---------------------- -------------------- ------
--LOAD_TEST_20190824213445  STS         Load Tester  LOAD_TEST      Finished	2019/08/24 21:34:58  2019/08/24 21:45:04  123              31354               121             25491.1       0                  121            0                2              0              31352        31354                  606                  51.74


--==> 이 상태는 3개의 Process로 전체SQL 123개중 2개 Error발생, 나머지 121개의 SQL문장을 606초 동안 여러번 반복 실행하여 전체 31354 SQL을 실행했음. 결과적으로 51.74 TPS로 처리되었음 


-- =============================================================================================================================================
-- 개별 SQL별로 실행정보 확인
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
       A.* ,'#####' SEP,
       B.*
FROM ILM_IRPMSPT_RUN A, ILM_IRPMSPT_SQLSET_STAGE B
WHERE B.ROWID = COALESCE(STS_ROWID,AWR_ROWID) 
 AND  B.PARSING_SCHEMA_NAME IS NOT NULL
 AND  A.RUN_NAME   = NVL((SELECT RUN_NAME FROM MY_INPUT),(SELECT RUN_NAME FROM LAST_JOB)) 
 AND  A.RUN_SOURCE LIKE NVL((SELECT RUN_SOURCE FROM MY_INPUT),(SELECT RUN_SOURCE FROM LAST_JOB)) || '%'
  -- AND RUN_PROC_YN IN ('P','N')
  -- AND RUN_PROC_YN IN ('Y')
  -- AND RUN_PROC_YN IN ('T','S','E')
ORDER BY RUN_ORDER;



-- =============================================================================================================================================
-- DB성증정보 확인
-- =============================================================================================================================================
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
 
 
--INST_ID    Snaptime           Host CPU Utilization (%)   Logical Reads Per Sec   Physical Reads Per Sec  Executions Per Sec  User Transaction Per Sec   Session Count
------------ ------------------ -------------------------- ----------------------- ----------------------- ------------------- -------------------------- ---------------
--1          2019-08-24 21:46	70.3                       77133.4                 9.3                     165.2               39.1                       101
--1          2019-08-24 21:48   99.8                       193256                  6.3                     403.6               100.7                      101
--1          2019-08-24 21:51   99.6                       224743.2                711.9                   783.9               110.1                      104
--1          2019-08-24 21:50   99.6                       239625.5                195                     547.1               133.8                      103
--1          2019-08-24 21:49   99.7                       225474.7                100.5                   492.9               122.3                      101
--1          2019-08-24 21:47   99.8                       181246                  9.7                     403.6               95.8                       101



-- =============================================================================================================================================
-- (Option) 다음은 BIND 변수를 Replace기능을 이용하여 변경 후 실행할 경우 Replace Table에 초기화 하는 절차
--  1. 변경할 대상 SQL의 Bind변수 값을 확인한다.
--  2. iRPM_SPT.SETUP_BINDINFO Procedure로 ILM_IRPMSPT_BIND_INFO Table로 수집된 Bind변수 초기화 INSERT해 줌
--  3. ILM_IRPMSPT_BIND_INFO Table에서 확인
--  4. BIND_VALUE_LIST 컬럼을 변경(UPDATE)하여 Bind 변수 값 변경 (|문자 구분자,BIND_NAME_LIST 순서로 연결문자 )
-- =============================================================================================================================================
SELECT * FROM TABLE(SELECT  DBMS_SQLTUNE.EXTRACT_BINDS(BIND_DATA)  
FROM ILM_IRPMSPT_SQLSET_STAGE a
WHERE SQL_ID = '7t0959msvyt5g' and PARSING_SCHEMA_NAME IS NOT NULL);
;

DECLARE
  out_BIND_NAME VARCHAR2(4000);
  out_BIND_VALUE VARCHAR2(4000);
BEGIN
   iRPM_SPT.SETUP_BINDINFO('IRPMSPT','ILM_IRPMSPT_SQLSET_STAGE','7t0959msvyt5g','Y',out_BIND_NAME,out_BIND_VALUE) ;
   DBMS_OUTPUT.PUT_LINE(out_BIND_NAME);
   DBMS_OUTPUT.PUT_LINE(out_BIND_VALUE);
END;
/

SELECT * 
FROM ILM_IRPMSPT_BIND_INFO ;

--SQL_ID	    USE_YN	DESCRIPTION	        BIND_NAME_LIST	BIND_VALUE_LIST	LOAD_PROC_TYPE	LOAD_PROC_MIN	LOAD_PROC_MAX	LOAD_PROC_CURR
--------------- ------- ------------------- --------------- --------------- --------------- --------------- --------------- ---------------
--7t0959msvyt5g	Y	    iRPM System Setup	:B2|:B1	        562599|38	    N

-- =============================================================================================================================================