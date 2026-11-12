-- ============================================================================
-- 삭제(DROP) 가능한 데이터파일 확인
--  - "완전히 비어있는(사용 중인 익스텐트가 0인)" 데이터파일을 찾아서
--    ALTER TABLESPACE ... DROP DATAFILE 또는 DROP TABLESPACE 로
--    실제 파일을 지울 수 있는지 판단하기 위한 점검 스크립트.
--
--  판단 기준
--   1) DBA_FREE_SPACE 로 파일 전체 바이트가 거의 100% 여유공간인지 확인
--      (헤더블록 등으로 1MB 이내 오차는 허용)
--   2) PERMANENT 타입 테이블스페이스만 대상 (UNDO/TEMP/SYSTEM/SYSAUX 는 제외)
--   3) 같은 테이블스페이스에 데이터파일이 2개 이상이면 DROP DATAFILE 가능,
--      1개뿐이면 테이블스페이스 전체를 DROP 해야 함 (DROP DATAFILE 불가)
-- ============================================================================

SELECT  df.tablespace_name,
        df.file_id,
        df.file_name,
        ROUND(df.bytes/1024/1024,1)                           AS total_mb,
        ROUND(NVL(fs.free_bytes,0)/1024/1024,1)                AS free_mb,
        ROUND((df.bytes - NVL(fs.free_bytes,0))/1024/1024,1)   AS used_mb,
        df.autoextensible,
        df.status,
        ts.contents,
        ts.status                                               AS ts_status,
        cnt.file_cnt_in_ts,
        CASE
          WHEN ts.contents != 'PERMANENT'
               OR df.tablespace_name IN ('SYSTEM','SYSAUX')
            THEN 'SKIP (SYSTEM/SYSAUX/UNDO/TEMP)'
          WHEN NVL(fs.free_bytes,0) < df.bytes - 1048576
            THEN NULL                                   -- 사용 중인 블록 존재 -> 삭제 불가
          WHEN cnt.file_cnt_in_ts > 1
            THEN 'DROP_DATAFILE 가능'
          ELSE 'TABLESPACE 전체 DROP 필요 (파일이 TS 내 유일)'
        END                                                      AS check_result
FROM    dba_data_files df
        JOIN dba_tablespaces ts
          ON ts.tablespace_name = df.tablespace_name
        LEFT JOIN (
            SELECT file_id, SUM(bytes) free_bytes
            FROM   dba_free_space
            GROUP BY file_id
        ) fs ON fs.file_id = df.file_id
        JOIN (
            SELECT tablespace_name, COUNT(*) file_cnt_in_ts
            FROM   dba_data_files
            GROUP BY tablespace_name
        ) cnt ON cnt.tablespace_name = df.tablespace_name
ORDER   BY check_result NULLS LAST, used_mb;


-- ----------------------------------------------------------------------------
-- 위 결과에서 check_result 가 'DROP_DATAFILE 가능' 또는
-- 'TABLESPACE 전체 DROP 필요' 로 나온 건만 아래처럼 실제 삭제 가능
-- (실행 전 반드시 세그먼트가 정말 없는지, 백업이 있는지 재확인할 것!)
-- ----------------------------------------------------------------------------

-- 1) 테이블스페이스에 파일이 여러 개이고 그 중 한 파일만 비어있는 경우
--    ALTER TABLESPACE <TABLESPACE_NAME> DROP DATAFILE '<FILE_NAME>';

-- 2) 테이블스페이스 전체(모든 파일)가 비어있고 더 이상 쓰지 않는 경우
--    DROP TABLESPACE <TABLESPACE_NAME> INCLUDING CONTENTS AND DATAFILES;

-- 3) (참고) 실제로 세그먼트가 하나도 없는지 직접 확인하고 싶다면:
--    SELECT owner, segment_name, segment_type, bytes/1024/1024 MB
--      FROM dba_segments
--     WHERE tablespace_name = '<TABLESPACE_NAME>';
