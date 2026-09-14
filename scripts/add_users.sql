-- 로그인 계정을 위한 스키마 변경.
-- 운영 DB에는 이 파일을 한 번만 실행하세요.
-- 최초 관리자 계정은 이 테이블 생성 후 scripts/create-admin-user.ts로 만듭니다.

CREATE TABLE system.users
(
    id             NUMBER          NOT NULL,
    username       VARCHAR2(50)    NOT NULL,
    password_hash  VARCHAR2(255)   NOT NULL,   -- 'scrypt:<saltHex>:<hashHex>'
    display_name   VARCHAR2(100),
    is_admin       CHAR(1)         DEFAULT 'N' NOT NULL,  -- Y | N
    is_active      CHAR(1)         DEFAULT 'Y' NOT NULL,  -- Y | N (삭제 대신 비활성화)
    created_at     VARCHAR2(20)    NOT NULL,   -- 'YYYYMMDDHH24MISS'
    last_login_at  VARCHAR2(20),
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT uq_users_username UNIQUE (username)
);

COMMENT ON TABLE system.users IS '앱 로그인 계정';
COMMENT ON COLUMN system.users.password_hash IS 'Node crypto.scrypt 해시. 형식: scrypt:<salt hex>:<hash hex>';
COMMENT ON COLUMN system.users.is_active IS '삭제 대신 비활성화 — 과거 티켓의 assignee/author 값 의미를 보존';
