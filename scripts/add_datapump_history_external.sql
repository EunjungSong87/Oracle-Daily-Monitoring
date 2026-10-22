-- Data Pump 작업 이력에 "앱 밖에서 직접 돌린 작업(expdp/impdp)"과 실행자 정보를 남기기 위한 컬럼 추가.
-- add_datapump_history.sql 다음에 메타데이터 DB에 한 번만 실행하세요. 실행하지 않아도 앱은 동작합니다
-- (외부 작업은 작업 현황에서는 보이지만 이력에 남지 않음).

ALTER TABLE system.datapump_job_history ADD (
    source         VARCHAR2(10) DEFAULT 'APP', -- APP(화면에서 시작) | EXTERNAL(직접 실행한 작업을 감시로 발견)
    run_db_user    VARCHAR2(128),               -- 실행자: 접속 계정 / OS 사용자 / MACHINE / PROGRAM (V$SESSION)
    run_os_user    VARCHAR2(128),
    run_machine    VARCHAR2(200),
    run_program    VARCHAR2(200),
    first_seen_at  DATE,                        -- 외부 작업을 처음 본 시각
    cancelled_by   VARCHAR2(100)                -- 화면에서 취소한 사람
);

COMMENT ON COLUMN system.datapump_job_history.source IS 'APP | EXTERNAL';
