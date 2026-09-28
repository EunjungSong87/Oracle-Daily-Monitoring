-- Runs automatically on first container startup, executed as SYS.
-- Adds the login/role and ticket-system tables so a fresh test container
-- gets the full schema in one shot (mirrors scripts/add_users.sql +
-- scripts/add_user_roles.sql + scripts/add_monitoring_issues.sql, but
-- baked into their final shape directly since there's no existing data
-- to migrate on a brand-new container).
--
-- No initial login account is created here — run, after the container is
-- healthy:
--   npx tsx scripts/create-admin-user.ts <username> <password> [displayName]

ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE TABLE system.users
(
    id             NUMBER          NOT NULL,
    username       VARCHAR2(50)    NOT NULL,
    password_hash  VARCHAR2(255)   NOT NULL,   -- 'scrypt:<saltHex>:<hashHex>'
    display_name   VARCHAR2(100),
    role           VARCHAR2(20)    DEFAULT 'VIEWER' NOT NULL,  -- VIEWER | DBA | SUPER_ADMIN
    is_active      CHAR(1)         DEFAULT 'Y' NOT NULL,  -- Y | N (삭제 대신 비활성화)
    created_at     VARCHAR2(20)    NOT NULL,   -- 'YYYYMMDDHH24MISS'
    last_login_at  VARCHAR2(20),
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT uq_users_username UNIQUE (username)
);

COMMENT ON TABLE system.users IS '앱 로그인 계정';
COMMENT ON COLUMN system.users.password_hash IS 'Node crypto.scrypt 해시. 형식: scrypt:<salt hex>:<hash hex>';
COMMENT ON COLUMN system.users.role IS 'VIEWER | DBA | SUPER_ADMIN';
COMMENT ON COLUMN system.users.is_active IS '삭제 대신 비활성화 — 과거 티켓의 assignee/author 값 의미를 보존';

CREATE TABLE system.monitoring_issues
(
    id                     NUMBER          NOT NULL,
    dbms_id                NUMBER          NOT NULL,
    dbname                 VARCHAR2(50),
    task_id                NUMBER          NOT NULL,
    task_name              VARCHAR2(100),
    column_name            VARCHAR2(100)   NOT NULL,
    clevel                 VARCHAR2(10),            -- WARN | ERROR (INFO는 티켓화하지 않음)
    message                VARCHAR2(255),
    value                  VARCHAR2(255),           -- 대표 값(카드 표시용, 마지막 감지 값)
    occurrence_count       NUMBER          DEFAULT 1 NOT NULL,
    details                CLOB,                    -- 최근 실행에서 위반한 모든 행의 스냅샷 (JSON 배열)
    status                 VARCHAR2(20)    DEFAULT 'OPEN' NOT NULL,   -- OPEN | ACKNOWLEDGED | RESOLVED
    assignee               VARCHAR2(100),
    first_seen_at          VARCHAR2(20)    NOT NULL,  -- 'YYYYMMDDHH24MISS'
    last_seen_at           VARCHAR2(20)    NOT NULL,
    acknowledged_at        VARCHAR2(20),
    acknowledged_by        VARCHAR2(100),
    resolved_at            VARCHAR2(20),
    resolved_by            VARCHAR2(100),            -- 'auto' 또는 사용자 입력
    reopen_count           NUMBER          DEFAULT 0 NOT NULL,
    latest_run_history_id  NUMBER,                   -- system.monitoring_run_history.id (formal FK 없음, 기존 관례)
    created_at             VARCHAR2(20)    NOT NULL,
    updated_at             VARCHAR2(20)    NOT NULL,
    CONSTRAINT pk_monitoring_issues PRIMARY KEY (id),
    CONSTRAINT uq_monitoring_issues_key UNIQUE (dbms_id, task_id, column_name)
);

CREATE INDEX idx_monitoring_issues_status ON system.monitoring_issues (status, dbms_id);

CREATE TABLE system.monitoring_issue_comments
(
    id            NUMBER          NOT NULL,
    issue_id      NUMBER          NOT NULL,          -- system.monitoring_issues.id (formal FK 없음, 기존 관례)
    comment_type  VARCHAR2(20)    DEFAULT 'COMMENT' NOT NULL,  -- COMMENT | STATUS_CHANGE
    author        VARCHAR2(100),                     -- 'system'(자동 기록) 또는 사용자 입력
    comment_text  VARCHAR2(4000)  NOT NULL,
    created_at    VARCHAR2(20)    NOT NULL,
    CONSTRAINT pk_monitoring_issue_comments PRIMARY KEY (id)
);

CREATE INDEX idx_monitoring_issue_comments_issue ON system.monitoring_issue_comments (issue_id, created_at);

COMMENT ON TABLE system.monitoring_issues IS '임계치 위반 티켓 (상태/담당자 포함, 영구 저장)';
COMMENT ON COLUMN system.monitoring_issues.status IS 'OPEN: 미확인, ACKNOWLEDGED: 확인함, RESOLVED: 해결됨(자동 또는 수동)';
COMMENT ON COLUMN system.monitoring_issues.occurrence_count IS '가장 최근 실행에서 이 (task,column) 조합으로 위반한 행 개수';
COMMENT ON COLUMN system.monitoring_issues.details IS '가장 최근 실행에서 위반한 모든 행의 스냅샷(JSON 배열)';
COMMENT ON TABLE system.monitoring_issue_comments IS '티켓 댓글/상태변경 이력 (comment_type=STATUS_CHANGE는 자동 기록)';
