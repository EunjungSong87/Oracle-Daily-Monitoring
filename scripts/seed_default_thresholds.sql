-- 기본 임계치 세트 (monitoring_thresholds)
--
-- task_id는 monitoring_tasks.name으로 서브쿼리해서 채웁니다. 실제 운영 DB의
-- monitoring_tasks 이름이 아래와 다르면 서브쿼리의 NAME 값을 맞춰서 고치세요.
-- (dailyChecks.js 기반 태스크 이름 기준으로 작성됨)
--
-- id는 매 INSERT 시점의 MAX(id)+1로 계산되므로, 각 문장을 순서대로(하나씩) 실행하세요.

-- 1) Instance Status / Instance Info: OPEN이 아니면 심각
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Instance Status'),
        'STATUS', 'STRING', '!=', 'OPEN', 'ERROR', '인스턴스 상태가 OPEN이 아님', 'Y', SYSDATE);
COMMIT;

INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Instance Info'),
        'STATUS', 'STRING', '!=', 'OPEN', 'ERROR', '인스턴스 상태가 OPEN이 아님', 'Y', SYSDATE);
COMMIT;

-- 2) Control File: STATUS가 INVALID면 심각
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Control File'),
        'STATUS', 'STRING', '=', 'INVALID', 'ERROR', '컨트롤파일 상태 INVALID', 'Y', SYSDATE);
COMMIT;

-- 3) ASM Disk Usage: 사용률 90% 초과
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'ASM Disk Usage'),
        'usgae(%)', 'NUMERIC', '>', '90', 'WARN', 'ASM 디스크 사용률 90% 초과', 'Y', SYSDATE);
COMMIT;

-- 4) Temp File: TEMP_STATUS_CHECK 컬럼이 이미 이상신호용으로 만들어져 있음
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Temp File'),
        'TEMP_STATUS_CHECK', 'PATTERN', 'LIKE', 'CHECK', 'WARN', '임시파일 상태 확인 필요', 'Y', SYSDATE);
COMMIT;

-- 5) Tablespace Online Check: 쿼리 자체가 비정상만 필터링하지만, 강조 표시용으로 추가
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Tablespace Online Check'),
        'STATUS', 'STRING', '!=', 'ONLINE', 'ERROR', '테이블스페이스가 ONLINE 상태가 아님', 'Y', SYSDATE);
COMMIT;

-- 6) Parse CPU / Elapsed Ratio: 90% 미만이면 경고 (컬럼명에 후행 공백 있음, 실제 컬럼명과 정확히 일치해야 함)
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Parse CPU / Elapsed Ratio'),
        'Parse CPU to Parse Elapsed % 90%이상 ', 'NUMERIC', '<', '90', 'WARN', 'Parse CPU/Elapsed 비율 90% 미만', 'Y', SYSDATE);
COMMIT;

-- 7) Tablespace Usage: 95% 초과는 ERROR로 한 단계 더 (90% WARN은 이미 있음)
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Tablespace Usage'),
        'USED(%)', 'NUMERIC', '>', '95', 'ERROR', '테이블스페이스 사용률 95% 초과', 'Y', SYSDATE);
COMMIT;

-- 8) DB Scheduler Check: 잡 상태 FAILED
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'DB Scheduler Check'),
        'STATE', 'STRING', '=', 'FAILED', 'ERROR', '스케줄러 잡 실패', 'Y', SYSDATE);
COMMIT;

-- 9) RMAN Backup Check: STATUS FAILED
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'RMAN Backup Check'),
        'STATUS', 'STRING', '=', 'FAILED', 'ERROR', 'RMAN 백업 실패', 'Y', SYSDATE);
COMMIT;

-- 10) ASM Disk Group Check: 사용률 90% 초과
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'ASM Disk Group Check'),
        'usgae(%)', 'NUMERIC', '>', '90', 'WARN', 'ASM 디스크그룹 사용률 90% 초과', 'Y', SYSDATE);
COMMIT;

-- 11) Recovery Area Usage: FRA 사용률 85% 초과
INSERT INTO system.monitoring_thresholds (id, task_id, column_name, condition_type, operator, threshold, clevel, message, is_active, created_at)
VALUES ((SELECT NVL(MAX(id),0)+1 FROM system.monitoring_thresholds),
        (SELECT id FROM system.monitoring_tasks WHERE name = 'Recovery Area Usage'),
        'PERCENT_SPACE_USED', 'NUMERIC', '>', '85', 'WARN', 'FRA(Fast Recovery Area) 사용률 85% 초과', 'Y', SYSDATE);
COMMIT;
