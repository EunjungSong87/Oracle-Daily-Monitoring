-- Maintenance > Data Pump 작업 이력(누가/언제/무엇을/얼마나 걸렸는지)을 남기기 위한 스키마 변경.
-- 메타데이터 DB에 한 번만 실행하세요.
--
-- 작업을 시작할 때 RUNNING으로 한 줄 넣고, 작업이 대상 DB에서 사라지면(끝나면) 로그 파일을 읽어
-- 결과/끝난 시각/수행 시간/덤프 실제 크기를 채웁니다. 쌓인 이력은 실행 전 예상 시간(처리 속도) 계산에도 씁니다.

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
