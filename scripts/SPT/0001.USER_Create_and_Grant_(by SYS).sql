-- ========================================================================================================================
-- 0001.USER_Create_and_Grant_(by SYS).sql 
-- [SCRIPT 0001 : iRPM SPT의 Repository Schema User생성]
-- 
-- Change String --> Running
--
--    1. SYS 계정으로 실행
--    2. iRPM Repository용 Tablespace는 사전에 생성 (1GB이상 권장)
--    3. iRPM Repository Schema계정 생성 및 아래의 변경 절차로 변경후 Script 실행
--
--    @@IRPMSPT_USER@@      : iRPM Main Schema User
--
--    > iRPM의 Repository의 Schema User를 "RPMMGR"로 할 경우 다음과 같이 모든 Script변경
--    @@IRPMSPT_USER@@      --> IRPMSPT
--
-- ========================================================================================================================

--connect / as sysdba

drop user @@IRPMSPT_USER@@ cascade;

create user @@IRPMSPT_USER@@ identified by "********" default tablespace USERS temporary tablespace TEMP;

GRANT CONNECT                                  TO @@IRPMSPT_USER@@;
GRANT CREATE ANY VIEW                          TO @@IRPMSPT_USER@@;
GRANT DROP   ANY INDEX                         TO @@IRPMSPT_USER@@;
GRANT ALTER  ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT ALTER  ANY INDEX                         TO @@IRPMSPT_USER@@;
GRANT CREATE ANY SEQUENCE                      TO @@IRPMSPT_USER@@;
GRANT ALTER SESSION                            TO @@IRPMSPT_USER@@;
GRANT INSERT ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT UPDATE ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT DELETE ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT UNLIMITED TABLESPACE                     TO @@IRPMSPT_USER@@;
GRANT CREATE DATABASE LINK                     TO @@IRPMSPT_USER@@;
GRANT SELECT ANY DICTIONARY                    TO @@IRPMSPT_USER@@;
GRANT CREATE ANY PROCEDURE                     TO @@IRPMSPT_USER@@;
GRANT COMMENT ANY TABLE                        TO @@IRPMSPT_USER@@;
GRANT CREATE ANY INDEXTYPE                     TO @@IRPMSPT_USER@@;
GRANT GRANT ANY PRIVILEGE                      TO @@IRPMSPT_USER@@;
GRANT CREATE PUBLIC SYNONYM                    TO @@IRPMSPT_USER@@;
GRANT GRANT ANY OBJECT PRIVILEGE               TO @@IRPMSPT_USER@@;
GRANT ANALYZE ANY                              TO @@IRPMSPT_USER@@;
GRANT SELECT_CATALOG_ROLE                      TO @@IRPMSPT_USER@@;
GRANT CREATE ANY JOB                           TO @@IRPMSPT_USER@@;
GRANT CREATE ANY MATERIALIZED VIEW             TO @@IRPMSPT_USER@@;
GRANT CREATE ANY outline                       TO @@IRPMSPT_USER@@;
GRANT CREATE ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT CREATE ANY INDEX                         TO @@IRPMSPT_USER@@;
GRANT DROP   ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT LOCK   ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT CREATE ANY TRIGGER                       TO @@IRPMSPT_USER@@;
                                               
-- for Running any SQL                         
GRANT SELECT ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT INSERT ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT UPDATE ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT DELETE ANY TABLE                         TO @@IRPMSPT_USER@@;
GRANT EXECUTE ANY PROCEDURE                    TO @@IRPMSPT_USER@@;
GRANT SELECT ANY SEQUENCE , ALTER ANY SEQUENCE TO @@IRPMSPT_USER@@;

GRANT EXECUTE ON DBMS_CRYPTO                   TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SCHEDULER                TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_METADATA                 TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_STATS                    TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_LOCK                     TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_XPLAN                    TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SQLTUNE                  TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_REDEFINITION             TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SPACE                    TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SPACE_ADMIN              TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SPM                      TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_WORKLOAD_REPOSITORY      TO @@IRPMSPT_USER@@;
GRANT ADMINISTER SQL TUNING SET                TO @@IRPMSPT_USER@@;
GRANT ADMINISTER SQL MANAGEMENT OBJECT         TO @@IRPMSPT_USER@@;
GRANT ADVISOR                                  TO @@IRPMSPT_USER@@;
GRANT SELECT ON SYS.USER$                      TO @@IRPMSPT_USER@@;
GRANT SELECT ANY TRANSACTION                   TO @@IRPMSPT_USER@@;
GRANT ALTER SYSTEM                             TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SYSTEM                   TO @@IRPMSPT_USER@@;
GRANT SELECT ON SYS.HIST_HEAD$                 TO @@IRPMSPT_USER@@;
GRANT SELECT ON SYS.V_$VERSION                 TO @@IRPMSPT_USER@@;
GRANT SELECT ON SYS.V_$OPEN_CURSOR             TO @@IRPMSPT_USER@@;
GRANT SELECT ON SYS.V_$SQL_PLAN_STATISTICS_ALL TO @@IRPMSPT_USER@@;

-- COMMENT for 10g
GRANT SELECT ON SYS.V_$SQLCOMMAND              TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_COMPRESSION              TO @@IRPMSPT_USER@@;

-- for SQL Query Result Digital Signature
GRANT EXECUTE ON DBMS_SQLHASH                  TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SQL_TRANSLATOR           TO @@IRPMSPT_USER@@;
GRANT EXECUTE ON DBMS_SHARED_POOL              TO @@IRPMSPT_USER@@;

