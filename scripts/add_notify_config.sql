-- 계정 > 알림 설정: 신규/재오픈 Issues 티켓 알림(Telegram/Slack/사내 메일)을 화면에서 설정하기 위한 테이블.
-- 메타데이터 DB에 한 번만 실행하세요.
-- (2026-11-19 이전 버전 — 메일 컬럼 없음 — 으로 이미 실행했다면 이 파일 대신 add_notify_config_mail.sql만 실행)
--
-- 행(id=1)이 있으면 이 값이 .env의 TELEGRAM_* / SLACK_WEBHOOK_URL / SMTP_* / MAIL_*보다 우선합니다.
-- 테이블이 없거나 아직 한 번도 저장하지 않았으면 .env 값으로 동작합니다.
-- 봇 토큰, 웹훅 URL, SMTP 비밀번호는 대상 DB 비밀번호와 같은 방식(AES-256-GCM, .env의 DBMS_ENCRYPTION_KEY)으로
-- 암호화해서 저장합니다 — DBMS_ENCRYPTION_KEY가 바뀌면 화면에서 다시 입력해야 합니다.

CREATE TABLE system.notify_config
(
    id                  NUMBER          NOT NULL,
    telegram_enabled    CHAR(1)         DEFAULT 'N' NOT NULL,
    telegram_token_enc  VARCHAR2(1000),            -- 암호화된 봇 토큰
    telegram_chat_id    VARCHAR2(100),
    slack_enabled       CHAR(1)         DEFAULT 'N' NOT NULL,
    slack_webhook_enc   VARCHAR2(2000),            -- 암호화된 Incoming Webhook URL
    mail_enabled        CHAR(1)         DEFAULT 'N' NOT NULL,
    smtp_host           VARCHAR2(255),
    smtp_port           NUMBER(5),
    smtp_secure         CHAR(1)         DEFAULT 'N' NOT NULL,  -- Y = 접속부터 TLS (보통 465)
    smtp_tls_insecure   CHAR(1)         DEFAULT 'N' NOT NULL,  -- Y = 사설 인증서 검증 생략
    smtp_user           VARCHAR2(255),             -- 비우면 인증 없이
    smtp_password_enc   VARCHAR2(1000),            -- 암호화된 SMTP 비밀번호
    mail_from           VARCHAR2(320),
    mail_to             VARCHAR2(4000),            -- 받는 사람 (쉼표 구분)
    updatetime          VARCHAR2(20),
    updated_by          VARCHAR2(100),
    CONSTRAINT pk_notify_config PRIMARY KEY (id),
    CONSTRAINT ck_notify_config_tg CHECK (telegram_enabled IN ('Y', 'N')),
    CONSTRAINT ck_notify_config_sl CHECK (slack_enabled IN ('Y', 'N')),
    CONSTRAINT ck_notify_config_ml CHECK (mail_enabled IN ('Y', 'N')),
    CONSTRAINT ck_notify_config_ms CHECK (smtp_secure IN ('Y', 'N')),
    CONSTRAINT ck_notify_config_mi CHECK (smtp_tls_insecure IN ('Y', 'N'))
);

COMMENT ON TABLE system.notify_config IS 'Issues 티켓 알림 채널 설정 (Telegram/Slack/사내 메일) — 계정 > 알림 설정';
