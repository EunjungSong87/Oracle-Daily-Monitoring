-- Data Pump: Export 분할 묶음과 파티션 정보를 메타데이터 DB에 남긴다 ("이 Export로 Import 만들기", 이력 기반 파티션 Import).
-- add_datapump_history.sql 다음에 한 번만 실행하세요. 안 돌려도 앱은 동작하지만, 이 스크립트 이후에 실행한 Export만
-- Import 생성·이력 기반 파티션 Import에 쓸 수 있습니다 (그 전 작업은 "이력 정보 부족"으로 표시).

-- 작업 이력에 묶음/요청 원문/덤프 파일별 크기
ALTER TABLE system.datapump_job_history ADD (
    bundle_id      VARCHAR2(64),   -- Export 분할 계획 하나 (같은 계획에서 나온 작업들)
    bundle_job_no  NUMBER,         -- 계획의 작업 번호 (스키마별로 나눠 실행한 하위 작업은 같은 번호)
    request_json   CLOB,           -- 실행한 요청 원문 (대상, 떼어 낸 테이블, QUERY/SAMPLE, FLASHBACK_SCN, DUMPFILE 패턴 …)
    dump_files     CLOB            -- 끝날 때 덤프 파일별 이름·크기 JSON [{name, bytes}]
);

CREATE INDEX idx_datapump_history_bundle ON system.datapump_job_history (bundle_id);

-- Export 분할 계획 (실행하거나 parfile을 저장할 때 한 번 남김)
CREATE TABLE system.datapump_export_bundle
(
    bundle_id     VARCHAR2(64)   NOT NULL,
    dbms_id       NUMBER         NOT NULL,
    dbname        VARCHAR2(100),
    job_count     NUMBER,
    missing       CLOB,          -- DB에 없어 뺀 항목 JSON
    filtered_out  CLOB,          -- 필터로 뺀 테이블 JSON
    created_by    VARCHAR2(100),
    created_at    DATE,
    CONSTRAINT pk_datapump_export_bundle PRIMARY KEY (bundle_id)
);

CREATE INDEX idx_datapump_bundle_dbms ON system.datapump_export_bundle (dbms_id, created_at);

-- 계획의 작업별 대상
CREATE TABLE system.datapump_export_bundle_job
(
    bundle_id       VARCHAR2(64)   NOT NULL,
    job_no          NUMBER         NOT NULL,
    job_name        VARCHAR2(128)  NOT NULL,
    job_mode        VARCHAR2(10),
    request_json    CLOB,          -- 계획한 요청 원문
    expected_items  CLOB,          -- 계획 대상 JSON (OWNER.TABLE / OWNER.TABLE:PART)
    table_sizes     CLOB,          -- 계획 때 테이블별 예상 크기 JSON [{owner, name, bytes}] (테이블 + LOB)
    excluded_tables CLOB,          -- 스키마 작업에서 다른 작업으로 떼어 낸 테이블 JSON
    CONSTRAINT pk_datapump_bundle_job PRIMARY KEY (bundle_id, job_no)
);

CREATE INDEX idx_datapump_bundle_job_name ON system.datapump_export_bundle_job (job_name);

-- 파티션 단위로 내보낸 파티션 (매니페스트 파일 대신 — 파티션 Import와 Import 생성이 여기서 읽는다)
CREATE TABLE system.datapump_partition_history
(
    bundle_id       VARCHAR2(64)   NOT NULL,
    job_no          NUMBER         NOT NULL,
    owner           VARCHAR2(128)  NOT NULL,
    table_name      VARCHAR2(128)  NOT NULL,
    partition_name  VARCHAR2(128)  NOT NULL,
    position        NUMBER,
    high_value      VARCHAR2(4000),
    range_low       VARCHAR2(19),   -- 'YYYY-MM-DD HH24:MI:SS' (NULL = 하한 없음)
    range_high      VARCHAR2(19),   -- NULL = MAXVALUE
    known           CHAR(1),        -- 범위를 날짜로 해석했는지 (Y/N)
    est_bytes       NUMBER,
    num_rows        NUMBER,
    dumpfile        VARCHAR2(400),
    key_column      VARCHAR2(128),
    key_type        VARCHAR2(106),
    interval_expr   VARCHAR2(1000),
    CONSTRAINT pk_datapump_partition_history PRIMARY KEY (bundle_id, owner, table_name, partition_name)
);
