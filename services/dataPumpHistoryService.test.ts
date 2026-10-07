import { describe, expect, it } from 'vitest';
import { describeTarget, parseDataPumpLog } from './dataPumpHistoryService';
import type { DataPumpPlan } from '../models/dataPumpModel';

const EXPORT_LOG = `;;; 
Export: Release 23.0.0.0.0 - Production on Fri Oct 2 07:48:46 2026
Starting "SYSTEM"."DBC_EXP_20261002164845_01":  
Processing object type SCHEMA_EXPORT/TABLE/TABLE_DATA
. . exported "CMP_SRC"."T_SAME"                          453.9 KB   20000 rows
Master table "SYSTEM"."DBC_EXP_20261002164845_01" successfully loaded/unloaded
******************************************************************************
Dump file set for SYSTEM.DBC_EXP_20261002164845_01 is:
  /opt/oracle/admin/FREE/dpdump/2467904D40F2106AE0630F02000A30D8/exp_20261002_01_01.dmp
  /opt/oracle/admin/FREE/dpdump/2467904D40F2106AE0630F02000A30D8/exp_20261002_01_02.dmp
Job "SYSTEM"."DBC_EXP_20261002164845_01" successfully completed at Fri Oct 2 07:49:21 2026 elapsed 0 01:02:35
`;

describe('parseDataPumpLog', () => {
  it('성공한 export: 상태, 수행 시간(일 시:분:초), 덤프 파일 이름', () => {
    expect(parseDataPumpLog(EXPORT_LOG)).toEqual({
      status: 'COMPLETED',
      elapsedSec: 3600 + 2 * 60 + 35,
      errorCount: 0,
      resultMessage: 'Job "SYSTEM"."DBC_EXP_20261002164845_01" successfully completed at Fri Oct 2 07:49:21 2026 elapsed 0 01:02:35',
      dumpFiles: ['exp_20261002_01_01.dmp', 'exp_20261002_01_02.dmp'],
    });
  });

  it('에러가 있었던 import', () => {
    const parsed = parseDataPumpLog(
      'ORA-39082: Object type VIEW:"X"."V" created with compilation warnings\nJob "SYSTEM"."DBC_IMP_1" completed with 3 error(s) at Fri Oct 2 07:49:33 2026 elapsed 1 02:00:08\n'
    );
    expect(parsed).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', errorCount: 3, elapsedSec: 86400 + 7200 + 8, dumpFiles: [] });
  });

  it('치명적 에러로 멈춘 작업과 사용자가 멈춘 작업', () => {
    expect(parseDataPumpLog('Job "SYSTEM"."X" stopped due to fatal error at Fri Oct 2 07:49:33 2026 elapsed 0 00:00:08').status).toBe('FAILED');
    expect(parseDataPumpLog('Job "SYSTEM"."X" stopped by user request at Fri Oct 2 07:49:33 2026 elapsed 0 00:01:00').status).toBe('CANCELLED');
  });

  it('결과 줄이 없으면(작업이 비정상 종료) UNKNOWN', () => {
    expect(parseDataPumpLog('Starting "SYSTEM"."X":\nProcessing object type ...\n')).toMatchObject({ status: 'UNKNOWN', elapsedSec: null, resultMessage: null });
  });

  it('Windows 경로의 덤프 파일도 이름만 뽑는다', () => {
    const log = [
      'Dump file set for SYSTEM.X is:',
      String.raw`  D:\dpdump\exp_01.dmp`,
      'Job "SYSTEM"."X" successfully completed at Fri Oct 2 07:49:21 2026 elapsed 0 00:00:05',
      '',
    ].join('\n');
    expect(parseDataPumpLog(log).dumpFiles).toEqual(['exp_01.dmp']);
  });
});

describe('describeTarget', () => {
  const base: DataPumpPlan = {
    operation: 'EXPORT', jobMode: 'SCHEMA', jobName: 'J', directory: 'D', dumpfile: 'x.dmp', logfile: 'x.log', filesize: null, parallel: 1,
    schemaExpr: "IN ('HR','SCOTT')", nameExpr: null, excludeTableExpr: null, content: 'ALL', excludeStatistics: false,
    reuseDumpfiles: false, flashbackConsistent: false, flashbackScn: null, tableExistsAction: null, remapSchemas: [], remapTablespaces: [],
    networkLink: null, partitionFilters: [], multiSchemaTables: false, truncateTarget: null, truncatePartitions: [],
    filters: { includePaths: [], excludePaths: [], nameFilters: [], queries: [], samples: [], dataOptionConstants: [], viewsAsTables: [], excludeTablesOnly: false, parfileLines: [], summary: [], audit: [] },
  };

  it('스키마 작업 (제외 테이블 수 포함)', () => {
    expect(describeTarget(base)).toBe('SCHEMAS=HR,SCOTT');
    expect(describeTarget({ ...base, schemaExpr: "IN ('BIG')", excludeTableExpr: "NOT IN ('A','B')" })).toBe('SCHEMAS=BIG / 제외 테이블 2개');
  });

  it('테이블 작업과 import REMAP', () => {
    expect(describeTarget({ ...base, jobMode: 'TABLE', schemaExpr: "IN ('HR')", nameExpr: "IN ('EMP','DEPT')" })).toBe('HR 테이블 2개: EMP, DEPT');
    expect(
      describeTarget({ ...base, jobMode: 'TABLE', schemaExpr: "IN ('S')", nameExpr: "IN ('T')", partitionFilters: [{ owner: 'S', table: 'T', partitions: ['P202601'] }] })
    ).toBe('S 테이블 1개: T / 파티션 P202601');
    expect(
      describeTarget({
        ...base,
        jobMode: 'TABLE',
        schemaExpr: "IN ('S')",
        nameExpr: "IN ('T','U','V')",
        partitionFilters: [
          { owner: 'S', table: 'T', partitions: ['P1', 'P2'] },
          { owner: 'S', table: 'U', partitions: ['P1'] },
        ],
      })
    ).toBe('S 테이블 3개: T, U, V / 파티션 T:P1,P2 U:P1');
    expect(describeTarget({ ...base, operation: 'IMPORT', jobMode: 'FULL', schemaExpr: null, remapSchemas: [{ from: 'HR', to: 'HR2' }] })).toBe(
      '덤프 전체 / REMAP_SCHEMA HR→HR2'
    );
  });
});
