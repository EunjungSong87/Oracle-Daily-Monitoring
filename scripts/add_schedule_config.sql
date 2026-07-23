-- 자동 실행(예약 점검) 기능을 위한 스키마 변경.
-- 운영 DB에는 이 파일을 한 번만 실행하세요 (재실행 시 ALTER TABLE ADD 구문은 에러 납니다).

ALTER TABLE system.monitoring_dbms_list ADD (auto_schedule CHAR(1) DEFAULT 'N');

CREATE TABLE system.monitoring_schedule_config
(
    id          NUMBER(1)   NOT NULL,
    enabled     CHAR(1)     DEFAULT 'N',
    run_time    VARCHAR2(5),           -- 'HH24:MI' 형식, 예: '07:00'
    updatetime  VARCHAR2(20),
    CONSTRAINT pk_monitoring_schedule_config PRIMARY KEY (id)
);

INSERT INTO system.monitoring_schedule_config (id, enabled, run_time, updatetime)
VALUES (1, 'N', '07:00', TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'));

COMMIT;
