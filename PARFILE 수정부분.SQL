/*
  실제 EXPDP_PAR_PLAN.bucket_no 기준으로 par 파일 생성
  TABLES= 라인이 32KB를 넘으면 같은 bucket 안에서 파일을 추가 분할한다.
*/
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
    DECLARE
        v_part_no       NUMBER := 1;
        v_current_count NUMBER := 0;

        PROCEDURE open_par_file IS
        BEGIN
            v_filename :=
                p_prefix || '_' ||
                LPAD(b.bucket_no, 3, '0') || '_' ||
                LPAD(v_part_no, 2, '0') || '.par';

            v_file := UTL_FILE.FOPEN(
                location     => p_par_dir,
                filename     => v_filename,
                open_mode    => 'w',
                max_linesize => 32767
            );

            UTL_FILE.PUT_LINE(v_file, 'directory=' || p_dump_dir);

            UTL_FILE.PUT_LINE(
                v_file,
                'dumpfile=' ||
                p_prefix || '_' ||
                LPAD(b.bucket_no, 3, '0') || '_' ||
                LPAD(v_part_no, 2, '0') || '_%U.dmp'
            );

            UTL_FILE.PUT_LINE(
                v_file,
                'logfile=' ||
                p_prefix || '_' ||
                LPAD(b.bucket_no, 3, '0') || '_' ||
                LPAD(v_part_no, 2, '0') || '.log'
            );

            UTL_FILE.PUT_LINE(v_file, 'filesize=' || p_filesize);
            UTL_FILE.PUT_LINE(v_file, 'parallel=' || p_parallel);
            UTL_FILE.PUT_LINE(v_file, 'cluster=' || p_cluster);

            IF UPPER(p_exclude_statistics) = 'Y' THEN
                UTL_FILE.PUT_LINE(v_file, 'exclude=STATISTICS');
            END IF;

            v_line := 'tables=';
            v_first := TRUE;
            v_current_count := 0;
        END;

        PROCEDURE close_par_file IS
        BEGIN
            IF NOT v_first THEN
                UTL_FILE.PUT_LINE(v_file, v_line);
            END IF;

            IF UTL_FILE.IS_OPEN(v_file) THEN
                UTL_FILE.FCLOSE(v_file);
            END IF;

            DBMS_OUTPUT.PUT_LINE(
                'CREATED PAR FILE = ' || v_filename ||
                ', BUCKET = ' || b.bucket_no ||
                ', PART = ' || v_part_no ||
                ', OBJECT_COUNT = ' || v_current_count
            );
        END;

    BEGIN
        open_par_file;

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

            IF LENGTH('tables=' || v_piece) > 32000 THEN
                IF UTL_FILE.IS_OPEN(v_file) THEN
                    UTL_FILE.FCLOSE(v_file);
                END IF;

                RAISE_APPLICATION_ERROR(
                    -20004,
                    'Single TABLES entry is too long: ' || v_piece
                );
            END IF;

            IF v_first THEN
                v_line := v_line || v_piece;
                v_first := FALSE;
                v_current_count := v_current_count + 1;
            ELSE
                IF LENGTH(v_line || ',' || v_piece) > 32000 THEN
                    close_par_file;

                    v_part_no := v_part_no + 1;
                    open_par_file;

                    v_line := v_line || v_piece;
                    v_first := FALSE;
                    v_current_count := v_current_count + 1;
                ELSE
                    v_line := v_line || ',' || v_piece;
                    v_current_count := v_current_count + 1;
                END IF;
            END IF;
        END LOOP;

        close_par_file;

        DBMS_OUTPUT.PUT_LINE(
            'BUCKET ' || b.bucket_no ||
            ' TOTAL_GB = ' || b.bucket_gb ||
            ', TOTAL_OBJECT_COUNT = ' || b.object_count
        );
    END;
END LOOP;