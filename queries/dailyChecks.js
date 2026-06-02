const database = require("../config/database");

module.exports = {
    instanceInfo: `
      select INSTANCE_NUMBER INST_ID,
                         INSTANCE_NAME,
                         HOST_NAME,
                         VERSION,
                         STARTUP_TIME,
                         TRUNC ((( SYSDATE-STARTUP_TIME) * 86400) / (60 * 60 * 24)) || 'days'
                         || LPAD (MOD (TRUNC ((( SYSDATE-STARTUP_TIME) * 86400) / (60 * 60)), 24), 2, 0) || ':'
                         || LPAD (MOD (TRUNC ((( SYSDATE-STARTUP_TIME) * 86400) / 60), 60), 2, 0) || ':'
                         || LPAD (TRUNC(MOD ((( SYSDATE-STARTUP_TIME) * 86400), 60)), 2, 0) UP_TIME,
                         STATUS,
                         ARCHIVER
        from gv$instance ORDER BY INST_ID
    `,
    databaseInfo: `
      SELECT INST_ID, DBID, NAME, LOG_MODE, DATABASE_ROLE,PLATFORM_NAME,FORCE_LOGGING
        FROM GV$DATABASE ORDER BY INST_ID
    `,
    resourceLimit: `
      select resource_name, current_utilization curr_utl, max_utilization max_utl,
             initial_allocation init, LIMIT_VALUE "LIMIT"
        from v$resource_limit
    `,
    controlFile: `
        select * from v$controlfile
    `,
    redologFile: `
        SELECT A.THREAD#, B.GROUP#,  A.SEQUENCE#, A.ARCHIVED, A.STATUS, A.BYTES/1024/1024 SIZE_MB, B.MEMBER
        FROM V$LOG A, V$LOGFILE B
                    WHERE A.GROUP# =+ B.GROUP#
                    ORDER BY A.THREAD#, B.GROUP#
    `,
    archivelogFile: `
        SELECT  to_char(first_time, 'YYYY-MM-DD') "Date",
                            to_char(first_time, 'Dy') "Day",
                            count(1) "Total",
                            sum(case when  to_char(first_time, 'hh24') between '00' and '08' then 1 end) "h00 ~ 08",
                            sum(case when  to_char(first_time, 'hh24') between '08' and '17' then 1 end) "h08 ~ 17",
                            sum(case when  to_char(first_time, 'hh24') between '18' and '23' then 1 end) "h18 ~ 23"
                    FROM    gV$log_history
                    where first_time  >= sysdate - 15
                    group by to_char(first_time, 'YYYY-MM-DD'), to_char(first_time, 'Dy')
                    Order by 1
    `,
    asmdiskUsage: `
        select  NAME,USABLE_FILE_GB,TOTAL_GB,FREE_GB ,  (TOTAL_GB - FREE_GB) USE_GB,   "usgae(%)" 
                        , USABLE_CALC_GB STATE,TYPE,GROUP_NUMBER
                    from
                    (
                    select name,
                            USABLE_FILE_MB/1024 USABLE_FILE_GB,
                            round( case when TYPE='HIGH' then  ( total_mb/1024)/3
                                when TYPE='NORMAL' then  ( total_mb/1024)/2
                            end ,1) "TOTAL_GB",
                            round(case when TYPE='HIGH' then  ( free_mb/1024)/3
                                when TYPE='NORMAL' then  ( free_mb/1024)/2
                            end ,1) "FREE_GB",
                            100-round(free_mb/total_mb*100) "usgae(%)",
                            ((FREE_MB - REQUIRED_MIRROR_FREE_MB))/1024 "USABLE_CALC_GB",
                            state, type, group_number
                    from v$asm_diskgroup
                    )
    `,
    tempFile: `
        select FILE#,
                     --  CREATION_CHANGE#,
                     --  CREATION_TIME,
                       TS#,
                      -- RFILE#,
                       BYTES/1024/1024 MB,
                       BLOCKS,
                       CREATE_BYTES/1024/1024 CRE_MB,
                       BLOCK_SIZE,
                       NAME,
                       ENABLED,
                       STATUS,
                       DECODE(STATUS,'ONLINE','','<= CHECK!') TEMP_STATUS_CHECK
                  from v$TEMPFILE
    `,
    tablespaceOnlineCheck: `
        select TABLESPACE_NAME, BLOCK_SIZE, INITIAL_EXTENT, NEXT_EXTENT, MAX_EXTENTS, STATUS, CONTENTS
                        , LOGGING,EXTENT_MANAGEMENT,ALLOCATION_TYPE,SEGMENT_SPACE_MANAGEMENT, BIGFILE  
                    from dba_tablespaces
                    WHERE STATUS != 'ONLINE'
    `,
    recoveryFileInfo: `
        select * from v$recover_file
    `,
    libraryCacheGetHit: `
        select round (100 * sum (gethits ) / sum (gets) , 2) "Library Cache Get Hit %" from v$librarycache
    `,
    libraryCachePinHit: `
        select round (100 * sum ( pinhits )/sum( pins ) , 2) "Library Cache Pin Hit %" from v$librarycache
    `,
    ParseCpuElaspsed: `
        select decode ( prsela, 0, to_number (null) , round (prscpu/prsela * 100, 2)) "Parse CPU to Parse Elapsed % 90%이상 "
          from ( select value prsela from v$sysstat where name ='parse time elapsed' ),
               ( select value prscpu from v$sysstat where name ='parse time cpu' )
    `,
    dictionaryCacheTuning: `
        SELECT TRUNC( SUM(gets-getmisses) / SUM(gets) * 100, 5) ||'%  (90% 이상)' "DATA DICTIONARY MISS RATIO "
                    FROM V$ROWCACHE
                    WHERE gets > 0
    `,
    bufferCacheHitRatio: `
        select (a.value+b.value-c.value)/(a.value+b.value)*100 "BufferHitRatio"
                    from sys.v_$sysstat a, sys.v_$sysstat b, sys.v_$sysstat c
                    where a.name = 'db block gets'
                    and b.name = 'consistent gets'
                    and c.name = 'physical reads cache'
    `,
    longSessionCheck: `
        SELECT 
                      INST_ID ID, SID, SERIAL#, USERNAME,
                      logon_during_time, STATUS, MACHINE, PROGRAM
                    , MODULE
                    , ACTION
                    , TYPE
                    , TRUNC (s.LAST_CALL_ET / (60 * 60 * 24)) || '일 ' 
                             || LPAD (MOD (TRUNC ( s.LAST_CALL_ET / (60 * 60)), 24), 2, 0) || ':' 
                             || LPAD (MOD (TRUNC ( s.LAST_CALL_ET / 60), 60), 2, 0) || ':' 
                             || LPAD (TRUNC(MOD ( s.LAST_CALL_ET, 60)), 2, 0) ELAPSED_TIME
                    , logon_dd
                    , EVENT
                    , case
                      when ( USERNAME NOT in ('SYS', 'SYSTEM') ) AND
                           ( TYPE <>'BACKGROUND' ) THEN
                        'alter system kill session '''||SID||','|| SERIAL#||',@'||INST_ID||''' immediate;'
                     ELSE 'ORACLE PROCESS,,CHECK'
                     END KILL_SESS
                 FROM
                 (
                     SELECT INST_ID, SID, SERIAL#, USERNAME, STATUS, MACHINE, PROGRAM, MODULE, ACTION,  TYPE, LAST_CALL_ET
                                 , to_char(logon_time,'YYYY/MM/DD HH24:MI:SS') logon_time
                                 , to_char(logon_time,'YYYY/MM/DD') logon_dd
                                 , trunc(sysdate - logon_time)  || ' Day '
                                   || to_char(TRUNC(sysdate) +  (sysdate - logon_time),'HH24:MI:SS')  logon_during_time
                                 ,  to_char(PREV_EXEC_START,'YYYY/MM/DD HH24:MI:SS') "PREV_EXEC_START"
                           ,EVENT
                     FROM GV$SESSION 
                     WHERE TYPE <>'BACKGROUND'
                     AND status = 'ACTIVE'
                     AND USERNAME NOT IN ('SYS','STRMADMIN','DBSNMP', 'SYSRAC', 'ERADM', 'ERADM_DR')
                     ORDER BY logon_time ASC
                 ) s
                 WHERE ROWNUM <=30
    `,
    longTransactionCheck: `
        select S.sql_id, to_date(T.START_TIME,'mm/dd/yy hh24:mi:ss')
                    , S.SID, S.SERIAL#, S.USERNAME USERNAME, S.OSUSER OSUSER
                    , S.PROCESS
                    , S.MACHINE MACHINE, S.TERMINAL, S.PROGRAM PROGRAM,S.MODULE,
                      S.STATUS STATUS, 
                      TRUNC (s.LAST_CALL_ET / (60 * 60 * 24)) || '일 ' 
                      || LPAD (MOD (TRUNC ( s.LAST_CALL_ET / (60 * 60)), 24), 2, 0) || ':' 
                      || LPAD (MOD (TRUNC ( s.LAST_CALL_ET / 60), 60), 2, 0) || ':' 
                      || LPAD (TRUNC(MOD (  s.LAST_CALL_ET, 60)), 2, 0) ELAPSED_TIME,
                      'alter system kill session '||''''||s.sid||','||s.serial#||','||'@'||s.inst_id||'''' kill
                from gv$session s,
                      gv$transaction t
                WHERE 1=1 
                AND s.inst_id = t.inst_id 
                and s.saddr = t.ses_addr
                -- and ( ( sysdate > trunc(sysdate) + 18/24 ) or (sysdate < trunc(sysdate) + 7/24 ) )      -- 18 시 이후 와 07시 사이 transaction 찾기
                and (  sysdate - to_date(t.start_time,'mm/dd/yy hh24:mi:ss')  ) * 24 > 3                -- transaction이 3시간 이상인 경우  
                ORDER BY START_TIME asc
    `,
    tablespaceUsage: `
        SELECT TABLESPACE_NAME,RT_SIZE_MB,FT_SIZE_MB,U_SIZE_MB,F_SIZE_MB,"USED(%)","USED2(%)" ,FILE_STAT_CNT,AVG_INC_SIZE_MB
                FROM
                (
                    SELECT    T1.TABLESPACE_NAME, ROUND(T1.RT_SIZE_MB) RT_SIZE_MB, ROUND(T1.FT_SIZE_MB) FT_SIZE_MB  ,
                              ROUND(T1.FT_SIZE_MB - NVL(F1.F_SIZE_MB,0) ) U_SIZE_MB
                           ,  ROUND( RT_SIZE_MB   - (T1.FT_SIZE_MB -  NVL(F1.F_SIZE_MB,0) )  ) F_SIZE_MB
                           ,  ROUND((T1.FT_SIZE_MB -  NVL(F1.F_SIZE_MB,0) )*100/T1.RT_SIZE_MB ,2)  "USED(%)"
                           ,  ROUND((T1.FT_SIZE_MB -  NVL(F1.F_SIZE_MB,0) )*100/T1.FT_SIZE_MB ,2)  "USED2(%)"
                           ,   'TF:'||FILE_CNT||'# AF:'||AUTO_FILE_CNT FILE_STAT_CNT
                         , ROUND( AVG_INC_SIZE_MB) AVG_INC_SIZE_MB
                    FROM
                    (
                        SELECT TABLESPACE_NAME,   SUM(T_SIZE_MB) RT_SIZE_MB , SUM(BYTES)/1024/1024 FT_SIZE_MB , AVG(INCREMENTAL_SIZE_MB) AVG_INC_SIZE_MB , COUNT(*) FILE_CNT,
                                 SUM(CASE WHEN AUTOEXTENSIBLE='YES' THEN 1 END) AUTO_FILE_CNT
                        FROM
                        (
                        SELECT  TABLESPACE_NAME , AUTOEXTENSIBLE , MAXBYTES , BYTES ,  CASE WHEN AUTOEXTENSIBLE='YES' THEN MAXBYTES/1024/1024 ELSE BYTES/1024/1024  END T_SIZE_MB
                               ,  (INCREMENT_BY* (select value from v$parameter where name='db_block_size') )/1024/1024  INCREMENTAL_SIZE_MB
                        FROM DBA_DATA_FILES
                        WHERE TABLESPACE_NAME NOT IN
                           (
                                select tablespace_name
                                  from (
                                            select TABLESPACE_NAME
                                                 , SUBSTR(TABLESPACE_NAME,INSTR(TABLESPACE_NAME,'_',1,1)+1, 6) FROMDD
                                                 , DECODE(SUBSTR(TABLESPACE_NAME,INSTR(TABLESPACE_NAME,'_',1,2)+1, 6)
                                                 , 'D08'
                                                 , SUBSTR(TABLESPACE_NAME,INSTR(TABLESPACE_NAME,'_',1,1)+1, 6)
                                                 , SUBSTR(TABLESPACE_NAME,INSTR(TABLESPACE_NAME,'_',1,2)+1, 6)) TODD
                                              from dba_tablespaces
                                             where regexp_like (tablespace_name, '*_[0-9]{6}_*')
                                       )
                                 where todd <to_char(SYSDATE,'YYYYMM')
                                union all
                                select tablespace_name
                                  from dba_tablespaces
                                 where regexp_like (tablespace_name, '*_PRE_*')
                           )
                        )
                        GROUP BY TABLESPACE_NAME
                   )T1,
                  (
                           SELECT tablespace_name, sum(bytes)/1024/1024 F_SIZE_MB
                           FROM dba_free_space group by tablespace_name
                  )F1
                   WHERE
                     T1.tablespace_name=F1.tablespace_name(+)
                   )
                  WHERE  "USED(%)" > 80
                  ORDER BY       "USED(%)" DESC
    `,
    dbSchedulerCheck: `
        SELECT ROWNUM RNUM, A.*
                  FROM
                  (
                  SELECT OWNER, JOB_NAME --, JOB_ACTION
                           , ENABLED, STATE   ,INSTANCE_ID    ID
                           , REPEAT_INTERVAL,
                         TO_CHAR(LAST_START_DATE, 'YYYY/MM/DD HH24:MI:SS' ) LAST_START_DATE
                         --,TO_CHAR(NEXT_RUN_DATE, 'YYYY/MM/DD HH24:MI:SS' ) NEXT_RUN_DATE
                         -- , substr(COMMENTS,1,10) comments
                  FROM DBA_SCHEDULER_JOBS
                  WHERE OWNER NOT IN ('SYS','SYSTEM','EXFSYS','ORACLE_OCM','APEX_040200')
                  ORDER BY ENABLED desc , 1,2
                  ) A
    `,
    keystoreCheck: `
        select * from gv$encryption_wallet order by 1
    `, 
    rmanBackupCheck: `
        SELECT --A.RECID,
                       --A.PARENT_RECID PRECID,
                       A.ROW_TYPE,
                       A.OPERATION,
                       A.CHANNEL,
                       A.STATUS,
                       A.START_TIME,
                       A.TAKEN_TIME,
                       A.OBJECT_TYPE,
                       A.OUTPUT_DEVICE_TYPE,
                 --    A.OPTIMIZED,
                       ROUND(B.COMPRESSION_RATIO,4)                                                     AS COMPRESS_RATIO,
                       A.INPUT_GB,
                       A.OUTPUT_GB,
                       B.INPUT_BYTES_PER_SEC_DISPLAY                                                    AS INPUT_PER_SEC_MB,
                       B.OUTPUT_BYTES_PER_SEC_DISPLAY                                                   AS OUTPUT_PER_SEC_MB,
                       (SELECT ALGORITHM_NAME FROM V$RMAN_COMPRESSION_ALGORITHM WHERE IS_DEFAULT='YES')||'('||
                       (SELECT ALGORITHM_NAME FROM V$RMAN_ENCRYPTION_ALGORITHMS WHERE IS_DEFAULT='YES')||')' AS DEF_ALGO
                       --B.TIME_TAKEN_DISPLAY
                FROM
                  (
                      SELECT  recid,
                              PARENT_RECID,
                              row_type,
                              LPAD('   ', (LEVEL-1)*2)||operation operation,
                              (SELECT decode(count(distinct output),0,null,count(distinct output)) FROM V$RMAN_OUTPUT b where b.OUTPUT like 'allocated channel: ch%' and b.SESSION_RECID = a.recid) channel,
                              status,
                              to_char(start_time, 'YYYY-MM-DD HH24:MI:SS') start_time,
                              LPAD (MOD (TRUNC ((( end_time-start_time) * 86400) / (60 * 60)), 24), 2, 0) || ':'
                          || LPAD (MOD (TRUNC ((( end_time-start_time) * 86400) / 60), 60), 2, 0) || ':'
                          || LPAD (TRUNC(MOD  ((( end_time-start_time) * 86400), 60)), 2, 0) TAKEN_TIME,
                              round(input_bytes/1024/1024/1024,2) input_gb,
                              round(output_bytes/1024/1024/1024,2) output_gb,
                              object_type,
                              output_device_type,
                              optimized
                      FROM    v$rman_status a
                      WHERE   start_time >= (sysdate - 2)
                      START   WITH recid in (SELECT DISTINCT parent_recid FROM v$rman_status WHERE start_time >= (sysdate - 1))  AND PARENT_RECID IS NULL
                      CONNECT BY prior recid = parent_recid
                  ) A, V$RMAN_BACKUP_JOB_DETAILS B
             WHERE  A.RECID = B.SESSION_RECID(+)
             ORDER BY NVL(A.PARENT_RECID,A.RECID),  A.RECID, A.START_TIME
    `,
    asmDiskGroupCheck: `
        select name, USABLE_FILE_MB/1024 USABLE_FILE_GB, total_mb/1024 TOTAL_GB, free_mb/1024 FREE_GB, 100-round(free_mb/total_mb*100) "usgae(%)"
                    , ((FREE_MB - REQUIRED_MIRROR_FREE_MB))/1024 USABLE_CALC_GB, 
                     state, type, group_number 
                from v$asm_diskgroup
    `,
    recoveryFileDest: `
        select NAME,VALUE,DISPLAY_VALUE from v$spparameter where name like 'db_recovery_file_%'
    `, 
    recoveryAreaUsage: `
        select * from V$RECOVERY_AREA_USAGE
    `,
    alertLog: `
        select ORIGINATING_TIMESTAMP  + interval '9' hour , MESSAGE_TEXT, MESSAGE_TYPE
                  , MESSAGE_LEVEL,COMPONENT_ID, MESSAGE_ID
                  , MESSAGE_GROUP, CLIENT_ID, MODULE_ID, PROCESS_ID,THREAD_ID,USER_ID,INSTANCE_ID
                  , FILENAME, LOG_NAME
              from v$diag_alert_ext 
              where ORIGINATING_TIMESTAMP > sysdate - 2
                and (   MESSAGE_TEXT like '%ORA-%'
                     or MESSAGE_TEXT like '%FAIL%' 
                    )
    `,
    oggDiscardCheck: `
        select discard_time, log from system.ogg_discard_log
    `
  };