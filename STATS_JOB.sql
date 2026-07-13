CREATE TABLE STATS_SCHEMA_SCHEDULE (
    RUN_DAY_OF_WEEK VARCHAR2(10),   -- 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'
    SCHEMA_NAME     VARCHAR2(30),   -- 수집 대상 스키마명
    DEGREE_OF_COOL  NUMBER DEFAULT 4, -- 해당 스키마 내 테이블들을 돌릴 기본 병렬도
    IS_ACTIVE       VARCHAR2(1) DEFAULT 'Y',
    CONSTRAINT PK_STATS_SCH_SCHED PRIMARY KEY (RUN_DAY_OF_WEEK, SCHEMA_NAME)
);

-- 입력 예시: 월요일은 HR과 SCOTT 스키마, 화요일은 SALES_OWNER 스키마 전체
INSERT INTO STATS_SCHEMA_SCHEDULE VALUES ('MON', 'HR', 4, 'Y');
INSERT INTO STATS_SCHEMA_SCHEDULE VALUES ('MON', 'SCOTT', 4, 'Y');
INSERT INTO STATS_SCHEMA_SCHEDULE VALUES ('TUE', 'SALES_OWNER', 8, 'Y');
COMMIT;


CREATE TABLE STATS_JOB_LOG (
    LOG_SEQ         NUMBER GENERATED ALWAYS AS IDENTITY, -- 자동 증가 시퀀스
    LOG_DATE        DATE DEFAULT SYSDATE,               -- 로그 기록 일시
    RUN_DAY_OF_WEEK VARCHAR2(10),                       -- 수행 요일 (MON, TUE...)
    SCHEMA_NAME     VARCHAR2(30),                       -- 스키마명
    TABLE_NAME      VARCHAR2(30),                       -- 테이블명
    START_TIME      TIMESTAMP,                          -- 테이블별 시작 시간
    END_TIME        TIMESTAMP,                          -- 테이블별 종료 시간
    ELAPSED_SECONDS NUMBER,                             -- 소요 시간 (초 단위)
    STATUS          VARCHAR2(10),                       -- SUCCESS / ERROR
    ERROR_MESSAGE   VARCHAR2(4000),                     -- 에러 발생 시 SQLERRM 저장
    CONSTRAINT PK_STATS_JOB_LOG PRIMARY KEY (LOG_SEQ)
);

-- 대용량 로그 조회를 대비한 인덱스 생성
CREATE INDEX IX_STATS_JOB_LOG_01 ON STATS_JOB_LOG (LOG_DATE, STATUS);






CREATE OR REPLACE PACKAGE PKG_MAINT_STATS AS
    -- 새벽 배치 Job에서 호출할 메인 프로시저
    PROCEDURE RUN_DAILY_STATS_BY_TABLE;
    
    -- 내부 로깅용 프로시저 (독립 트랜잭션)
    PROCEDURE WRITE_LOG (
        P_DAY      IN VARCHAR2, P_SCHEMA   IN VARCHAR2, P_TABLE    IN VARCHAR2,
        P_START    IN TIMESTAMP, P_END      IN TIMESTAMP, P_STATUS   IN VARCHAR2,
        P_ERR_MSG  IN VARCHAR2
    );
END PKG_MAINT_STATS;
/

