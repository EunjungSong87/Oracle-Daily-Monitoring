-- Data Pump 이관(Export → Import 생성 → 이관 검증) 로컬 테스트용: 원본/대상 테이블스페이스와 CMP_SRC 샘플 테이블
-- (파티션 테이블, LOB 테이블, 일반 테이블 — 테이블·인덱스·LOB을 서로 다른 테이블스페이스에 둠).
-- 04_object_compare_sample.sql(CMP_SRC / CMP_TGT 계정) 다음에 실행됩니다.
--
-- Only runs automatically on a FRESH container. If the data volume already exists, run it manually:
--   docker exec -i oracle-daily-monitoring-test sqlplus -s / as sysdba < docker/initdb/07_migration_sample.sql
-- 내부망 DB에서는 실행하지 마세요.

ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE TABLESPACE mig_src_data DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/mig_src_data01.dbf' SIZE 20M AUTOEXTEND ON NEXT 10M MAXSIZE 300M;
CREATE TABLESPACE mig_src_idx  DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/mig_src_idx01.dbf'  SIZE 10M AUTOEXTEND ON NEXT 10M MAXSIZE 200M;
CREATE TABLESPACE mig_src_lob  DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/mig_src_lob01.dbf'  SIZE 10M AUTOEXTEND ON NEXT 10M MAXSIZE 200M;
CREATE TABLESPACE mig_tgt_data DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/mig_tgt_data01.dbf' SIZE 20M AUTOEXTEND ON NEXT 10M MAXSIZE 300M;
CREATE TABLESPACE mig_tgt_idx  DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/mig_tgt_idx01.dbf'  SIZE 10M AUTOEXTEND ON NEXT 10M MAXSIZE 200M;
CREATE TABLESPACE mig_tgt_lob  DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/mig_tgt_lob01.dbf'  SIZE 10M AUTOEXTEND ON NEXT 10M MAXSIZE 200M;

ALTER USER cmp_src QUOTA UNLIMITED ON mig_src_data QUOTA UNLIMITED ON mig_src_idx QUOTA UNLIMITED ON mig_src_lob;
-- 대상은 LOB 테이블스페이스 QUOTA를 일부러 주지 않는다 (사전 점검이 ORA-01950을 막는지 확인용 — 테스트 중에 부여)
ALTER USER cmp_tgt QUOTA UNLIMITED ON mig_tgt_data QUOTA UNLIMITED ON mig_tgt_idx;

ALTER SESSION SET CURRENT_SCHEMA = cmp_src;

-- 월 단위 RANGE 파티션 (파티션은 MIG_SRC_DATA, 로컬 인덱스는 MIG_SRC_IDX)
CREATE TABLE mig_sales (
  sale_id   NUMBER        NOT NULL,
  sale_date DATE          NOT NULL,
  amount    NUMBER(12, 2),
  memo      VARCHAR2(100)
)
TABLESPACE mig_src_data
PARTITION BY RANGE (sale_date) (
  PARTITION p2026_01 VALUES LESS THAN (DATE '2026-02-01'),
  PARTITION p2026_02 VALUES LESS THAN (DATE '2026-03-01'),
  PARTITION p2026_03 VALUES LESS THAN (DATE '2026-04-01'),
  PARTITION p2026_04 VALUES LESS THAN (DATE '2026-05-01')
);
CREATE INDEX ix_mig_sales_date ON mig_sales (sale_date) LOCAL TABLESPACE mig_src_idx;
INSERT INTO mig_sales SELECT LEVEL, DATE '2026-01-01' + MOD(LEVEL, 118), LEVEL * 10, 'row ' || LEVEL FROM dual CONNECT BY LEVEL <= 2000;

-- LOB만 다른 테이블스페이스 (테이블 MIG_SRC_DATA, LOB MIG_SRC_LOB, PK 인덱스 MIG_SRC_IDX)
CREATE TABLE mig_doc (
  doc_id NUMBER CONSTRAINT pk_mig_doc PRIMARY KEY USING INDEX TABLESPACE mig_src_idx,
  title  VARCHAR2(100),
  body   CLOB
)
TABLESPACE mig_src_data
LOB (body) STORE AS SECUREFILE (TABLESPACE mig_src_lob);
INSERT INTO mig_doc SELECT LEVEL, 'doc ' || LEVEL, RPAD('x', 4000, 'x') FROM dual CONNECT BY LEVEL <= 300;

-- 일반 테이블 (USERS 그대로)
CREATE TABLE mig_cust (cust_id NUMBER PRIMARY KEY, name VARCHAR2(50)) TABLESPACE users;
INSERT INTO mig_cust SELECT LEVEL, 'cust ' || LEVEL FROM dual CONNECT BY LEVEL <= 500;

-- 일부러 빠뜨릴 테이블 (Export 목록에서 빼서 각 단계가 막는지 확인)
CREATE TABLE mig_extra (id NUMBER PRIMARY KEY, val VARCHAR2(20)) TABLESPACE mig_src_data;
INSERT INTO mig_extra SELECT LEVEL, 'v' || LEVEL FROM dual CONNECT BY LEVEL <= 50;

-- 참조 오브젝트 (이관 검증의 INVALID/권한 확인용)
CREATE OR REPLACE VIEW v_mig_sales AS SELECT sale_id, amount FROM mig_sales;
GRANT SELECT ON mig_cust TO cmp_tgt;

COMMIT;

BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS('CMP_SRC');
END;
/
