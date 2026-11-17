-- Monitoring > Alert Log: 대상 DB의 Alert Log(ORA-/FAIL 등) 발생 내역을 모아
-- DB/기간/ORA 코드로 검색하고 발생 추이를 보기 위한 스키마.
-- 메타데이터 DB에 한 번만 실행하세요. 없으면 Alert Log 화면은 "설치 필요"만 표시하고,
-- 예약 점검의 수집은 건너뜁니다 (capacity_history와 같은 패턴).
--
-- 수집: 기존 'alertLog' 모니터링 태스크와 같은 조건(V$DIAG_ALERT_EXT, 최근 2일분 중
-- ORA-/FAIL 포함 메시지)을 예약 일일점검 때 같은 대상 DB 커넥션으로 같이 모아 적재합니다.
-- 같은 DB+시각+메시지(해시)가 이미 있으면 건너뜁니다 (여러 번 실행해도 중복 안 쌓임).
-- message_text가 VARCHAR2(4000)이라 그대로 유니크 인덱스를 걸면 인덱스 키 크기 한도를
-- 넘기 쉬워서, 해시값(msg_hash)에 유니크 인덱스를 건다.

CREATE TABLE system.alert_log_history
(
    id             NUMBER         NOT NULL,
    dbms_id        NUMBER         NOT NULL,
    log_time       DATE           NOT NULL,   -- ORIGINATING_TIMESTAMP (+9시간 보정된 값)
    ora_code       VARCHAR2(12),              -- 메시지에서 뽑은 첫 ORA-NNNNN (없으면 NULL)
    message_type   VARCHAR2(30),
    message_level  NUMBER,
    message_text   VARCHAR2(4000),
    filename       VARCHAR2(512),
    msg_hash       VARCHAR2(40)   NOT NULL,   -- STANDARD_HASH(message_text,'MD5') — 중복 적재 방지용
    collected_at   DATE           DEFAULT SYSDATE NOT NULL,
    CONSTRAINT pk_alert_log_history PRIMARY KEY (id)
);

CREATE SEQUENCE system.alert_log_history_seq START WITH 1 INCREMENT BY 1 NOCACHE;

-- 중복 적재 방지 (같은 DB+시각+메시지 해시는 한 번만)
CREATE UNIQUE INDEX system.uq_alert_log_history ON system.alert_log_history (dbms_id, log_time, msg_hash);

-- 화면 검색(DB+ORA코드+기간) 조회용
CREATE INDEX system.ix_alert_log_history_search ON system.alert_log_history (dbms_id, ora_code, log_time);

COMMENT ON TABLE system.alert_log_history IS 'DB별 Alert Log(ORA-/FAIL) 수집 이력 — Monitoring > Alert Log';

CREATE TABLE system.alert_log_config
(
    id              NUMBER        NOT NULL,
    retention_days  NUMBER        DEFAULT 365 NOT NULL,  -- 보관 기간 (기본 1년)
    updatetime      VARCHAR2(20),
    CONSTRAINT pk_alert_log_config PRIMARY KEY (id)
);

INSERT INTO system.alert_log_config (id, retention_days) VALUES (1, 365);
COMMIT;
