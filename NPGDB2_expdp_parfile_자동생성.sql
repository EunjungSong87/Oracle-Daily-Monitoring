DROP TABLE EXPDP_PAR_PLAN PURGE;

CREATE TABLE EXPDP_PAR_PLAN (
    RUN_ID          VARCHAR2(50),
    BUCKET_NO       NUMBER,
    OWNER           VARCHAR2(128),
    TABLE_NAME      VARCHAR2(128),
    PARTITION_NAME  VARCHAR2(128),
    OBJECT_TYPE     VARCHAR2(30),
    BYTES           NUMBER,
    GB              NUMBER,
    OVER_TARGET_YN  VARCHAR2(1),
    CREATED_AT      DATE DEFAULT SYSDATE
);


CREATE OR REPLACE PROCEDURE GEN_EXPDP_PAR_FILES (
    p_owner              IN VARCHAR2,
    p_par_dir            IN VARCHAR2 DEFAULT 'EXPDP_PAR_DIR',
    p_dump_dir           IN VARCHAR2 DEFAULT 'EXPDP_DUMP_DIR',
    p_prefix             IN VARCHAR2 DEFAULT 'exp',
    p_target_size_gb     IN NUMBER   DEFAULT 1024,
    p_filesize           IN VARCHAR2 DEFAULT '1024G',
    p_parallel           IN NUMBER   DEFAULT 4,
    p_include_indexes    IN VARCHAR2 DEFAULT 'N',
    p_exclude_statistics IN VARCHAR2 DEFAULT 'Y',
    p_cluster            IN VARCHAR2 DEFAULT 'N',
    p_partition_split    IN VARCHAR2 DEFAULT 'Y'
)
IS
    TYPE t_bucket_size IS TABLE OF NUMBER INDEX BY PLS_INTEGER;

    v_bucket_size   t_bucket_size;
    v_bucket_no     NUMBER := 0;
    v_run_id        VARCHAR2(50);
    v_file          UTL_FILE.FILE_TYPE;
    v_filename      VARCHAR2(200);
    v_line          VARCHAR2(32767);
    v_piece         VARCHAR2(1000);
    v_first         BOOLEAN;
    v_total_bytes   NUMBER := 0;
    v_target_bytes  NUMBER;
    v_over_target   VARCHAR2(1);

    FUNCTION qname (
        p_name VARCHAR2
    ) RETURN VARCHAR2
    IS
    BEGIN
        RETURN '"' || REPLACE(p_name, '"', '""') || '"';
    END;

    FUNCTION expdp_table_expr (
        p_owner          VARCHAR2,
        p_table_name     VARCHAR2,
        p_partition_name VARCHAR2
    ) RETURN VARCHAR2
    IS
    BEGIN
        IF p_partition_name IS NULL THEN
            RETURN qname(p_owner) || '.' || qname(p_table_name);
        ELSE
            RETURN qname(p_owner) || '.' || qname(p_table_name) || ':' || qname(p_partition_name);
        END IF;
    END;

