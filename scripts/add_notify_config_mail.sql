-- 계정 > 알림 설정에 사내 메일(SMTP) 채널 컬럼 추가.
-- add_notify_config.sql을 2026-11-19 이전 버전(메일 컬럼 없음)으로 이미 실행한 메타데이터 DB에서만 한 번 실행하세요.
-- 새로 설치하는 곳은 add_notify_config.sql에 이미 들어 있으므로 실행하지 않습니다.
-- 안 돌리면 알림 설정 화면은 "메일 컬럼 없음" 안내와 함께 저장이 막히고, 알림은 .env 값으로 동작합니다.

ALTER TABLE system.notify_config ADD (
    mail_enabled        CHAR(1)         DEFAULT 'N' NOT NULL,
    smtp_host           VARCHAR2(255),
    smtp_port           NUMBER(5),
    smtp_secure         CHAR(1)         DEFAULT 'N' NOT NULL,
    smtp_tls_insecure   CHAR(1)         DEFAULT 'N' NOT NULL,
    smtp_user           VARCHAR2(255),
    smtp_password_enc   VARCHAR2(1000),
    mail_from           VARCHAR2(320),
    mail_to             VARCHAR2(4000),
    CONSTRAINT ck_notify_config_ml CHECK (mail_enabled IN ('Y', 'N')),
    CONSTRAINT ck_notify_config_ms CHECK (smtp_secure IN ('Y', 'N')),
    CONSTRAINT ck_notify_config_mi CHECK (smtp_tls_insecure IN ('Y', 'N'))
);

COMMENT ON TABLE system.notify_config IS 'Issues 티켓 알림 채널 설정 (Telegram/Slack/사내 메일) — 계정 > 알림 설정';
