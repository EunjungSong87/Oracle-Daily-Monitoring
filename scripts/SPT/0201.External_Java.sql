-- ======================================================================================================================================
-- 0201.External_Java.sql 
-- [SCRIPT 0201 : iRPM SPT의 LOAD TEST일 경우 Thinktime을 Microsecond단위로 지정하기 위한 Pckage ]
--       
--   << 고려사항 >> : Oracle JVM이 설저되어 있어야 하며 없을 경우 사용할 수 없음. 이 경우 in_LOAD_PROC_THINKTIME는 NULL, 0.01 ~의 범위 입력 가능
-- 
-- UGENS SPT 부하발생기 
--    > IRPM_SPT_UTIL을 사용하지 않을 경우 내부적으로 DBMS_LOCK.SLEEP()을 사용하므로 최소 0.01 (1/100 Sec) ~ 단위부터 설정 가능.  
--      in_LOAD_PROC_THINKTIME                    : 부하발생시 Thinktime (Sleeptime between SQLs) 1/100초 단위 (0.01 ~ ) 단위 초       
--
--    > IRPM_SPT_UTIL을 사용할 경우 내부적으로 JAVA의 Thread.sleep을 사용하므로 최소 0.001 (1/1000 Sec) ~ 단위부터 설정 가능.  
--      in_LOAD_PROC_THINKTIME                    : 부하발생시 Thinktime (Sleeptime between SQLs) 1/1000초의 microsecond 단위 (0.001 ~ ) 단위로
--                                                  입력 가능   
-- ======================================================================================================================================


DROP JAVA SOURCE IRPMSPT_JAVA;

CREATE OR REPLACE JAVA SOURCE NAMED IRPMSPT_JAVA AS
//import java.io.*;
//import oracle.jdbc.*;
//import oracle.sql.*;
//import java.sql.*;
//import java.util.*;
//import java.math.*;

public class IRPMSPT_UTILJAVA {
 public static void sleep (int pMilisecond) throws Exception { 
    try {
       Thread.sleep(pMilisecond);  
    } catch (InterruptedException ex) {
        throw new Exception ("Thread.sleep not work!!");
    }
 }
}
/
 

ALTER JAVA SOURCE IRPMSPT_JAVA COMPILE;
 
 
CREATE OR REPLACE PACKAGE IRPM_SPT_UTIL AUTHID CURRENT_USER 
IS
  gv_PKG_VERSION  VARCHAR2(100)  := 'IRPM_SPT_UTIL v1.0.190812 Build 20190812 UGENS SNC Copyright(R)';
  
  PROCEDURE SLEEP(pMilisecond in number);
END;
/
 
 

CREATE OR REPLACE PACKAGE BODY IRPM_SPT_UTIL 
IS
  PROCEDURE SLEEP(pMilisecond in number) is language java name 'IRPMSPT_UTILJAVA.sleep(int)'; 
END;
/




-- ======================================================================================================================================
-- 정상적인 설치 TEST
--     IRPM_SPT_UTIL.sleep(1) 실행 TEST
--     > JVM이 없어서 설치 실패이거나 IRPM_SPT_UTIL Package가 정상적으로 설치가 안된 경우 실해 안됨
-- ======================================================================================================================================
BEGIN

  BEGIN
    EXECUTE IMMEDIATE 'CALL IRPM_SPT_UTIL.sleep(1)';
    DBMS_OUTPUT.PUT_LINE('IRPM_SPT_UTIL OK!!');
  EXCEPTION WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('IRPM_SPT_UTIL Not OK!!'); 
  END;

END;
/

-- ======================================================================================================================================
--  IRPM_SPT_UTIL.sleep() 기능TEST
--     > 아래 내용은 1 microsecond를 10,000번 반복하는 것으로 10초의 실행시간의 sleep을 처리하는 것임
--       처리 결과는 10초 + a 이므로 20초 이상이 되면 microsecond sleep처리가 문제가 있다는 것임 
--       SQL> +000000000 00:00:15.933614000
--
--       in_LOAD_PROC_THINKTIME : 0.001 ~ 이며 IRPM_SPT_UTIL.sleep() call시 1000을 곱해서 Call함. 그러므로 0.001 --> IRPM_SPT_UTIL.sleep(1)임
-- ======================================================================================================================================
DECLARE
  v_START_TIME TIMESTAMP;
  v_END_TIME   TIMESTAMP;
  ii           NUMBER;
BEGIN
  v_START_TIME := SYSTIMESTAMP;
  FOR ii IN 1..10000 LOOP
    IRPM_SPT_UTIL.sleep(1);
    --EXECUTE IMMEDIATE 'CALL IRPM_SPT_UTIL.sleep(1)';
  END LOOP;
  --v_END_TIME := SYSTIMESTAMP;
  DBMS_OUTPUT.PUT_LINE(SYSTIMESTAMP-v_START_TIME);
END;
/