-- 로그인 계정에 3단계 권한(VIEWER < DBA < SUPER_ADMIN)을 도입하는 스키마 변경.
-- system.users 테이블은 이미 배포되어 있다는 전제로 ALTER로 마이그레이션합니다.
-- 운영 DB에는 이 파일을 한 번만 실행하세요.

ALTER TABLE system.users ADD role VARCHAR2(20) DEFAULT 'VIEWER' NOT NULL;

UPDATE system.users SET role = 'SUPER_ADMIN' WHERE is_admin = 'Y';

ALTER TABLE system.users DROP COLUMN is_admin;

COMMENT ON COLUMN system.users.role IS 'VIEWER | DBA | SUPER_ADMIN';
