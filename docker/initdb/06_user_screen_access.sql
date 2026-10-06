-- Local Docker test DB copy of scripts/add_user_screen_access.sql (per-user screen visibility).
ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE TABLE system.user_screen_access
(
    user_id      NUMBER        NOT NULL,
    screen_key   VARCHAR2(40)  NOT NULL,
    visible      CHAR(1)       NOT NULL,
    updated_by   VARCHAR2(50),
    updated_at   DATE          DEFAULT SYSDATE NOT NULL,
    CONSTRAINT pk_user_screen_access PRIMARY KEY (user_id, screen_key),
    CONSTRAINT fk_user_screen_access_user FOREIGN KEY (user_id) REFERENCES system.users (id) ON DELETE CASCADE,
    CONSTRAINT ck_user_screen_access_visible CHECK (visible IN ('Y', 'N'))
);

COMMENT ON TABLE system.user_screen_access IS '사용자별 화면 표시 예외 (역할 기본값과 다른 것만 저장)';
