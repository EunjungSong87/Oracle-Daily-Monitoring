-- ======================================================================================================================================
-- 0301.SQL_PLAN_FIX_StagingSQL_by_SPM_or_SQLPROFILE.sql
-- [SCRIPT 0301 : Stageing Table의 PLAN으로 고정(SQL Plan Baseline - SPM방식),(SQL Profile - Outline Fix방식) 기능 ]
--
--    PLAN FIX를 SQL Baseline으로 할 것인지, SQL Profile의 OUTLINE Fix로 할 것인지 판단 후 선택하여 적용 
--
--  > SPM(SQL Plan Management - SQL Plan Baseline방식), SQL PROFILE의 설정을 위한 권한설정
--    GRANT ADMINISTER SQL MANAGEMENT OBJECT TO @@IRPMSPT_USER@@;
--      
--  > METHOD #1) SPM방식 #################################################  
--    Staging Table(ILM_IRPMSPT_SQLSET_STAGE) --> SQL_TUNE을 이용한 DBA_SQLSET (STS)으로 Loading --> STS로 부터 SQL PLAN Baseline으로 고정
--     
--    FUNCTION SET_ORIGINAL_PLAN_STS(in_STAGING_OWNER in VARCHAR2, in_STAGING_TABLE in VARCHAR2, in_SQL_ID in VARCHAR2, 
--       in_CHILD_NUMBER in NUMBER DEFAULT NULL, in_TEMP_TABLE in VARCHAR2 DEFAULT 'ILM_IRPMSPT_SQLSET_STAGE_TEMP') return VARCHAR2
--          
--    ILM_IRPMSPT_SQLSET_STAGE_TEMP 과 같은 Temporary Table이 필요함
--
--  > METHOD #2) SQLPROFILE OULINE SET방식 #################################################    
--    Staging Table(ILM_IRPMSPT_SQLSET_STAGE) --> SQL_TUNE을 이용한 SQL Profile Outline 고정
--
--    FUNCTION SET_ORIGINAL_PLAN_STS_PROFILE(in_STAGING_OWNER in VARCHAR2, in_STAGING_TABLE in VARCHAR2, in_SQL_ID in VARCHAR2, 
--       in_CHILD_NUMBER in NUMBER DEFAULT NULL)  return VARCHAR2  
--
-- ======================================================================================================================================



-- ==============================================================================
-- STEP #1 >>>> AS-IS PLAN으로 적용할 대상 SQL의 PLAN 및 성능정보, OUTLINE TEXT 확인
-- ==============================================================================

SELECT 
       BB.SQL_ID,
       BB.CHILD_NUMBER,
       BB.PARSING_SCHEMA_NAME,
       BB.MODULE,
       BB.SQL_TEXT,
       IRPM_SPT.GET_SQLPLAN_FROM_STS2(sys_context('USERENV', 'SESSION_USER'), 'ILM_IRPMSPT_SQLSET_STAGE', BB.NAME, BB.SQL_ID , BB.PLAN_HASH_VALUE) B_PLAN,
       BB.PLAN_HASH_VALUE B_PLAN_HASH,
       BB.EXECUTIONS ASIS_EXECUTIONS,
       ROUND(DECODE(BB.executions, NULL, 0, 0, 0, (NVL(BB.buffer_gets, 0)/BB.executions)), 0) B_BUFFER_GETS,
       ROUND(DECODE(BB.executions, NULL, 0, 0, 0, (NVL(BB.ELAPSED_TIME, 0)/BB.executions)/ 1000000), 5) B_ELAPSED_TIME,
       ROUND(DECODE(BB.executions, NULL, 0, 0, 0, (NVL(BB.ROWS_PROCESSED, 0)/BB.executions)), 0) ROWS_PER_EXEC,
       IRPM_SPT.GET_SQLBIND_STS(BB.BIND_DATA) BIND_VALUE,
       regexp_replace(plan_other_xml,'.*(<outline_data>.*</outline_data>).*','\1')  OUTLINE_XML,
       IRPM_SPT.GET_OUTLINE_FROM_OTHER_XML(plan_other_xml)                          OUTLINE_TEXT
FROM   ILM_IRPMSPT_SQLSET_STAGE BB
 WHERE BB.PARSING_SCHEMA_NAME IS NOT NULL  
   AND SQL_ID = 'xxxxxxxxxxxx';
 
 
 
 
-- @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
-- STEP #2 >>>> SPM으로 설정방식  
--
-- AS-IS PLAN으로 BASELINE설정 , CHILD_NUMBER, TEMP Table은 Option  
--     
--  > FUNCTION SET_ORIGINAL_PLAN_STS(in_STAGING_OWNER in VARCHAR2, in_STAGING_TABLE in VARCHAR2, in_SQL_ID in VARCHAR2, 
--       in_CHILD_NUMBER in NUMBER DEFAULT NULL, in_TEMP_TABLE in VARCHAR2 DEFAULT 'ILM_IRPMSPT_SQLSET_STAGE_TEMP') return VARCHAR2
-- @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@

