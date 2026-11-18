-- 계정 > 알림 설정: 신규/재오픈 Issues 티켓 알림(Telegram/Slack)을 화면에서 설정하기 위한 테이블.
-- 메타데이터 DB에 한 번만 실행하세요.
--
-- 행(id=1)이 있으면 이 값이 .env의 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / SLACK_WEBHOOK_URL보다 우선합니다.
-- 테이블이 없거나 아직 한 번도 저장하지 않았으면 예전처럼 .env 값으로 동작합니다.
-- 봇 토큰과 웹훅 URL은 대상 DB 비밀번호와 같은 방식(AES-256-GCM, .env의 DBMS_ENCRYPTION_KEY)으로
-- 암호화해서 저장합니다 — DBMS_ENCRYPTION_KEY가 바뀌면 화면에서 다시 입력해야 합니다.

CREATE TABLE system.notify_config
(
    id                  NUMBER          NOT NULL,
    telegram_enabled    CHAR(1)         DEFAULT 'N' NOT NULL,
    telegram_token_enc  VARCHAR2(1000),            -- 암호화된 봇 토큰
    telegram_chat_id    VARCHAR2(100),
    slack_enabled       CHAR(1)         DEFAULT 'N' NOT NULL,
    slack_webhook_enc   VARCHAR2(2000),            -- 암호화된 Incoming Webhook URL
    updatetime          VARCHAR2(20),
    updated_by          VARCHAR2(100),
    CONSTRAINT pk_notify_config PRIMARY KEY (id),
    CONSTRAINT ck_notify_config_tg CHECK (telegram_enabled IN ('Y', 'N')),
    CONSTRAINT ck_notify_config_sl CHECK (slack_enabled IN ('Y', 'N'))
);

COMMENT ON TABLE system.notify_config IS 'Issues 티켓 알림 채널 설정 (Telegram/Slack) — 계정 > 알림 설정';
