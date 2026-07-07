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
    v_run_id        VARCHAR2(50);
    v_target_bytes  NUMBER;
    v_total_bytes   NUMBER := 0;
    v_par_count     NUMBER := 0;

    v_file          UTL_FILE.FILE_TYPE;
    v_filename      VARCHAR2(200);
    v_line          VARCHAR2(32767);
    v_piece         VARCHAR2(1000);
    v_first         BOOLEAN;

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
    WITH
    target_tables AS (
        SELECT DISTINCT
            UPPER(owner) AS owner,
            UPPER(table_name) AS table_name
        FROM EXPDP_MIG_TARGET_TABLES
        WHERE NVL(USE_YN, 'Y') = 'Y'
          AND UPPER(owner) = UPPER(p_owner)
    ),

    normal_table_segments AS (
        /*
          일반 테이블 segment
        */
        SELECT
            t.owner,
            t.table_name,
            CAST(NULL AS VARCHAR2(128)) AS partition_name,
            'TABLE' AS object_type,
            s.bytes
        FROM dba_tables t
        JOIN target_tables tt
          ON tt.owner = t.owner
         AND tt.table_name = t.table_name
        JOIN dba_segments s
          ON s.owner = t.owner
         AND s.segment_name = t.table_name
        WHERE t.owner = UPPER(p_owner)
          AND t.partitioned = 'NO'
          AND s.segment_type IN ('TABLE', 'NESTED TABLE')

        UNION ALL

        /*
          일반 테이블 LOB segment
        */
        SELECT
            l.owner,
            l.table_name,
            CAST(NULL AS VARCHAR2(128)) AS partition_name,
            'TABLE' AS object_type,
            s.bytes
        FROM dba_lobs l
        JOIN target_tables tt
          ON tt.owner = l.owner
         AND tt.table_name = l.table_name
        JOIN dba_tables t
          ON t.owner = l.owner
         AND t.table_name = l.table_name
        JOIN dba_segments s
          ON s.owner = l.owner
         AND s.segment_name IN (l.segment_name, l.index_name)
        WHERE l.owner = UPPER(p_owner)
          AND t.partitioned = 'NO'
          AND s.segment_type IN ('LOBSEGMENT', 'LOBINDEX')

        UNION ALL

        /*
          일반 테이블 인덱스 segment
          p_include_indexes = 'Y'일 때만 크기 산정에 포함
        */
        SELECT
            i.owner,
            i.table_name,
            CAST(NULL AS VARCHAR2(128)) AS partition_name,
            'TABLE' AS object_type,
            s.bytes
        FROM dba_indexes i
        JOIN target_tables tt
          ON tt.owner = i.owner
         AND tt.table_name = i.table_name
        JOIN dba_tables t
          ON t.owner = i.owner
         AND t.table_name = i.table_name
        JOIN dba_segments s
          ON s.owner = i.owner
         AND s.segment_name = i.index_name
        WHERE i.owner = UPPER(p_owner)
          AND t.partitioned = 'NO'
          AND UPPER(p_include_indexes) = 'Y'
          AND s.segment_type = 'INDEX'
    ),

    partition_table_segments AS (
        /*
          파티션 테이블 데이터 segment
        */
        SELECT
            p.table_owner AS owner,
            p.table_name,
            p.partition_name,
            'PARTITION' AS object_type,
            NVL(s.bytes, 0) AS bytes
        FROM dba_tab_partitions p
        JOIN target_tables tt
          ON tt.owner = p.table_owner
         AND tt.table_name = p.table_name
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

        /*
          서브파티션 테이블 데이터 segment
          상위 partition_name으로 합산
        */
        SELECT
            sp.table_owner AS owner,
            sp.table_name,
            sp.partition_name,
            'PARTITION' AS object_type,
            NVL(s.bytes, 0) AS bytes
        FROM dba_tab_subpartitions sp
        JOIN target_tables tt
          ON tt.owner = sp.table_owner
         AND tt.table_name = sp.table_name
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

        /*
          파티션 LOB segment
        */
        SELECT
            lp.table_owner AS owner,
            lp.table_name,
            lp.partition_name,
            'PARTITION' AS object_type,
            NVL(s.bytes, 0) AS bytes
        FROM dba_lob_partitions lp
        JOIN target_tables tt
          ON tt.owner = lp.table_owner
         AND tt.table_name = lp.table_name
        JOIN dba_tables t
          ON t.owner = lp.table_owner
         AND t.table_name = lp.table_name
        LEFT JOIN dba_segments s
          ON s.owner = lp.table_owner
         AND s.segment_name = lp.lob_name
         AND s.partition_name = lp.lob_partition_name
         AND s.segment_type = 'LOB PARTITION'
        WHERE lp.table_owner = UPPER(p_owner)
          AND t.partitioned = 'YES'
          AND UPPER(p_partition_split) = 'Y'

        UNION ALL

        /*
          서브파티션 LOB segment
          상위 partition_name으로 합산
        */
        SELECT
            lsp.table_owner AS owner,
            lsp.table_name,
            tsp.partition_name,
            'PARTITION' AS object_type,
            NVL(s.bytes, 0) AS bytes
        FROM dba_lob_subpartitions lsp
        JOIN target_tables tt
          ON tt.owner = lsp.table_owner
         AND tt.table_name = lsp.table_name
        JOIN dba_tab_subpartitions tsp
          ON tsp.table_owner = lsp.table_owner
         AND tsp.table_name = lsp.table_name
         AND tsp.subpartition_name = lsp.subpartition_name
        JOIN dba_tables t
          ON t.owner = lsp.table_owner
         AND t.table_name = lsp.table_name
        LEFT JOIN dba_segments s
          ON s.owner = lsp.table_owner
         AND s.segment_name = lsp.lob_name
         AND s.partition_name = lsp.lob_subpartition_name
         AND s.segment_type = 'LOB SUBPARTITION'
        WHERE lsp.table_owner = UPPER(p_owner)
          AND t.partitioned = 'YES'
          AND UPPER(p_partition_split) = 'Y'

        UNION ALL

        /*
          파티션 인덱스 segment
          p_include_indexes = 'Y'일 때만 크기 산정에 포함
        */
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
        JOIN target_tables tt
          ON tt.owner = i.owner
         AND tt.table_name = i.table_name
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

        /*
          서브파티션 인덱스 segment
          상위 partition_name으로 합산
        */
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
        JOIN target_tables tt
          ON tt.owner = i.owner
         AND tt.table_name = i.table_name
        JOIN dba_tab_subpartitions tsp
          ON tsp.table_owner = i.table_owner
         AND tsp.table_name = i.table_name
         AND tsp.subpartition_name = isp.subpartition_name
        JOIN dba_tables t
          ON t.owner = i.owner
         AND t.table_name = i.table_name
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
        /*
          p_partition_split = 'N'일 때 파티션 테이블을 테이블 단위로 합산
        */
        SELECT
            t.owner,
            t.table_name,
            CAST(NULL AS VARCHAR2(128)) AS partition_name,
            'TABLE' AS object_type,
            s.bytes
        FROM dba_tables t
        JOIN target_tables tt
          ON tt.owner = t.owner
         AND tt.table_name = t.table_name
        JOIN dba_segments s
          ON s.owner = t.owner
        WHERE t.owner = UPPER(p_owner)
          AND t.partitioned = 'YES'
          AND UPPER(p_partition_split) = 'N'
          AND (
                (
                    s.segment_name = t.table_name
                    AND s.segment_type IN (
                        'TABLE PARTITION',
                        'TABLE SUBPARTITION'
                    )
                )
                OR s.segment_type IN (
                    'LOB PARTITION',
                    'LOB SUBPARTITION'
                )
              )

        UNION ALL

        SELECT
            i.owner,
            i.table_name,
            CAST(NULL AS VARCHAR2(128)) AS partition_name,
            'TABLE' AS object_type,
            s.bytes
        FROM dba_indexes i
        JOIN target_tables tt
          ON tt.owner = i.owner
         AND tt.table_name = i.table_name
        JOIN dba_tables t
          ON t.owner = i.owner
         AND t.table_name = i.table_name
        JOIN dba_segments s
          ON s.owner = i.owner
         AND s.segment_name = i.index_name
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
    ),

    grouped_units AS (
        SELECT
            owner,
            table_name,
            partition_name,
            object_type,
            SUM(NVL(bytes, 0)) AS bytes
        FROM all_units
        GROUP BY
            owner,
            table_name,
            partition_name,
            object_type
    ),

    ordered_units AS (
        SELECT
            owner,
            table_name,
            partition_name,
            object_type,
            bytes,
            SUM(bytes) OVER (
                ORDER BY bytes DESC, owner, table_name, NVL(partition_name, '-')
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS running_bytes
        FROM grouped_units
        WHERE bytes > 0
    ),

    bucketed_units AS (
        SELECT
            owner,
            table_name,
            partition_name,
            object_type,
            bytes,
            FLOOR((running_bytes - 1) / v_target_bytes) + 1 AS bucket_no
        FROM ordered_units
    )
    SELECT
        v_run_id AS run_id,
        bucket_no,
        owner,
        table_name,
        partition_name,
        object_type,
        bytes,
        ROUND(bytes / 1024 / 1024 / 1024, 2) AS gb,
        CASE
            WHEN bytes > v_target_bytes THEN 'Y'
            ELSE 'N'
        END AS over_target_yn
    FROM bucketed_units;

    COMMIT;

    SELECT NVL(SUM(bytes), 0),
           NVL(COUNT(DISTINCT bucket_no), 0)
    INTO v_total_bytes,
         v_par_count
    FROM EXPDP_PAR_PLAN
    WHERE run_id = v_run_id;

    FOR b IN (
        SELECT
            bucket_no,
            ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) AS bucket_gb,
            COUNT(*) AS object_count
        FROM EXPDP_PAR_PLAN
        WHERE run_id = v_run_id
        GROUP BY bucket_no
        ORDER BY bucket_no
    )
    LOOP
        v_filename := p_prefix || '_' || LPAD(b.bucket_no, 3, '0') || '.par';

        v_file := UTL_FILE.FOPEN(
            location     => p_par_dir,
            filename     => v_filename,
            open_mode    => 'w',
            max_linesize => 32767
        );

        UTL_FILE.PUT_LINE(v_file, 'directory=' || p_dump_dir);
        UTL_FILE.PUT_LINE(v_file, 'dumpfile=' || p_prefix || '_' || LPAD(b.bucket_no, 3, '0') || '_%U.dmp');
        UTL_FILE.PUT_LINE(v_file, 'logfile=' || p_prefix || '_' || LPAD(b.bucket_no, 3, '0') || '.log');
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
              AND bucket_no = b.bucket_no
            ORDER BY bytes DESC, owner, table_name, NVL(partition_name, '-')
        )
        LOOP
            v_piece := expdp_table_expr(
                t.owner,
                t.table_name,
                t.partition_name
            );

            IF v_first THEN
                IF LENGTH(v_line || v_piece) > 32000 THEN
                    UTL_FILE.FCLOSE(v_file);
                    RAISE_APPLICATION_ERROR(
                        -20002,
                        'TABLES line too long in bucket ' || b.bucket_no
                    );
                END IF;

                v_line := v_line || v_piece;
                v_first := FALSE;
            ELSE
                IF LENGTH(v_line || ',' || v_piece) > 32000 THEN
                    UTL_FILE.FCLOSE(v_file);
                    RAISE_APPLICATION_ERROR(
                        -20003,
                        'TABLES line too long in bucket ' || b.bucket_no ||
                        '. Increase target size or reduce object count per par file.'
                    );
                END IF;

                v_line := v_line || ',' || v_piece;
            END IF;
        END LOOP;

        UTL_FILE.PUT_LINE(v_file, v_line);
        UTL_FILE.FCLOSE(v_file);

        DBMS_OUTPUT.PUT_LINE(
            'CREATED PAR FILE = ' || v_filename ||
            ', GB = ' || b.bucket_gb ||
            ', OBJECT_COUNT = ' || b.object_count
        );
    END LOOP;

    DBMS_OUTPUT.PUT_LINE('RUN_ID = ' || v_run_id);
    DBMS_OUTPUT.PUT_LINE('TOTAL SIZE GB = ' || ROUND(v_total_bytes / 1024 / 1024 / 1024, 2));
    DBMS_OUTPUT.PUT_LINE('TOTAL SIZE TB = ' || ROUND(v_total_bytes / 1024 / 1024 / 1024 / 1024, 2));
    DBMS_OUTPUT.PUT_LINE('PAR FILE COUNT = ' || v_par_count);

    FOR x IN (
        SELECT
            bucket_no,
            COUNT(*) AS object_count,
            ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) AS gb,
            ROUND(SUM(bytes) / 1024 / 1024 / 1024 / 1024, 2) AS tb
        FROM EXPDP_PAR_PLAN
        WHERE run_id = v_run_id
        GROUP BY bucket_no
        ORDER BY bucket_no
    )
    LOOP
        DBMS_OUTPUT.PUT_LINE(
            'PAR ' || LPAD(x.bucket_no, 3, '0') ||
            ' / OBJECT_COUNT = ' || x.object_count ||
            ' / GB = ' || x.gb ||
            ' / TB = ' || x.tb
        );
    END LOOP;

EXCEPTION
    WHEN OTHERS THEN
        BEGIN
            IF UTL_FILE.IS_OPEN(v_file) THEN
                UTL_FILE.FCLOSE(v_file);
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;

        RAISE;
END;
/





SET SERVEROUTPUT ON SIZE UNLIMITED;

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
    gb,
    over_target_yn
FROM EXPDP_PAR_PLAN
ORDER BY bucket_no, bytes DESC;



SELECT
    m.owner,
    m.table_name
FROM EXPDP_MIG_TARGET_TABLES m
LEFT JOIN dba_tables t
  ON t.owner = UPPER(m.owner)
 AND t.table_name = UPPER(m.table_name)
WHERE NVL(m.use_yn, 'Y') = 'Y'
  AND UPPER(m.owner) = 'DWUSER'
  AND t.table_name IS NULL
ORDER BY m.owner, m.table_name;


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



expdp system/password parfile=/backup/expdp/par/dwuser_exp_001.par
expdp system/password parfile=/backup/expdp/par/dwuser_exp_002.par
expdp system/password parfile=/backup/expdp/par/dwuser_exp_003.par