-- DEFAULT값으로 설정
--select iRPM_SPT.SET_ORIGINAL_PLAN_STS(sys_context('USERENV', 'SESSION_USER'), 'ILM_IRPMSPT_SQLSET_STAGE', :SQL_ID)  
--from dual;

select iRPM_SPT.SET_ORIGINAL_PLAN_STS(sys_context('USERENV', 'SESSION_USER'), 'ILM_IRPMSPT_SQLSET_STAGE', :SQL_ID, :CHILD_NUMBER , 'ILM_IRPMSPT_SQLSET_STAGE_TEMP')  
from dual;
   
 
-- ==============================================================================
-- 전체 BASELINE 확인
-- 최근 30분전 등록된 BASELINE들을 변경된 역순으로 보기
-- ==============================================================================
--select * from dba_sqlset where CREATED > SYSDATE -(10/(24*60)) order by LAST_MODIFIED desc;
select * from dba_sql_plan_baselines where CREATED > SYSDATE -(30/(24*60)) order by LAST_MODIFIED desc;

-- ==============================================================================
-- 운영 SQL_ID에 대한 BASELINE 설정여부 확인
-- ==============================================================================
select * from dba_sql_plan_baselines where IRPM_SPT.SQLTEXT_TO_SQLID(sql_text) = :SQL_ID;


-- ==============================================================================
-- BASELINE의 FIXED PLAN확인
-- ==============================================================================
select * from table( dbms_xplan.display_sql_plan_baseline( sql_handle=>
           (select SQL_HANDLE from dba_sql_plan_baselines where IRPM_SPT.SQLTEXT_TO_SQLID(sql_text) = :SQL_ID), format=>'TYPICAL'));

-- ==============================================================================
-- SQL_ID에 대한 BASELINE 삭제하기 위한 SCRIPT생성 --> 나온 Script를 실행하면 됨
-- ==============================================================================
select 'DECLARE ii integer; BEGIN ii:= DBMS_SPM.drop_sql_plan_baseline( ''' || SQL_HANDLE || ''',''' || PLAN_NAME || '''); END; ' || chr(13) || '/'
from dba_sql_plan_baselines 
where IRPM_SPT.SQLTEXT_TO_SQLID(sql_text) = :SQL_ID;




-- @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
-- STEP #2 >>>> SQL Profile Outline 으로 설정방식  
--
-- AS-IS PLAN으로 BASELINE설정 , CHILD_NUMBER, TEMP Table은 Option
--     
--    FUNCTION SET_ORIGINAL_PLAN_STS_PROFILE(in_STAGING_OWNER in VARCHAR2, in_STAGING_TABLE in VARCHAR2, in_SQL_ID in VARCHAR2, 
--       in_CHILD_NUMBER in NUMBER DEFAULT NULL)  return VARCHAR2  
-- @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
   
select iRPM_SPT.SET_ORIGINAL_PLAN_STS_PROFILE(sys_context('USERENV', 'SESSION_USER'), 'ILM_IRPMSPT_SQLSET_STAGE', :SQL_ID, :CHILD_NUMBER)  
from dual;
 
 
-- ==============================================================================
-- SQL Profile 등록 확인
-- ==============================================================================
select * from dba_sql_profiles where 1=1 and NAME like 'IRPMSPT_FIX%' order by LAST_MODIFIED desc;


-- ==============================================================================
-- SQL Profile의 PLAN으로 동작하는지 다음을 실행해서 나오는 Script를 실행
-- ==============================================================================
SELECT 'ALTER SESSION SET CURRENT_SCHEMA=' || PARSING_SCHEMA_NAME || ';' || chr(10) || chr(10) ||
       'EXPLAIN PLAN FOR ' || chr(10) || SQL_TEXT || ';' || chr(10) ||  chr(10) ||
       'select * from table(dbms_xplan.display(format=>''ADVANCED OUTLINE''));' || chr(10) || chr(10) ||
       'ALTER SESSION SET CURRENT_SCHEMA=' || sys_context('USERENV', 'SESSION_USER') || ';' CHK_SQL
from  ILM_IRPMSPT_SQLSET_STAGE BB
 WHERE BB.PARSING_SCHEMA_NAME IS NOT NULL  
   AND SQL_ID = :SQL_ID;



-- ==============================================================================
-- SQL_ID에 대한 PROFILE을 삭제하기 위한 SCRIPT생성 --> 나온 Script를 실행하면 됨
-- ==============================================================================
select 'DECLARE ii integer; BEGIN DBMS_SQLTUNE.DROP_SQL_PROFILE(NAME=>''' || NAME || '''); END; ' || chr(13) || '/'
from dba_sql_profiles 
where IRPM_SPT.SQLTEXT_TO_SQLID(sql_text) = :SQL_ID;

 