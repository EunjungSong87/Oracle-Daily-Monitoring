-- 사용자별 화면 표시 설정 (계정 관리 > 화면 권한). 메타데이터 DB에 한 번만 실행하세요.
-- add_users.sql / add_user_roles.sql 다음에 실행해야 합니다 (users 테이블을 참조).
--
-- 기본은 역할(VIEWER/DBA/SUPER_ADMIN)이 정하고, 여기에는 역할 기본과 다르게 둔 것만 저장합니다:
--   visible = 'Y' → 역할 기본으로는 안 보이는 화면을 이 사용자에게 보이게
--   visible = 'N' → 역할 기본으로는 보이는 화면을 이 사용자에게서 숨김
-- 숨긴 화면은 메뉴/페이지/API 모두 막힙니다. 행이 없으면 역할 기본값 그대로입니다.

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
