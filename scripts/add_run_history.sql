-- 모니터링 실행 이력(과거 결과 조회) 기능을 위한 스키마 변경.
-- 운영 DB에는 이 파일을 한 번만 실행하세요.

CREATE TABLE system.monitoring_run_history
(
    id             NUMBER          NOT NULL,
    dbms_id        NUMBER          NOT NULL,
    dbname         VARCHAR2(50),
    run_at         VARCHAR2(20),      -- 'YYYYMMDDHH24MISS'
    trigger_type   VARCHAR2(20),      -- 'MANUAL' | 'SCHEDULED'
    success_count  NUMBER,
    fail_count     NUMBER,
    results        CLOB,              -- JSON.stringify(results)
    CONSTRAINT pk_monitoring_run_history PRIMARY KEY (id)
);

CREATE INDEX idx_monitoring_run_history_dbms ON system.monitoring_run_history (dbms_id, run_at);

CREATE SEQUENCE system.seq_monitoring_run_history
START WITH 1
INCREMENT BY 1
MINVALUE 1;

COMMENT ON TABLE system.monitoring_run_history IS '모니터링 실행 결과 이력 (과거 조회용)';
COMMENT ON COLUMN system.monitoring_run_history.trigger_type IS '실행 방식 (MANUAL: 수동 RUN, SCHEDULED: 예약 자동 실행)';
COMMENT ON COLUMN system.monitoring_run_history.results IS '실행 결과 전체(JSON) - task_id/task_name/columns/rows/success/error 배열';
