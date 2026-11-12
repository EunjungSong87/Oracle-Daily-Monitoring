-- ========================================================================================================================
-- 0103.LOAD_TEST_UPDATE.sql 
-- [SCRIPT 0103 : LOAD TEST UPDATE Sample ]
-- 
-- Update 처리 부하TEST 
--    --> N개의 동시 프로세서에 의한 Source Table의 Data를 균등 분배로 읽어서 Target Table에 동시 Update처리 TEST 
--        Update문제의 성능 개선을 위한 Partition등 구조 조정의 효과 분석을 위한 TEST
--        job queue process는 충분히 설정 
--        select inst_id, value from gv$parameter where name = 'job_queue_processes' order by inst_id;
--   
--        Source Table과 Target Table은 같아도 됨
--
--        +----------------+  ----->  P1 -------------->   +----------------+
--        |                |  ----->  P2 -------------->   |                |
--        | Source Table   |  ----->  P3 -------------->   | Target Table   |
--        |                |  ----->  ...-------------->   |                |
--        +----------------+  ----->  Pn -------------->   +----------------+
--                                              
-- ========================================================================================================================

 

DECLARE
    v_SELECT_COL_LIST        VARCHAR2(32000);
    v_UPDATE_COL_LIST        VARCHAR2(32000);
    
    v_code                   NUMBER;
    v_errm                   VARCHAR2(2048); 
    v_COL_POSITION           NUMBER;
    ii                       NUMBER;
    v_RUN_JOB_STRING         VARCHAR2(32000);
    v_RUN_JOB_STRING2        VARCHAR2(32000);
    TYPE REMAP_ARRAY         IS TABLE OF VARCHAR2(1000) INDEX BY PLS_INTEGER;
    v_REMAP_SOURCE           REMAP_ARRAY;
    v_REMAP_TARGET           REMAP_ARRAY;
    v_REMAP_COUNT            NUMBER;  
    in_RUN_REMAP_STRING      VARCHAR2(32000);
    fromVal                  VARCHAR2(4000);
    toVal                    VARCHAR2(4000);
    TempItem                 VARCHAR2(4000);
    v_RUN_START_DATE         DATE;
    v_FIND_FLAG              BOOLEAN;
    
    v_PK_COLUMNS             VARCHAR2(4000);
    v_PK_COLUMNS_LIST        REMAP_ARRAY;
    v_PK_COLUMNS_COUNT       NUMBER;  
    v_UPD_WHERE_PREDICATE    VARCHAR2(4000);
    
    in_RUN_NODE              NUMBER;
    in_RAC_NODES             NUMBER;
    in_RUN_TIME_LIMIT        NUMBER;
    in_LOAD_PROC_THINKTIME   NUMBER;
    in_SRC_OWNER             VARCHAR2(256) ; 
    in_SRC_TABLE_NAME        VARCHAR2(256) ; 
    in_TGT_OWNER             VARCHAR2(256) ; 
    in_TGT_TABLE_NAME        VARCHAR2(256) ; 
    in_FILTER_PREDICATE      VARCHAR2(4000);
    in_COMMIT_COUNT          NUMBER;
    in_RUN_PROCESS_COUNT     NUMBER;   
    in_RUN_START_TIME        VARCHAR2(20);
