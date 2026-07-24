-- Runs automatically on first container startup, executed as SYS.
-- Without an explicit ALTER SESSION, these init scripts run against
-- CDB$ROOT rather than the FREEPDB1 pluggable database, so the app
-- (which connects to //host:1521/FREEPDB1) would never see these objects.
--
-- Mirrors TABLE_DBMS_LIST.sql from the repo root, but schema-qualifies
-- monitoring_tasks / monitoring_thresholds (the original script creates
-- them without a schema prefix, which lands them in SYS instead of
-- SYSTEM and breaks the app's SYSTEM.MONITORING_TASKS queries).

ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE TABLE system.monitoring_dbms_list
(
    ID            NUMBER(10),
    DBNAME        VARCHAR2(50),
    USERNAME      VARCHAR2(50),
    PASSWORD      VARCHAR2(100),
    SID           VARCHAR2(50),
    IP            VARCHAR2(16),
    PORT          VARCHAR2(5),
    MEMO          VARCHAR2(1000),
    CREATETIME    VARCHAR2(20),
    UPDATETIME    VARCHAR2(20),
    AUTO_SCHEDULE CHAR(1) DEFAULT 'N'
);

CREATE SEQUENCE system.seq_monitoring_dbms_list
START WITH 1
INCREMENT BY 1
MINVALUE 1;

CREATE TABLE system.monitoring_tasks (
  id            NUMBER NOT NULL,
  name          VARCHAR2(100) NOT NULL,
  category      VARCHAR2(50),
  description   VARCHAR2(255),
  sql_text      CLOB NOT NULL,
  schedule      VARCHAR2(50),
  is_active     CHAR(1) DEFAULT 'Y',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP
);

ALTER TABLE system.monitoring_tasks
  ADD CONSTRAINT pk_monitoring_tasks PRIMARY KEY (id);

CREATE TABLE system.monitoring_thresholds (
  id              NUMBER NOT NULL,
  task_id         NUMBER NOT NULL,
  column_name     VARCHAR2(100) NOT NULL,
  condition_type  VARCHAR2(20) NOT NULL,
  operator        VARCHAR2(10) NOT NULL,
  threshold       VARCHAR2(255) NOT NULL,
  clevel          VARCHAR2(10) DEFAULT 'WARN',
  message         VARCHAR2(255),
  is_active       CHAR(1) DEFAULT 'Y',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE system.monitoring_thresholds
  ADD CONSTRAINT pk_monitoring_thresholds PRIMARY KEY (id);

CREATE TABLE system.monitoring_schedule_config
(
    id          NUMBER(1)   NOT NULL,
    enabled     CHAR(1)     DEFAULT 'N',
    run_time    VARCHAR2(5),
    updatetime  VARCHAR2(20),
    CONSTRAINT pk_monitoring_schedule_config PRIMARY KEY (id)
);

INSERT INTO system.monitoring_schedule_config (id, enabled, run_time, updatetime)
VALUES (1, 'N', '07:00', TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'));

CREATE TABLE system.monitoring_run_history
(
    id             NUMBER          NOT NULL,
    dbms_id        NUMBER          NOT NULL,
    dbname         VARCHAR2(50),
    run_at         VARCHAR2(20),
    trigger_type   VARCHAR2(20),
    success_count  NUMBER,
    fail_count     NUMBER,
    results        CLOB,
    CONSTRAINT pk_monitoring_run_history PRIMARY KEY (id)
);

CREATE INDEX idx_monitoring_run_history_dbms ON system.monitoring_run_history (dbms_id, run_at);

CREATE SEQUENCE system.seq_monitoring_run_history
START WITH 1
INCREMENT BY 1
MINVALUE 1;