BEGIN
    IF p_target_size_gb <= 0 THEN
        RAISE_APPLICATION_ERROR(-20001, 'p_target_size_gb must be greater than 0');
    END IF;

    v_target_bytes := p_target_size_gb * 1024 * 1024 * 1024;
    v_run_id := TO_CHAR(SYSTIMESTAMP, 'YYYYMMDDHH24MISSFF3');

    DELETE FROM EXPDP_PAR_PLAN
     WHERE OWNER = UPPER(p_owner);

    /*
      오브젝트 단위:
      - 일반 테이블: TABLE 단위
      - 파티션 테이블: TABLE:PARTITION 단위
      - p_partition_split = 'N'이면 파티션 테이블도 TABLE 단위
    */
    FOR r IN (
        WITH
        normal_table_segments AS (
            SELECT
                t.owner,
                t.table_name,
                CAST(NULL AS VARCHAR2(128)) AS partition_name,
                'TABLE' AS object_type,
                s.bytes
            FROM dba_tables t
            JOIN dba_segments s
              ON s.owner = t.owner
             AND s.segment_name = t.table_name
            WHERE t.owner = UPPER(p_owner)
              AND t.partitioned = 'NO'
              AND s.segment_type IN ('TABLE', 'NESTED TABLE')

            UNION ALL

            SELECT
                l.owner,
                l.table_name,
                CAST(NULL AS VARCHAR2(128)) AS partition_name,
                'TABLE' AS object_type,
                s.bytes
            FROM dba_lobs l
            JOIN dba_segments s
              ON s.owner = l.owner
             AND s.segment_name IN (l.segment_name, l.index_name)
            JOIN dba_tables t
              ON t.owner = l.owner
             AND t.table_name = l.table_name
            WHERE l.owner = UPPER(p_owner)
              AND t.partitioned = 'NO'
              AND s.segment_type IN ('LOBSEGMENT', 'LOBINDEX')

            UNION ALL

            SELECT
                i.owner,
                i.table_name,
                CAST(NULL AS VARCHAR2(128)) AS partition_name,
                'TABLE' AS object_type,
                s.bytes
            FROM dba_indexes i
            JOIN dba_segments s
              ON s.owner = i.owner
             AND s.segment_name = i.index_name
            JOIN dba_tables t
              ON t.owner = i.owner
             AND t.table_name = i.table_name
            WHERE i.owner = UPPER(p_owner)
              AND t.partitioned = 'NO'
              AND UPPER(p_include_indexes) = 'Y'
              AND s.segment_type = 'INDEX'
        ),

        partition_table_segments AS (
            SELECT
                p.table_owner AS owner,
                p.table_name,
                p.partition_name,
                'PARTITION' AS object_type,
                NVL(s.bytes, 0) AS bytes
            FROM dba_tab_partitions p
            JOIN dba_tables t
              ON t.owner = p.table_owner
             AND t.table_name = p.table_name
            LEFT JOIN dba_segments s
              ON s.owner = p.table_owner
             AND s.segment_name = p.table_name
             AND s.partition_name = p.partition_name
             AND s.segment_type = 'TABLE PARTITION'
            WHERE p.table_owner = UPPER(p_owner)
              AND t.partitioned = 'YES'
              AND UPPER(p_partition_split) = 'Y'

            UNION ALL

            SELECT
                sp.table_owner AS owner,
                sp.table_name,
                sp.partition_name,
                'PARTITION' AS object_type,
                NVL(s.bytes, 0) AS bytes
            FROM dba_tab_subpartitions sp
            JOIN dba_tables t
              ON t.owner = sp.table_owner
             AND t.table_name = sp.table_name
            LEFT JOIN dba_segments s
              ON s.owner = sp.table_owner
             AND s.segment_name = sp.table_name
             AND s.partition_name = sp.subpartition_name
             AND s.segment_type = 'TABLE SUBPARTITION'
            WHERE sp.table_owner = UPPER(p_owner)
              AND t.partitioned = 'YES'
              AND UPPER(p_partition_split) = 'Y'

            UNION ALL

            SELECT
                i.owner,
                i.table_name,
                ip.partition_name,
                'PARTITION' AS object_type,
                NVL(s.bytes, 0) AS bytes
            FROM dba_ind_partitions ip
            JOIN dba_indexes i
              ON i.owner = ip.index_owner
             AND i.index_name = ip.index_name
            JOIN dba_tables t
              ON t.owner = i.owner
             AND t.table_name = i.table_name
            LEFT JOIN dba_segments s
              ON s.owner = ip.index_owner
             AND s.segment_name = ip.index_name
             AND s.partition_name = ip.partition_name
             AND s.segment_type = 'INDEX PARTITION'
            WHERE i.owner = UPPER(p_owner)
              AND t.partitioned = 'YES'
              AND UPPER(p_include_indexes) = 'Y'
              AND UPPER(p_partition_split) = 'Y'

            UNION ALL

            SELECT
                i.owner,
                i.table_name,
                tsp.partition_name,
                'PARTITION' AS object_type,
                NVL(s.bytes, 0) AS bytes
            FROM dba_ind_subpartitions isp
            JOIN dba_indexes i
              ON i.owner = isp.index_owner
             AND i.index_name = isp.index_name
            JOIN dba_tables t
              ON t.owner = i.owner
             AND t.table_name = i.table_name
            JOIN dba_tab_subpartitions tsp
              ON tsp.table_owner = i.table_owner
             AND tsp.table_name = i.table_name
             AND tsp.subpartition_name = isp.subpartition_name
            LEFT JOIN dba_segments s
              ON s.owner = isp.index_owner
             AND s.segment_name = isp.index_name
             AND s.partition_name = isp.subpartition_name
             AND s.segment_type = 'INDEX SUBPARTITION'
            WHERE i.owner = UPPER(p_owner)
              AND t.partitioned = 'YES'
              AND UPPER(p_include_indexes) = 'Y'
              AND UPPER(p_partition_split) = 'Y'
        ),

        partition_table_as_table_segments AS (
            SELECT
                t.owner,
                t.table_name,
                CAST(NULL AS VARCHAR2(128)) AS partition_name,
                'TABLE' AS object_type,
                s.bytes
            FROM dba_tables t
            JOIN dba_segments s
              ON s.owner = t.owner
             AND s.segment_name = t.table_name
            WHERE t.owner = UPPER(p_owner)
              AND t.partitioned = 'YES'
              AND UPPER(p_partition_split) = 'N'
              AND s.segment_type IN (
                    'TABLE PARTITION',
                    'TABLE SUBPARTITION',
                    'LOB PARTITION',
                    'LOB SUBPARTITION'
                  )

            UNION ALL

            SELECT
                i.owner,
                i.table_name,
                CAST(NULL AS VARCHAR2(128)) AS partition_name,
                'TABLE' AS object_type,
                s.bytes
            FROM dba_indexes i
            JOIN dba_segments s
              ON s.owner = i.owner
             AND s.segment_name = i.index_name
            JOIN dba_tables t
              ON t.owner = i.owner
             AND t.table_name = i.table_name
            WHERE i.owner = UPPER(p_owner)
              AND t.partitioned = 'YES'
              AND UPPER(p_partition_split) = 'N'
              AND UPPER(p_include_indexes) = 'Y'
              AND s.segment_type IN (
                    'INDEX PARTITION',
                    'INDEX SUBPARTITION'
                  )
        ),

        all_units AS (
            SELECT * FROM normal_table_segments
            UNION ALL
            SELECT * FROM partition_table_segments
            UNION ALL
            SELECT * FROM partition_table_as_table_segments
        )

        SELECT
            owner,
            table_name,
            partition_name,
            object_type,
            SUM(bytes) AS bytes
        FROM all_units
        GROUP BY
            owner,
            table_name,
            partition_name,
            object_type
        HAVING SUM(bytes) > 0
        ORDER BY SUM(bytes) DESC
    )
    LOOP
        /*
          첫 버킷 생성
        */
        IF v_bucket_no = 0 THEN
            v_bucket_no := 1;
            v_bucket_size(v_bucket_no) := 0;
        END IF;

        /*
          현재 버킷에 넣으면 1TB 초과이고,
          현재 버킷이 비어있지 않으면 새 버킷 생성
        */
        IF v_bucket_size(v_bucket_no) > 0
           AND v_bucket_size(v_bucket_no) + r.bytes > v_target_bytes
        THEN
            v_bucket_no := v_bucket_no + 1;
            v_bucket_size(v_bucket_no) := 0;
        END IF;

        IF r.bytes > v_target_bytes THEN
            v_over_target := 'Y';
        ELSE
            v_over_target := 'N';
        END IF;

        INSERT INTO EXPDP_PAR_PLAN (
            run_id,
            bucket_no,
            owner,
            table_name,
            partition_name,
            object_type,
            bytes,
            gb,
            over_target_yn
        )
        VALUES (
            v_run_id,
            v_bucket_no,
            r.owner,
            r.table_name,
            r.partition_name,
            r.object_type,
            r.bytes,
            ROUND(r.bytes / 1024 / 1024 / 1024, 2),
            v_over_target
        );

        v_bucket_size(v_bucket_no) := v_bucket_size(v_bucket_no) + r.bytes;
        v_total_bytes := v_total_bytes + r.bytes;

        /*
          단일 오브젝트가 1TB 초과인 경우는 단독 par 파일로 두고
          다음 오브젝트는 새 버킷으로 넘김
        */
        IF r.bytes > v_target_bytes THEN
            v_bucket_no := v_bucket_no + 1;
            v_bucket_size(v_bucket_no) := 0;
        END IF;
    END LOOP;

    COMMIT;

    /*
      마지막 버킷이 비어 있으면 제거
    */
    IF v_bucket_no > 0 AND v_bucket_size(v_bucket_no) = 0 THEN
        v_bucket_no := v_bucket_no - 1;
    END IF;

    /*
      par 파일 생성
    */
    FOR b IN 1 .. v_bucket_no LOOP
        v_filename := p_prefix || '_' || LPAD(b, 3, '0') || '.par';

        v_file := UTL_FILE.FOPEN(
            location     => p_par_dir,
            filename     => v_filename,
            open_mode    => 'w',
            max_linesize => 32767
        );

        UTL_FILE.PUT_LINE(v_file, 'directory=' || p_dump_dir);
        UTL_FILE.PUT_LINE(v_file, 'dumpfile=' || p_prefix || '_' || LPAD(b, 3, '0') || '_%U.dmp');
        UTL_FILE.PUT_LINE(v_file, 'logfile=' || p_prefix || '_' || LPAD(b, 3, '0') || '.log');
        UTL_FILE.PUT_LINE(v_file, 'filesize=' || p_filesize);
        UTL_FILE.PUT_LINE(v_file, 'parallel=' || p_parallel);
        UTL_FILE.PUT_LINE(v_file, 'cluster=' || p_cluster);

        IF UPPER(p_exclude_statistics) = 'Y' THEN
            UTL_FILE.PUT_LINE(v_file, 'exclude=STATISTICS');
        END IF;

        v_line := 'tables=';
        v_first := TRUE;

        FOR t IN (
            SELECT
                owner,
                table_name,
                partition_name,
                bytes
            FROM EXPDP_PAR_PLAN
            WHERE run_id = v_run_id
              AND bucket_no = b
            ORDER BY bytes DESC
        )
        LOOP
            v_piece := expdp_table_expr(
                t.owner,
                t.table_name,
                t.partition_name
            );

            IF v_first THEN
                IF LENGTH(v_line || v_piece) > 32000 THEN
                    RAISE_APPLICATION_ERROR(
                        -20002,
                        'TABLES line too long in bucket ' || b
                    );
                END IF;

                v_line := v_line || v_piece;
                v_first := FALSE;
            ELSE
                IF LENGTH(v_line || ',' || v_piece) > 32000 THEN
                    RAISE_APPLICATION_ERROR(
                        -20003,
                        'TABLES line too long in bucket ' || b ||
                        '. Object count is too high for one TABLES parameter line.'
                    );
                END IF;

                v_line := v_line || ',' || v_piece;
            END IF;
        END LOOP;

        UTL_FILE.PUT_LINE(v_file, v_line);
        UTL_FILE.FCLOSE(v_file);
    END LOOP;

    DBMS_OUTPUT.PUT_LINE('RUN_ID = ' || v_run_id);
    DBMS_OUTPUT.PUT_LINE('TOTAL SIZE GB = ' || ROUND(v_total_bytes / 1024 / 1024 / 1024, 2));
    DBMS_OUTPUT.PUT_LINE('TOTAL SIZE TB = ' || ROUND(v_total_bytes / 1024 / 1024 / 1024 / 1024, 2));
    DBMS_OUTPUT.PUT_LINE('PAR FILE COUNT = ' || v_bucket_no);

    FOR i IN 1 .. v_bucket_no LOOP
        DBMS_OUTPUT.PUT_LINE(
            'PAR ' || LPAD(i, 3, '0') ||
            ' SIZE GB = ' ||
            ROUND(v_bucket_size(i) / 1024 / 1024 / 1024, 2) ||
            ' / TB = ' ||
            ROUND(v_bucket_size(i) / 1024 / 1024 / 1024 / 1024, 2)
        );
    END LOOP;
END;
/



SET SERVEROUTPUT ON;

BEGIN
    GEN_EXPDP_PAR_FILES(
        p_owner              => 'DWUSER',
        p_par_dir            => 'EXPDP_PAR_DIR',
        p_dump_dir           => 'EXPDP_DUMP_DIR',
        p_prefix             => 'dwuser_exp',
        p_target_size_gb     => 1024,
        p_filesize           => '1024G',
        p_parallel           => 4,
        p_include_indexes    => 'N',
        p_exclude_statistics => 'Y',
        p_cluster            => 'N',
        p_partition_split    => 'Y'
    );
END;
/


-- 결과 확인 

SELECT
    bucket_no AS par_no,
    COUNT(*) AS object_count,
    ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) AS gb,
    ROUND(SUM(bytes) / 1024 / 1024 / 1024 / 1024, 2) AS tb
FROM EXPDP_PAR_PLAN
GROUP BY bucket_no
ORDER BY bucket_no;

SELECT
    bucket_no,
    object_type,
    owner,
    table_name,
    partition_name,
    gb
FROM EXPDP_PAR_PLAN
WHERE over_target_yn = 'Y'
ORDER BY gb DESC;