BEGIN 
    
    -- =======================================================================================================================================
    -- 아래 Input 변수를 수정하여 실행
    -- =======================================================================================================================================
    in_SRC_OWNER            := 'SOE';                       -- INSERT처리를 위한 Source Table의 Owner
    in_SRC_TABLE_NAME       := 'ORDERS_TEST2';                    -- INSERT처리를 위한 Source Table Name
    in_TGT_OWNER            := 'SOE';                       -- INSERT처리를 위한 Insert대상 Table Owner  
    in_TGT_TABLE_NAME       := 'ORDERS_TEST2';              -- INSERT처리를 위한 Insert대상 Table Name
                    
    in_RUN_REMAP_STRING     := 'ORDER_DATE:SYSTIMESTAMP';   -- SOR:TGT^SRC:TGT              
    in_FILTER_PREDICATE     := ' ';                         -- Sample : ' AND ... ';
                                                           
    in_COMMIT_COUNT         := 1;                           -- Commit단위 

    in_LOAD_PROC_THINKTIME  := 0.01;                        -- Think Time, 0.01 ~, 0.001(ms)단위 처리를 위해서는 IRPM_SPT_UTIL를 먼저 생성 후 처리     
    in_RAC_NODES            := 2;                           -- RAC Total Node Count 
    in_RUN_NODE             := 0;                           -- 0: ROUND , N: Fixed Node 
    in_RUN_TIME_LIMIT       := 10;                          -- 전체 실행시간(분) 
    in_RUN_PROCESS_COUNT    := 10;                          -- 전체 실행 Process수    
    in_RUN_START_TIME       := 'SYSDATE';                   -- NULL,'SYSDATE'일 경우 SYSDATE, 특정시간 'YYYY-MM-DD HH24:MI:SS' Format   
    -- =======================================================================================================================================

    
    v_RUN_JOB_STRING := 'DECLARE                                                                        ' || CHR(10) ||  
                        '    v_CNT                 NUMBER;                                              ' || CHR(10) ||
                        '    v_START_TIME          NUMBER;                                              ' || CHR(10) ||
                        '    v_TIME_LIMIT          NUMBER := @@TMLIMIT_MM@@*60*100;                     ' || CHR(10) ||
                        'BEGIN                                                                          ' || CHR(10) ||
                        '    v_CNT := 0;                                                                ' || CHR(10) ||
                        '    v_START_TIME := dbms_utility.get_time();                                   ' || CHR(10) ||
                        '                                                                               ' || CHR(10) ||
                        '    FOR CUR IN (                                                               ' || CHR(10) ||
                        '       SELECT   @@COLUMN_LIST@@                                                ' || CHR(10) ||
                        '       FROM     @@OWNER@@.@@TABLE_NAME@@                                       ' || CHR(10) ||
                        '       WHERE   1=1 and ORA_HASH(ROWID, @@PROC_CNT@@ -1, 0) = (@@MY_PROC@@ -1)  ' || CHR(10) ||
                        '                 @@WHERE_PREDICATE@@    )                                      ' || CHR(10) ||
                        '    LOOP                                                                       ' || CHR(10) ||
                        '       UPDATE @@TOWNER@@.@@TTABLE_NAME@@ A                                     ' || CHR(10) ||
                        '       SET    @@UPDATE_COL_LIST@@                                              ' || CHR(10) ||
                        '       WHERE  @@UPD_WHERE_PREDICATE@@  ;                                       ' || CHR(10) ||
                        '                                                                               ' || CHR(10) ||
                        '       v_CNT := v_CNT + 1;                                                     ' || CHR(10) ||
                        '       IF  (@@COMMIT_CNT@@ = 1 OR MOD(v_CNT,@@COMMIT_CNT@@) = 0) THEN          ' || CHR(10) ||
                        '           COMMIT;                                                             ' || CHR(10) ||
                        '           IF v_TIME_LIMIT > 0 AND ((dbms_utility.get_time() - v_START_TIME) >= v_TIME_LIMIT) THEN    ' || CHR(10) ||
                        '              GOTO FINISH_TIME_LIMIT;                                          ' || CHR(10) ||
                        '           END IF;                                                             ' || CHR(10) ||
                        '       END IF;                                                                 ' || CHR(10) ||
                        '       @@THINKTIME_DEF@@                                                       ' || CHR(10) ||
                        '    END LOOP;                                                                  ' || CHR(10) ||
                        '<<FINISH_TIME_LIMIT>>                                                          ' || CHR(10) ||
                        '    RETURN;                                                                    ' || CHR(10) ||
                        '    EXCEPTION WHEN OTHERS THEN RETURN;                                         ' || CHR(10) ||
                        'END;'; 
                  

    dbms_output.enable(NULL); 

    -- -----------------------------------------------------------------------
    -- PK/UK Column Get 
    -- ----------------------------------------------------------------------- 
    v_PK_COLUMNS_COUNT    := 0;
    v_UPD_WHERE_PREDICATE := '';
    
    FOR CUR IN (
        select a.column_position,a.column_name, decode(DESCEND,'DESC',DESCEND,' ') DESCEND, b.column_expression
        from (SELECT TABLE_OWNER,TABLE_NAME,INDEX_OWNER,INDEX_NAME 
            FROM (select OWNER TABLE_OWNER,TABLE_NAME,INDEX_OWNER,INDEX_NAME 
                    from dba_constraints 
                    where owner = in_TGT_OWNER and table_name = in_TGT_TABLE_NAME and CONSTRAINT_TYPE in ('P','U') 
                    order by CONSTRAINT_TYPE)
            WHERE ROWNUM <=1 ) V1,
           sys.dba_ind_columns a, dba_ind_expressions b
        where 1=1 and
            a.index_owner=V1.index_owner and a.index_name =V1.index_name and
            a.table_owner=V1.Table_owner and a.table_name =V1.table_name and
            a.index_owner=b.index_owner(+) and a.index_name =b.index_name(+) and
            a.table_owner=b.table_owner(+) and a.table_name =b.table_name(+) and
            a.column_position = b.column_position(+)                
        order by a.column_position
    )
    LOOP
      v_PK_COLUMNS_COUNT := v_PK_COLUMNS_COUNT + 1; 
      v_PK_COLUMNS_LIST(v_PK_COLUMNS_COUNT) := CASE WHEN CUR.column_expression IS NULL THEN  CUR.column_name ELSE trim(replace(replace(substr(CUR.column_expression,1,4000),chr(10),' '),chr(9), ' ')) END;
      if v_PK_COLUMNS is null then
         v_PK_COLUMNS := CASE WHEN CUR.column_expression IS NULL THEN  CUR.column_name ELSE trim(replace(replace(substr(CUR.column_expression,1,4000),chr(10),' '),chr(9), ' ')) END ;
         v_UPD_WHERE_PREDICATE := CUR.COLUMN_NAME || ' = CUR.' || CUR.COLUMN_NAME;
      else
         v_PK_COLUMNS := v_PK_COLUMNS || ', ' || CASE WHEN CUR.column_expression IS NULL THEN CUR.column_name ELSE trim(replace(replace(substr(CUR.column_expression,1,4000),chr(10),' '),chr(9), ' ')) END ;
         v_UPD_WHERE_PREDICATE := v_UPD_WHERE_PREDICATE || ' AND ' || CUR.COLUMN_NAME || ' = CUR.' || CUR.COLUMN_NAME;
      end if;
      --dbms_output.put_line(v_PK_COLUMNS);
    END LOOP;
  
    -- -----------------------------------------------------------------------
    -- Column Get
    -- ----------------------------------------------------------------------- 
    v_COL_POSITION    := 0;
    v_UPDATE_COL_LIST := NULL;
    FOR CUR IN (
        select COLUMN_ID, column_name   COL_NAME
        from sys.dba_tab_columns
        where owner=in_SRC_OWNER and table_name =in_SRC_TABLE_NAME 
        order by COLUMN_ID
    )
    LOOP
        v_COL_POSITION := v_COL_POSITION + 1;
        IF (v_COL_POSITION = 1) THEN
           v_SELECT_COL_LIST :=  CUR.COL_NAME;
        ELSE
           v_SELECT_COL_LIST := v_SELECT_COL_LIST || CASE WHEN MOD(v_COL_POSITION,6) = 0 THEN chr(10) || RPAD(' ',14,' ')  ELSE '' END || ', ' ||   CUR.COL_NAME ;
        END IF;    
        v_FIND_FLAG := FALSE;
        FOR ii IN 1..v_PK_COLUMNS_COUNT LOOP
            IF v_PK_COLUMNS_LIST(ii) = CUR.COL_NAME THEN v_FIND_FLAG := TRUE; END IF; 
        END LOOP; 
        IF NOT v_FIND_FLAG THEN
            v_UPDATE_COL_LIST := CASE WHEN  v_UPDATE_COL_LIST IS NULL THEN '' ELSE  v_UPDATE_COL_LIST || ', ' END  || CASE WHEN MOD(v_COL_POSITION,6) = 0 THEN chr(10) || RPAD(' ',14,' ')  ELSE '' END || CUR.COL_NAME || ' = CUR.' ||   CUR.COL_NAME ;
        END IF;
    END LOOP;
      
      
    -- REMAP Process [START  ] --------------------------------------------------------------------------------------------              
    v_REMAP_COUNT := 0 ;
    
    IF in_RUN_REMAP_STRING IS NULL OR TRIM(in_RUN_REMAP_STRING) = '' THEN
       v_REMAP_COUNT := 0 ;
    ELSE
        WHILE   (INSTR(in_RUN_REMAP_STRING,'^') <> 0 ) LOOP
            v_REMAP_COUNT  := v_REMAP_COUNT + 1;
            TempItem       := trim(substr(in_RUN_REMAP_STRING,1, INSTR(in_RUN_REMAP_STRING,'^') -1));
            fromVal        := trim(substr(TempItem,1, INSTR(TempItem,':') -1));
            toVal          := ltrim(substr(TempItem,INSTR(TempItem,':') +1));
            in_RUN_REMAP_STRING  := ltrim(substr(in_RUN_REMAP_STRING,INSTR(in_RUN_REMAP_STRING,'^') +1));
            v_REMAP_SOURCE(v_REMAP_COUNT) := fromVal;
            v_REMAP_TARGET(v_REMAP_COUNT) := toVal;
        END LOOP;
        
        IF (INSTR(in_RUN_REMAP_STRING,':') <> 0 ) THEN
            v_REMAP_COUNT  := v_REMAP_COUNT + 1;
            fromVal        := trim(substr(in_RUN_REMAP_STRING,1, INSTR(in_RUN_REMAP_STRING,':') -1));
            toVal          := ltrim(substr(in_RUN_REMAP_STRING,INSTR(in_RUN_REMAP_STRING,':') +1));
            v_REMAP_SOURCE(v_REMAP_COUNT) := fromVal;
            v_REMAP_TARGET(v_REMAP_COUNT) := toVal;
        END IF;
    END IF; 
 
    BEGIN
      FOR ii IN 1..v_REMAP_COUNT LOOP
         v_UPDATE_COL_LIST := REPLACE(v_UPDATE_COL_LIST,'CUR.' || v_REMAP_SOURCE(ii),v_REMAP_TARGET(ii)); 
      END LOOP;   
      EXCEPTION WHEN OTHERS THEN NULL;  
    END;
    -- REMAP Process [END  ] --------------------------------------------------------------------------------------------
    
    -- -----------------------------------------------------------------------
    -- in_LOAD_PROC_THINKTIME CHANGE
    -- -----------------------------------------------------------------------
    IF in_LOAD_PROC_THINKTIME >  0 AND in_LOAD_PROC_THINKTIME < 0.01 THEN
       v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@THINKTIME_DEF@@', 'EXECUTE IMMEDIATE ''CALL IRPM_SPT_UTIL.sleep(' || in_LOAD_PROC_THINKTIME || ' * 1000);' );
    ELSIF in_LOAD_PROC_THINKTIME >  0 AND in_LOAD_PROC_THINKTIME >= 0.01 THEN
       v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@THINKTIME_DEF@@', 'DBMS_LOCK.SLEEP(' || in_LOAD_PROC_THINKTIME || ');' );        
    ELSE
       v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@THINKTIME_DEF@@', ' ' );        
    END IF;
           
    -- -----------------------------------------------------------------------
    -- OWNER, TABLE Define
    -- -----------------------------------------------------------------------
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@OWNER@@'       , in_SRC_OWNER);
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@TOWNER@@'      , in_TGT_OWNER);
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@TABLE_NAME@@'  , in_SRC_TABLE_NAME);
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@TTABLE_NAME@@' , in_TGT_TABLE_NAME);
    
    -- -----------------------------------------------------------------------
    -- OWNER, TABLE Define
    -- -----------------------------------------------------------------------
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@COMMIT_CNT@@'  , in_COMMIT_COUNT);
    
    -- -----------------------------------------------------------------------
    -- RUN Time Limit
    -- -----------------------------------------------------------------------
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@TMLIMIT_MM@@'  , in_RUN_TIME_LIMIT);
    
    -- -----------------------------------------------------------------------
    -- WHERE PREDICATE
    -- -----------------------------------------------------------------------
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@WHERE_PREDICATE@@'  , ' ' || REPLACE(in_FILTER_PREDICATE,'''','''''') || ' ');
 
    -- -----------------------------------------------------------------------
    -- RUN Time Limit
    -- -----------------------------------------------------------------------
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@PROC_CNT@@'  , in_RUN_PROCESS_COUNT);
    
    -- -----------------------------------------------------------------------
    -- Column Mapping
    -- -----------------------------------------------------------------------
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@COLUMN_LIST@@'  , v_SELECT_COL_LIST);
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@UPDATE_COL_LIST@@'  , v_UPDATE_COL_LIST);
    v_RUN_JOB_STRING := REPLACE(v_RUN_JOB_STRING, '@@UPD_WHERE_PREDICATE@@'  , v_UPD_WHERE_PREDICATE);
    
    --실행 JOB PL/SQL확인 
    --DBMS_OUTPUT.PUT_LINE (v_RUN_JOB_STRING);
    --RETURN;
 
    
    IF in_RUN_START_TIME IS NULL OR upper(trim(in_RUN_START_TIME)) = 'SYSDATE' THEN
       v_RUN_START_DATE := SYSDATE + (30/(24*60*60));
    ELSIF length(trim(in_RUN_START_TIME)) = 19 THEN
       v_RUN_START_DATE := TO_DATE(trim(in_RUN_START_TIME),'YYYY-MM-DD HH24:MI:SS');
    ELSE
       v_RUN_START_DATE := SYSDATE + (30/(24*60*60));
    END IF;   
    
    -- --------------------------------------------------------------------------------------------------- 
    -- Scheduler Job실행  
    -- --------------------------------------------------------------------------------------------------- 
    FOR ii in 1 .. in_RUN_PROCESS_COUNT loop
      BEGIN
        v_RUN_JOB_STRING2 := v_RUN_JOB_STRING;   
        v_RUN_JOB_STRING2 := REPLACE(v_RUN_JOB_STRING2, '@@MY_PROC@@'  , ii);
        --DBMS_OUTPUT.PUT_LINE (v_RUN_JOB_STRING2);
        
        dbms_scheduler.create_job(
          job_name        => 'IRPM_UTEST_' || TRIM(TO_CHAR(ii,'09'))
         ,job_type        => 'PLSQL_BLOCK'
         ,job_action      => v_RUN_JOB_STRING2
         ,start_date      => v_RUN_START_DATE
         ,enabled         => TRUE
         ,comments        => 'iRPM Update Tester for JOB_' || TRIM(TO_CHAR(ii,'09'))
        );
         
       IF in_RUN_NODE > 0 THEN  
          dbms_scheduler.set_attribute(name=>'IRPM_UTEST_' || TRIM(TO_CHAR(ii,'09')),attribute=>'instance_id', value=>in_RUN_NODE);   
       ELSIF in_RUN_NODE = 0 AND in_RAC_NODES >= 2 THEN
          dbms_scheduler.set_attribute(name=>'IRPM_UTEST_' || TRIM(TO_CHAR(ii,'09')),attribute=>'instance_id', value=>MOD(ii+1,in_RAC_NODES) + 1);   
       END IF;
       
       EXCEPTION WHEN others THEN 
           v_code := SQLCODE;
           v_errm := SQLERRM;
           DBMS_OUTPUT.PUT_LINE ('iRPM : ' || 'IRPM_UTEST_' || TRIM(TO_CHAR(ii)) || ' Run Error ('  || v_code || ': ' || v_errm);          
      END;
    END LOOP;
    
END;
/


select * from dba_scheduler_jobs where job_name like 'IRPM_UTEST%'; 
 
 
 
 
-- #############################################################################################################################################
--  
--  INSERT/UPDATE부하발생 TEST기간의 DB성능정보 Monitoring
--
--     --> "Host CPU Utilization (%)", "Logical Reads Per Sec"     ,"Physical Reads Per Sec"
--         "Executions Per Sec"      , "User Transaction Per Sec"  ,"Session Count"  
--     --> 추가 분석 항목은 수정하여 반영  
--     --> WITH MY_INPUT절의 값을 입력후 실행, 그대로 실행시 가장 최근에 시행한 JOB의 1번 Node의 DB성능 정보임
--     --> @@@@@@@@@@@@@@@@@  주의) 해당 Data는 최근 1시간 이전 성능정보만 보이므로 1시간 이내 수집 @@@@@@@@@@@@@@@@@@
--
-- #############################################################################################################################################

WITH MY_INPUT AS (
    SELECT
    --=====================================================================
    -- 아래의 3개의 값을 입력후 실행하세요~
    -- RAC 여러 Node의 DB성능정보를 확인하기 위해서는 INST_ID를 바꿔가면서 실행
    -- 성능정보 수집기간 지정
    --=====================================================================
    1                           INST_ID,
    SYSDATE - 20/(24*60)        START_TIME,
    SYSDATE                     END_TIME     
    --=====================================================================
    FROM DUAL 
)
SELECT  INST_ID
       ,TO_CHAR(BEGIN_TIME,'YYYY-MM-DD HH24:MI')  "Snaptime"   
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Host CPU Utilization (%)' , VALUE)),0),1) "Host CPU Utilization (%)"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Logical Reads Per Sec'    , VALUE)),0),1) "Logical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Physical Reads Per Sec'   , VALUE)),0),1) "Physical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Executions Per Sec'       , VALUE)),0),1) "Executions Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'User Transaction Per Sec' , VALUE)),0),1) "User Transaction Per Sec"
       ,ROUND(NVL(SUM(DECODE(METRIC_NAME,'Session Count'            , VALUE)),0),1) "Session Count"  
  FROM SYS.GV_$SYSMETRIC_HISTORY B
 WHERE 1=1 
   AND GROUP_ID   = 2 
   AND METRIC_NAME IN ('Host CPU Utilization (%)','Logical Reads Per Sec','Physical Reads Per Sec',
                       'Executions Per Sec','User Transaction Per Sec','Session Count')
   AND BEGIN_TIME BETWEEN  (SELECT START_TIME FROM MY_INPUT) AND (SELECT END_TIME FROM MY_INPUT)
   AND INST_ID = (SELECT INST_ID FROM MY_INPUT)
 GROUP BY INST_ID,TO_CHAR(BEGIN_TIME,'YYYY-MM-DD HH24:MI') 
 ORDER BY 2;
  
  
  
WITH MY_INPUT AS (
    SELECT
    --=====================================================================
    -- 아래의 3개의 값을 입력후 실행하세요~
    -- RAC 여러 Node의 DB성능정보를 확인하기 위해서는 INST_ID를 바꿔가면서 실행
    -- 성능정보 수집기간 지정
    --=====================================================================
    SYSDATE - 20/(24*60)        START_TIME,
    SYSDATE                     END_TIME     
    --=====================================================================
    FROM DUAL 
)
SELECT   
        TO_CHAR(BEGIN_TIME,'YYYY-MM-DD HH24:MI')  "Snaptime"  
        
       ,ROUND(NVL(SUM(DECODE(INST_ID,1,DECODE(METRIC_NAME,'Host CPU Utilization (%)' , VALUE,0),0)),0),1) "N1 Host CPU Utilization(%)"
       ,ROUND(NVL(SUM(DECODE(INST_ID,2,DECODE(METRIC_NAME,'Host CPU Utilization (%)' , VALUE,0),0)),0),1) "N2 Host CPU Utilization(%)"
       ,ROUND(NVL(SUM(DECODE(INST_ID,3,DECODE(METRIC_NAME,'Host CPU Utilization (%)' , VALUE,0),0)),0),1) "N3 Host CPU Utilization(%)"
       ,ROUND(NVL(SUM(DECODE(INST_ID,4,DECODE(METRIC_NAME,'Host CPU Utilization (%)' , VALUE,0),0)),0),1) "N4 Host CPU Utilization(%)"
       
       ,ROUND(NVL(SUM(DECODE(INST_ID,1,DECODE(METRIC_NAME,'Logical Reads Per Sec'    , VALUE,0),0)),0),1) "N1 Logical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,2,DECODE(METRIC_NAME,'Logical Reads Per Sec'    , VALUE,0),0)),0),1) "N2 Logical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,3,DECODE(METRIC_NAME,'Logical Reads Per Sec'    , VALUE,0),0)),0),1) "N3 Logical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,4,DECODE(METRIC_NAME,'Logical Reads Per Sec'    , VALUE,0),0)),0),1) "N4 Logical Reads Per Sec"
       
       ,ROUND(NVL(SUM(DECODE(INST_ID,1,DECODE(METRIC_NAME,'Physical Reads Per Sec'   , VALUE,0),0)),0),1) "N1 Physical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,2,DECODE(METRIC_NAME,'Physical Reads Per Sec'   , VALUE,0),0)),0),1) "N2 Physical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,3,DECODE(METRIC_NAME,'Physical Reads Per Sec'   , VALUE,0),0)),0),1) "N3 Physical Reads Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,4,DECODE(METRIC_NAME,'Physical Reads Per Sec'   , VALUE,0),0)),0),1) "N4 Physical Reads Per Sec"
       
       ,ROUND(NVL(SUM(DECODE(INST_ID,1,DECODE(METRIC_NAME,'Executions Per Sec'       , VALUE,0),0)),0),1) "N1 Executions Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,2,DECODE(METRIC_NAME,'Executions Per Sec'       , VALUE,0),0)),0),1) "N2 Executions Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,3,DECODE(METRIC_NAME,'Executions Per Sec'       , VALUE,0),0)),0),1) "N3 Executions Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,4,DECODE(METRIC_NAME,'Executions Per Sec'       , VALUE,0),0)),0),1) "N4 Executions Per Sec"
       
       ,ROUND(NVL(SUM(DECODE(INST_ID,1,DECODE(METRIC_NAME,'User Transaction Per Sec' , VALUE,0),0)),0),1) "N1 User Transaction Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,2,DECODE(METRIC_NAME,'User Transaction Per Sec' , VALUE,0),0)),0),1) "N2 User Transaction Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,3,DECODE(METRIC_NAME,'User Transaction Per Sec' , VALUE,0),0)),0),1) "N3 User Transaction Per Sec"
       ,ROUND(NVL(SUM(DECODE(INST_ID,4,DECODE(METRIC_NAME,'User Transaction Per Sec' , VALUE,0),0)),0),1) "N4 User Transaction Per Sec"
       
       ,ROUND(NVL(SUM(DECODE(INST_ID,1,DECODE(METRIC_NAME,'Session Count'            , VALUE,0),0)),0),1) "N1 Session Count"  
       ,ROUND(NVL(SUM(DECODE(INST_ID,2,DECODE(METRIC_NAME,'Session Count'            , VALUE,0),0)),0),1) "N2 Session Count" 
       ,ROUND(NVL(SUM(DECODE(INST_ID,3,DECODE(METRIC_NAME,'Session Count'            , VALUE,0),0)),0),1) "N3 Session Count" 
       ,ROUND(NVL(SUM(DECODE(INST_ID,4,DECODE(METRIC_NAME,'Session Count'            , VALUE,0),0)),0),1) "N4 Session Count" 
       
  FROM SYS.GV_$SYSMETRIC_HISTORY B
 WHERE 1=1 
   AND GROUP_ID   = 2 
   AND METRIC_NAME IN ('Host CPU Utilization (%)','Logical Reads Per Sec','Physical Reads Per Sec',
                       'Executions Per Sec','User Transaction Per Sec','Session Count')
   AND BEGIN_TIME BETWEEN  (SELECT START_TIME FROM MY_INPUT) AND (SELECT END_TIME FROM MY_INPUT)
 GROUP BY TO_CHAR(BEGIN_TIME,'YYYY-MM-DD HH24:MI') 
 ORDER BY 2; 