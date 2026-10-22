-- Monitoring > Capacity: 테이블스페이스 / ASM 디스크그룹 사용량을 날마다 쌓아 추이와 소진 예상일을 보여 주기 위한 스키마.
-- 메타데이터 DB에 한 번만 실행하세요. 없으면 Capacity 화면은 "설치 필요"만 표시하고, 예약 점검의 수집은 건너뜁니다.
--
-- 예약 일일점검 때 같은 대상 DB 커넥션으로 한 번 수집합니다 (DBA_TABLESPACE_USAGE_METRICS, V$ASM_DISKGROUP_STAT).
-- 하루 1행 (같은 날 다시 돌면 덮어씀).

CREATE TABLE system.capacity_history
(
    dbms_id       NUMBER         NOT NULL,
    collected_on  DATE           NOT NULL,  -- 수집일 (TRUNC)
    kind          VARCHAR2(12)   NOT NULL,  -- TABLESPACE | ASM
    name          VARCHAR2(128)  NOT NULL,
    used_bytes    NUMBER,
    max_bytes     NUMBER,                   -- 테이블스페이스: 자동 확장 최대치 기준 크기, ASM: TOTAL
    collected_at  DATE,
    CONSTRAINT pk_capacity_history PRIMARY KEY (dbms_id, kind, name, collected_on)
);

CREATE TABLE system.capacity_config
(
    id              NUMBER        NOT NULL,
    retention_days  NUMBER        DEFAULT 730 NOT NULL,  -- 보관 기간 (기본 2년)
    alert_days      NUMBER        DEFAULT 30  NOT NULL,  -- 예상일이 이 일수 안이면 이슈 티켓
    threshold_pct   NUMBER        DEFAULT 100 NOT NULL,  -- 이 사용률(%)에 도달하는 날을 예측
    updatetime      VARCHAR2(20),
    CONSTRAINT pk_capacity_config PRIMARY KEY (id)
);

INSERT INTO system.capacity_config (id, retention_days, alert_days, threshold_pct) VALUES (1, 730, 30, 100);
COMMIT;

COMMENT ON TABLE system.capacity_history IS '테이블스페이스/ASM 사용량 일별 이력 — Monitoring > Capacity';
