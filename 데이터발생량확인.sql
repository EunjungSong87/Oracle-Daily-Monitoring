SELECT LISTAGG(sql_text, CHR(10) || 'UNION ALL' || CHR(10))
       WITHIN GROUP (ORDER BY table_name, gbn) AS final_sql
FROM (
    SELECT table_name,
           1 AS gbn,
           'SELECT '''
           || table_name
           || ''' AS table_name, ''DAY'' AS period_type, TRUNC('
           || column_name
           || ') AS base_date, COUNT(*) AS cnt FROM '
           || table_name
           || ' WHERE '
           || column_name
           || ' IS NOT NULL GROUP BY TRUNC('
           || column_name
           || ')' AS sql_text
    FROM user_tab_columns
    WHERE column_name = UPPER('REG_DATE')

    UNION ALL

    SELECT table_name,
           2 AS gbn,
           'SELECT '''
           || table_name
           || ''' AS table_name, ''MONTH'' AS period_type, TRUNC('
           || column_name
           || ', ''MM'') AS base_date, COUNT(*) AS cnt FROM '
           || table_name
           || ' WHERE '
           || column_name
           || ' IS NOT NULL GROUP BY TRUNC('
           || column_name
           || ', ''MM'')' AS sql_text
    FROM user_tab_columns
    WHERE column_name = UPPER('REG_DATE')
);