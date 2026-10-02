-- Local Docker test DB copy of scripts/add_datapump_history.sql (Data Pump job history).
ALTER SESSION SET CONTAINER = FREEPDB1;


CREATE TABLE system.datapump_job_history
(
    id                   NUMBER          NOT NULL,
    dbms_id              NUMBER          NOT NULL,
    dbname               VARCHAR2(100),
    job_owner            VARCHAR2(128),
    job_name             VARCHAR2(128)   NOT NULL,
    operation            VARCHAR2(10),       -- EXPORT | IMPORT
    job_mode             VARCHAR2(10),       -- SCHEMA | TABLE | FULL
    target_desc          VARCHAR2(4000),     -- 대상 요약 (스키마 목록, 테이블 수 등)
    directory_name       VARCHAR2(128),
    dumpfile             VARCHAR2(400),
    logfile              VARCHAR2(400),
    parallel_degree      NUMBER,
    table_exists_action  VARCHAR2(10),       -- IMPORT만
    estimated_bytes      NUMBER,             -- 계획할 때 세그먼트 기준 예상 크기
    dump_bytes           NUMBER,             -- 끝난 뒤 덤프 파일들의 실제 크기 합
    started_by           VARCHAR2(100),
    started_at           DATE,
    status               VARCHAR2(30),       -- RUNNING | COMPLETED | COMPLETED_WITH_ERRORS | FAILED | CANCELLED | UNKNOWN
    finished_at          DATE,
    elapsed_sec          NUMBER,
    error_count          NUMBER,
    result_message       VARCHAR2(1000),     -- 로그의 마지막 결과 줄
    CONSTRAINT pk_datapump_job_history PRIMARY KEY (id)
);

CREATE INDEX idx_datapump_history_dbms ON system.datapump_job_history (dbms_id, started_at);
CREATE INDEX idx_datapump_history_status ON system.datapump_job_history (status);

CREATE SEQUENCE system.seq_datapump_job_history
START WITH 1
INCREMENT BY 1
MINVALUE 1;

COMMENT ON TABLE system.datapump_job_history IS 'Data Pump(EXPDP/IMPDP) 작업 이력 — Maintenance > Data Pump';
COMMENT ON COLUMN system.datapump_job_history.status IS 'RUNNING | COMPLETED | COMPLETED_WITH_ERRORS | FAILED | CANCELLED | UNKNOWN';
COMMENT ON COLUMN system.datapump_job_history.dump_bytes IS '작업이 끝난 뒤 덤프 파일들의 실제 크기 합 (처리 속도 계산용)';
