-- Minimal seed data so the app has something to run immediately after
-- `docker compose up`. If you changed ORACLE_PASSWORD when starting the
-- container, update the PASSWORD value below to match (or just add/edit
-- the DBMS entry from the app's "Add DBMS" screen instead).

ALTER SESSION SET CONTAINER = FREEPDB1;

-- One monitoring task with no embedded quotes, so it's safe to inline here.
INSERT INTO system.monitoring_tasks (id, name, category, description, sql_text, schedule, is_active)
VALUES (
  1,
  'Instance Status',
  'daily',
  'Check instance status and uptime',
  'select instance_name, host_name, version, status from v$instance',
  'daily',
  'Y'
);

-- Registers this same container as a monitored target, so the app can
-- self-monitor without needing a second Oracle instance.
INSERT INTO system.monitoring_dbms_list
  (id, dbname, username, password, sid, ip, port, memo, createtime, updatetime)
VALUES (
  system.seq_monitoring_dbms_list.nextval,
  'FREEPDB1-local',
  'system',
  'OraTest_2026!',
  'FREEPDB1',
  'localhost',
  '1521',
  'docker test target (self)',
  to_char(sysdate, 'YYYYMMDD'),
  to_char(sysdate, 'YYYYMMDD')
);

COMMIT;
