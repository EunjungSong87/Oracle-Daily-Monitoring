-- Data Pump 작업 이력에 "빠진 항목 확인"과 "실행 후 로그 대조" 결과를 남기기 위한 컬럼 추가.
-- add_datapump_history.sql 다음에 메타데이터 DB에 한 번만 실행하세요. 실행하지 않아도 앱은 동작합니다(이 정보만 안 남음).

ALTER TABLE system.datapump_job_history ADD (
    acknowledged_excluded CLOB,          -- 사용자가 확인하고 뺀 항목 JSON {missing:[], filteredOut:[], by}
    expected_items        CLOB,          -- 계획 대상 목록 JSON (OWNER.TABLE / OWNER.TABLE:PART)
    log_items             CLOB,          -- 로그의 exported/imported 줄 JSON (테이블·파티션별 행 수)
    verify_status         VARCHAR2(20),  -- MATCH | MISMATCH | NA
    verify_detail         CLOB,          -- JSON {notInLog:[], notInPlan:[], skipped:[], rowDiffs:[]}
    error_summary         VARCHAR2(4000) -- 로그의 ORA- 줄 요약
);

COMMENT ON COLUMN system.datapump_job_history.verify_status IS 'MATCH | MISMATCH | NA — 계획 대상 vs 로그 대조';
