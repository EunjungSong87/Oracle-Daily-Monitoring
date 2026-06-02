select * from system.monitoring_dbms_list;

--DBNAME	SID	IP	PORT	MEMO	CREATETIME	UPDATETIME
--PGDB11T	PGDB1T	172.30.22.211	1521			
--PGDB12T	PGDB1T	172.30.22.212	1521			


drop table system.monitoring_dbms_list ; 
CREATE TABLE system.monitoring_dbms_list
(
    ID          NUMBER(10),
    DBNAME      VARCHAR2(50),
    USERNAME    VARCHAR2(50),
    PASSWORD    VARCHAR2(100),
    SID         VARCHAR2(50),
    IP          VARCHAR2(16),
    PORT        VARCHAR2(5),
    MEMO        VARCHAR2(1000),
    CREATETIME  VARCHAR2(20),
    UPDATETIME  VARCHAR2(20)
)
TABLESPACE SYSTEM
STORAGE
(
    INITIAL 64K
    NEXT 1M
)
NOCOMPRESS;



insert into system.monitoring_dbms_list values ( 'PGDB11T', 'SYSTEM', 'welcome1', 'PGDB1T', '172.30.22.211', '1521' , null, null, null);
insert into system.monitoring_dbms_list values ( 'PGDB12T', 'SYSTEM', 'welcome1', 'PGDB1T', '172.30.22.211', '1521' , null, null, null);
commit; 



CREATE SEQUENCE SYSTEM.seq_monitoring_dbms_list
START WITH 1
INCREMENT BY 1
MINVALUE 1
MAXVALUE 9999999999999999999999999999;

drop table monitoring_tasks; 
-- 테이블 생성
CREATE TABLE monitoring_tasks (
  id            NUMBER not null,
  name          VARCHAR2(100) NOT NULL,
  category      VARCHAR2(50),
  description   VARCHAR2(255),
  sql_text      CLOB NOT NULL,
  schedule      VARCHAR2(50),
  is_active     CHAR(1) DEFAULT 'Y',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP
);

-- PK 명시적 생성 (생략 가능하지만 명확히 표기)
ALTER TABLE monitoring_tasks
  ADD CONSTRAINT pk_monitoring_tasks PRIMARY KEY (id) using index idx_monitoring_tasks_pk;

-- PK 인덱스 (오라클은 기본으로 생성되나 명시적 표현 가능)
CREATE UNIQUE INDEX idx_monitoring_tasks_pk
  ON monitoring_tasks (id);

-- 컬럼 설명 (COMMENT)
COMMENT ON TABLE monitoring_tasks IS '모니터링 자동화 대상 점검 항목 정의 테이블';
COMMENT ON COLUMN monitoring_tasks.id IS '식별자 (PK)';
COMMENT ON COLUMN monitoring_tasks.name IS '점검 항목 이름';
COMMENT ON COLUMN monitoring_tasks.category IS '점검 카테고리 (예: daily, performance)';
COMMENT ON COLUMN monitoring_tasks.description IS '항목 설명';
COMMENT ON COLUMN monitoring_tasks.sql_text IS '점검에 사용될 SQL 쿼리';
COMMENT ON COLUMN monitoring_tasks.schedule IS '스케줄 표현식 (예: cron)';
COMMENT ON COLUMN monitoring_tasks.is_active IS '활성화 여부 (Y/N)';
COMMENT ON COLUMN monitoring_tasks.created_at IS '생성일시';
COMMENT ON COLUMN monitoring_tasks.updated_at IS '수정일시';


-- 테이블 생성
CREATE TABLE monitoring_thresholds (
  id              NUMBER NOT NULL,
  task_id         NUMBER NOT NULL,
  column_name     VARCHAR2(100) NOT NULL,
  condition_type  VARCHAR2(20) NOT NULL,
  operator        VARCHAR2(10) NOT NULL,
  threshold       VARCHAR2(255) NOT NULL,
  clevel           VARCHAR2(10) DEFAULT 'WARN',
  message         VARCHAR2(255),
  is_active       CHAR(1) DEFAULT 'Y',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PK 제약 조건 생성
ALTER TABLE monitoring_thresholds
  ADD CONSTRAINT pk_monitoring_thresholds PRIMARY KEY (id) using index idx_monitoring_thresholds_pk;

-- PK 인덱스 명시
CREATE UNIQUE INDEX idx_monitoring_thresholds_pk
  ON monitoring_thresholds (id);



-- 컬럼 설명 (COMMENT)
COMMENT ON TABLE monitoring_thresholds IS '모니터링 점검 항목별 조건(임계치/패턴 등) 정의 테이블';
COMMENT ON COLUMN monitoring_thresholds.id IS '식별자 (PK)';
COMMENT ON COLUMN monitoring_thresholds.task_id IS '연결된 점검 항목 ID (monitoring_tasks.id)';
COMMENT ON COLUMN monitoring_thresholds.column_name IS '평가 대상 컬럼 이름';
COMMENT ON COLUMN monitoring_thresholds.condition_type IS '조건 유형 (NUMERIC, STRING, PATTERN)';
COMMENT ON COLUMN monitoring_thresholds.operator IS '비교 연산자 (>, <, =, !=, LIKE, INCLUDES 등)';
COMMENT ON COLUMN monitoring_thresholds.threshold IS '비교 기준값';
COMMENT ON COLUMN monitoring_thresholds.clevel IS '알림 레벨 (INFO, WARN, ERROR)';
COMMENT ON COLUMN monitoring_thresholds.message IS '조건 충족 시 사용자에게 보여줄 메시지';
COMMENT ON COLUMN monitoring_thresholds.is_active IS '활성화 여부 (Y/N)';
COMMENT ON COLUMN monitoring_thresholds.created_at IS '생성일시';