CREATE OR REPLACE PACKAGE BODY PKG_MAINT_STATS AS

    -- [로그 기록 서브 프로시저] 메인 로직의 성공/실패 여부와 관계없이 무조건 COMMIT 됨
    PROCEDURE WRITE_LOG (
        P_DAY      IN VARCHAR2, P_SCHEMA   IN VARCHAR2, P_TABLE    IN VARCHAR2,
        P_START    IN TIMESTAMP, P_END      IN TIMESTAMP, P_STATUS   IN VARCHAR2,
        P_ERR_MSG  IN VARCHAR2
    ) AS
        PRAGMA AUTONOMOUS_TRANSACTION; -- 독립 트랜잭션 선언
        V_ELAPSED NUMBER;
    BEGIN
        -- 소요 시간 계산 (초 단위, 소수점 2자리까지)
        V_ELAPSED := ROUND(
            EXTRACT(DAY FROM (P_END - P_START)) * 86400 +
            EXTRACT(HOUR FROM (P_END - P_START)) * 3600 +
            EXTRACT(MINUTE FROM (P_END - P_START)) * 60 +
            EXTRACT(SECOND FROM (P_END - P_START)), 2
        );

        INSERT INTO STATS_JOB_LOG (
            RUN_DAY_OF_WEEK, SCHEMA_NAME, TABLE_NAME, 
            START_TIME, END_TIME, ELAPSED_SECONDS, 
            STATUS, ERROR_MESSAGE
        ) VALUES (
            P_DAY, P_SCHEMA, P_TABLE, 
            P_START, P_END, V_ELAPSED, 
            P_STATUS, SUBSTR(P_ERR_MSG, 1, 4000)
        );
        
        COMMIT; -- 서브 트랜잭션만 커밋
    EXCEPTION
        WHEN OTHERS THEN
            ROLLBACK; -- 로그 기록 중 에러 발생 시 롤백
    END WRITE_LOG;


    -- [메인 배치 프로시저]
    PROCEDURE RUN_DAILY_STATS_BY_TABLE AS
        V_CURRENT_DAY VARCHAR2(10);
        V_START_TIME  TIMESTAMP;
        V_END_TIME    TIMESTAMP;
        
        -- 1. 오늘 요일에 가동할 스키마 목록 커서
        CURSOR C_SCHEMAS(P_DAY VARCHAR2) IS
            SELECT SCHEMA_NAME, DEGREE_OF_COOL
            FROM STATS_SCHEMA_SCHEDULE
            WHERE RUN_DAY_OF_WEEK = P_DAY
              AND IS_ACTIVE = 'Y';
              
        -- 2. 해당 스키마 내부의 테이블들을 가져오는 커서
        CURSOR C_TABLES(P_OWNER VARCHAR2) IS
            SELECT TABLE_NAME
            FROM ALL_TABLES
            WHERE OWNER = P_OWNER
              AND TEMPORARY = 'N'
              AND NESTED = 'NO'
              AND DURATION IS NULL
            ORDER BY TABLE_NAME;
            
    BEGIN
        -- 현재 요일 추출 (영문 3자리 고정)
        V_CURRENT_DAY := TO_CHAR(SYSDATE, 'DY', 'NLS_DATE_LANGUAGE=AMERICAN');
        
        -- [Outer Loop] 오늘 돌려야 할 스키마 순회
        FOR R_SCH IN C_SCHEMAS(V_CURRENT_DAY) LOOP
            
            -- [Inner Loop] 스키마 내부 테이블 순회
            FOR R_TBL IN C_TABLES(R_SCH.SCHEMA_NAME) LOOP
                -- 테이블별 시작 시간 기록
                V_START_TIME := SYSTIMESTAMP; 
                
                BEGIN
                    -- 통계 수집 실행
                    DBMS_STATS.GATHER_TABLE_STATS(
                        OWNNAME          => R_SCH.SCHEMA_NAME,
                        TABNAME          => R_TBL.TABLE_NAME,
                        ESTIMATE_PERCENT => DBMS_STATS.AUTO_SAMPLE_SIZE,
                        GRANULARITY      => 'AUTO',
                        CASCADE          => TRUE, 
                        DEGREE           => R_SCH.DEGREE_OF_COOL,
                        NO_INVALIDATE    => FALSE
                    );
                    
                    V_END_TIME := SYSTIMESTAMP;
                    
                    -- 성공 로그 기록
                    WRITE_LOG(
                        P_DAY     => V_CURRENT_DAY,
                        P_SCHEMA  => R_SCH.SCHEMA_NAME,
                        P_TABLE   => R_TBL.TABLE_NAME,
                        P_START   => V_START_TIME,
                        P_END     => V_END_TIME,
                        P_STATUS  => 'SUCCESS',
                        P_ERR_MSG => NULL
                    );
                    
                EXCEPTION
                    WHEN OTHERS THEN
                        V_END_TIME := SYSTIMESTAMP;
                        
                        -- 실패 로그 기록 (오류가 나도 멈추지 않고 기록 후 Loop 지속)
                        WRITE_LOG(
                            P_DAY     => V_CURRENT_DAY,
                            P_SCHEMA  => R_SCH.SCHEMA_NAME,
                            P_TABLE   => R_TBL.TABLE_NAME,
                            P_START   => V_START_TIME,
                            P_END     => V_END_TIME,
                            P_STATUS  => 'ERROR',
                            P_ERR_MSG => SQLERRM
                        );
                END;
            END LOOP;
            
        END LOOP;
        
    END RUN_DAILY_STATS_BY_TABLE;

END PKG_MAINT_STATS;
/


SELECT STATUS, COUNT(*), SUM(ELAPSED_SECONDS) AS TOTAL_SECONDS
FROM STATS_JOB_LOG
WHERE LOG_DATE >= TRUNC(SYSDATE)
GROUP BY STATUS;



SELECT SCHEMA_NAME, TABLE_NAME, START_TIME, ELAPSED_SECONDS, ERROR_MESSAGE
FROM STATS_JOB_LOG
WHERE LOG_DATE >= TRUNC(SYSDATE)
  AND STATUS = 'ERROR'
ORDER BY START_TIME DESC;


SELECT SCHEMA_NAME, TABLE_NAME, RUN_DAY_OF_WEEK, ELAPSED_SECONDS
FROM (
    SELECT SCHEMA_NAME, TABLE_NAME, RUN_DAY_OF_WEEK, ELAPSED_SECONDS,
           ROW_NUMBER() OVER (ORDER BY ELAPSED_SECONDS DESC) AS RN
    FROM STATS_JOB_LOG
)
WHERE RN <= 10;