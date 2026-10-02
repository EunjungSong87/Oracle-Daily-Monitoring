-- Compare > Parameter Compare 화면에서 hidden(_) 파라미터까지 전부 비교하려면
-- 대상 DB에서 SYS로 1회 실행하세요.
--
-- hidden 파라미터 전체는 X$KSPPI(이름/설명) / X$KSPPSV(인스턴스 기준 값) 에만 있고, X$ 테이블은 SYS 외에는 직접
-- grant할 수 없습니다. 그래서 SYS 소유의 래퍼 뷰를 만들고 그 뷰에 SELECT를 줍니다.
-- (읽기 전용 뷰 2개 — 다른 오브젝트/설정은 바꾸지 않습니다)
--
-- 이 스크립트를 실행하지 않아도 화면은 동작합니다. 그 경우 V$SYSTEM_PARAMETER로 비교하며,
-- hidden 파라미터는 직접 설정한(기본값이 아닌) 것만 비교되고 화면에 "hidden 미포함"으로 표시됩니다.
--
-- 사용법 (sqlplus):
--   sqlplus / as sysdba
--   -- CDB 환경이면 앱이 접속하는 컨테이너(PDB)로 먼저 이동:  ALTER SESSION SET CONTAINER = <PDB명>;
--   @scripts/grant_hidden_parameter_views.sql <앱이 대상 DB에 접속하는 계정>
--   예)  @scripts/grant_hidden_parameter_views.sql SYSTEM

DEFINE grantee = &1

CREATE OR REPLACE VIEW sys.x_$ksppi AS SELECT * FROM x$ksppi;
CREATE OR REPLACE VIEW sys.x_$ksppsv AS SELECT * FROM x$ksppsv;

GRANT SELECT ON sys.x_$ksppi TO &grantee;
GRANT SELECT ON sys.x_$ksppsv TO &grantee;

UNDEFINE grantee
