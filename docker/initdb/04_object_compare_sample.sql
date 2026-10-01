-- Adds two small sample schemas (CMP_SRC / CMP_TGT) that intentionally differ, so the
-- local test DB has something for the Maintenance > Object Compare screen to show end
-- to end: objects that exist on only one side, tables whose columns differ in
-- type/length/nullability/default, indexes with different columns, a sequence with a
-- different cache size, and PL/SQL whose source differs.
--
-- Only runs automatically on a FRESH container (gvenzl images run
-- container-entrypoint-initdb.d scripts once, on first init). If the data
-- volume already exists, run this file manually instead, e.g.:
--   docker exec -i oracle-daily-monitoring-test sqlplus -s / as sysdba \
--     < docker/initdb/04_object_compare_sample.sql

ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE USER cmp_src IDENTIFIED BY "CmpTest_2026!" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS;
CREATE USER cmp_tgt IDENTIFIED BY "CmpTest_2026!" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS;

-- ─────────────────────────────── CMP_SRC (기준) ───────────────────────────────
ALTER SESSION SET CURRENT_SCHEMA = cmp_src;

CREATE TABLE t_same (id NUMBER(10) CONSTRAINT pk_t_same PRIMARY KEY, name VARCHAR2(50) NOT NULL, created_at DATE DEFAULT SYSDATE);

CREATE TABLE t_cols (
    id          NUMBER(10)      NOT NULL,
    code        VARCHAR2(20)    NOT NULL,
    amount      NUMBER(10,2)    DEFAULT 0,
    memo        VARCHAR2(200),
    status      CHAR(1)         DEFAULT 'Y',
    src_only    DATE
);

-- PK with a system-generated name (SYS_C...) — must still pair up with the other side.
CREATE TABLE t_syspk (id NUMBER PRIMARY KEY, val VARCHAR2(10));

CREATE TABLE t_src_only (id NUMBER, note VARCHAR2(100));

CREATE INDEX ix_same ON t_same (name);
CREATE INDEX ix_diff ON t_cols (code);
CREATE INDEX ix_src_only ON t_cols (status);
CREATE INDEX ix_func ON t_cols (UPPER(memo), id DESC);

CREATE SEQUENCE seq_same START WITH 1 INCREMENT BY 1 CACHE 20;
CREATE SEQUENCE seq_diff START WITH 1 INCREMENT BY 1 CACHE 20;

CREATE VIEW v_same AS SELECT id, name FROM t_same;
CREATE VIEW v_diff AS SELECT id, code FROM t_cols;

CREATE SYNONYM syn_diff FOR t_same;

CREATE OR REPLACE PROCEDURE p_same (p_id IN NUMBER) AS
BEGIN
  NULL;
END;
/

CREATE OR REPLACE PROCEDURE p_diff (p_id IN NUMBER) AS
  v_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM t_same WHERE id = p_id;
  IF v_count = 0 THEN
    INSERT INTO t_same (id, name) VALUES (p_id, 'NEW');
  END IF;
END;
/

CREATE OR REPLACE FUNCTION f_src_only (p_id IN NUMBER) RETURN NUMBER AS
BEGIN
  RETURN p_id * 2;
END;
/

CREATE OR REPLACE PACKAGE pkg_diff AS
  PROCEDURE run (p_id IN NUMBER);
END pkg_diff;
/

CREATE OR REPLACE PACKAGE BODY pkg_diff AS
  PROCEDURE run (p_id IN NUMBER) AS
  BEGIN
    p_same(p_id);
  END run;
END pkg_diff;
/

CREATE OR REPLACE TRIGGER trg_diff BEFORE INSERT ON t_same FOR EACH ROW
BEGIN
  :NEW.created_at := SYSDATE;
END;
/

-- ─────────────────────────────── CMP_TGT (대상) ───────────────────────────────
ALTER SESSION SET CURRENT_SCHEMA = cmp_tgt;

CREATE TABLE t_same (id NUMBER(10) CONSTRAINT pk_t_same PRIMARY KEY, name VARCHAR2(50) NOT NULL, created_at DATE DEFAULT SYSDATE);

CREATE TABLE t_cols (
    id          NUMBER(12)      NOT NULL,           -- precision differs
    code        VARCHAR2(30),                       -- length + nullability differ
    amount      NUMBER(10,2)    DEFAULT 1,          -- default differs
    memo        VARCHAR2(200),
    status      CHAR(1)         DEFAULT 'Y',
    tgt_only    VARCHAR2(10)
);

CREATE TABLE t_syspk (id NUMBER PRIMARY KEY, val VARCHAR2(10));

CREATE TABLE t_tgt_only (id NUMBER);

CREATE INDEX ix_same ON t_same (name);
-- uniqueness + columns differ
CREATE UNIQUE INDEX ix_diff ON t_cols (code, id);
CREATE INDEX ix_func ON t_cols (UPPER(memo), id DESC);

CREATE SEQUENCE seq_same START WITH 1 INCREMENT BY 1 CACHE 20;
CREATE SEQUENCE seq_diff START WITH 1 INCREMENT BY 1 CACHE 100;

CREATE VIEW v_same AS SELECT id, name FROM t_same;
CREATE VIEW v_diff AS SELECT id, code, amount FROM t_cols;

CREATE SYNONYM syn_diff FOR t_cols;

-- Created schema-qualified on purpose: the owner prefix on line 1 must not count as a difference.
CREATE OR REPLACE PROCEDURE cmp_tgt.p_same (p_id IN NUMBER) AS
BEGIN
  NULL;
END;
/

CREATE OR REPLACE PROCEDURE p_diff (p_id IN NUMBER) AS
  v_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM t_same WHERE id = p_id;
  IF v_count = 0 THEN
    INSERT INTO t_same (id, name) VALUES (p_id, 'CREATED');
    COMMIT;
  END IF;
END;
/

CREATE OR REPLACE PACKAGE pkg_diff AS
  PROCEDURE run (p_id IN NUMBER);
END pkg_diff;
/

CREATE OR REPLACE PACKAGE BODY pkg_diff AS
  PROCEDURE run (p_id IN NUMBER) AS
  BEGIN
    p_same(p_id);
    p_diff(p_id);
  END run;
END pkg_diff;
/

CREATE OR REPLACE TRIGGER trg_diff BEFORE INSERT OR UPDATE ON t_same FOR EACH ROW
BEGIN
  :NEW.created_at := SYSDATE;
END;
/
