import { describe, expect, it } from 'vitest';
import { DataPumpValidationError } from './dataPumpErrors';
import { assertSameItems, draftFromHistory, draftFromRequest, parseExportLog, parseParfile } from './dataPumpParfileParse';

describe('parseParfile', () => {
  it('여러 줄 SCHEMAS, 괄호 목록, 같은 키 여러 줄', () => {
    const draft = parseParfile('DIRECTORY=DP_DIR\nDUMPFILE=exp_%U.dmp\nSCHEMAS=(HR,\n  SCOTT,\n  "MixedCase")\nSCHEMAS=SALES\nPARALLEL=4\nCONTENT=DATA_ONLY\n', true);
    expect(draft).toMatchObject({ mode: 'SCHEMA', directory: 'DP_DIR', dumpfile: 'exp_%U.dmp', parallel: 4, content: 'DATA_ONLY' });
    expect(draft.schemas).toEqual(['HR', 'SCOTT', '"MixedCase"', 'SALES']);
  });

  it('쉼표로 끝난 줄은 다음 줄로 이어지고, 다음 줄이 KEY=가 아니면 이어지는 값', () => {
    expect(parseParfile('SCHEMAS=HR,\nSCOTT\nDUMPFILE=a.dmp', true).schemas).toEqual(['HR', 'SCOTT']);
  });

  it('테이블 300개 이상 + 파티션 지정(T:P1)이 하나도 빠지지 않는다', () => {
    const tables = Array.from({ length: 320 }, (_, i) => `HR.T${i}`);
    const text = `DUMPFILE=big_%U.dmp\nTABLES=${tables.slice(0, 150).join(',')},\n${tables.slice(150).join(',\n')}\nTABLES=SALES.ORDERS:P2026_01,SALES.ORDERS:P2026_02,'"Mx"."Tb":"p1"'`;
    const draft = parseParfile(text, true);
    expect(draft.mode).toBe('TABLE');
    expect(draft.tables).toHaveLength(323);
    expect(draft.tables.slice(-3)).toEqual(['SALES.ORDERS:P2026_01', 'SALES.ORDERS:P2026_02', '"Mx"."Tb":"p1"']);
  });

  it('따옴표가 있는 QUERY(쉼표·등호 포함)는 dataFilter로, DBA 미만이면 채우지 않고 경고', () => {
    const text = `TABLES=HR.EMP\nQUERY=HR.EMP:"WHERE dept IN (10, 20) AND name = 'A,B'"\nQUERY="WHERE ROWNUM < 100"`;
    const draft = parseParfile(text, true);
    expect(draft.dataFilter.queries).toEqual([
      { owner: 'HR', table: 'EMP', where: "WHERE dept IN (10, 20) AND name = 'A,B'" },
      { owner: null, table: null, where: 'WHERE ROWNUM < 100' },
    ]);
    const viewer = parseParfile(text, false);
    expect(viewer.dataFilter).toEqual({});
    expect(viewer.warnings.filter((w) => /QUERY/.test(w))).toHaveLength(2);
  });

  it('%U/%u 덤프 파일 그대로, EXCLUDE/INCLUDE는 오브젝트 필터, REMAP/TABLE_EXISTS_ACTION은 반영 안 됨', () => {
    const text = `DUMPFILE=exp_%U.dmp,exp2_%u.dmp\nSCHEMAS=HR\nEXCLUDE=STATISTICS\nEXCLUDE=TABLE:"IN ('A','B')"\nINCLUDE=INDEX:"LIKE 'PK%'"\nREMAP_SCHEMA=HR:HR2\nTABLE_EXISTS_ACTION=REPLACE\nLOGFILE=x.log\nJOB_NAME=J`;
    const draft = parseParfile(text, true);
    expect(draft.dumpfile).toBe('exp_%U.dmp,exp2_%u.dmp');
    expect(draft.excludeStatistics).toBe(true);
    expect(draft.objectFilter.rules).toEqual([
      { kind: 'EXCLUDE', path: 'TABLE', op: 'IN', values: ['A', 'B'] },
      { kind: 'INCLUDE', path: 'INDEX', op: 'LIKE', values: ['PK%'] },
    ]);
    expect(draft.unknownKeys).toEqual(['REMAP_SCHEMA=HR:HR2', 'TABLE_EXISTS_ACTION=REPLACE']);
    // METRICS / LOGTIME은 Import에도 그대로
    expect(parseParfile('SCHEMAS=HR\nMETRICS=YES\nLOGTIME=ALL', true)).toMatchObject({ metrics: true, logtime: 'ALL', unknownKeys: [] });
  });

  it('FULL과 SCHEMAS가 같이 있거나 같은 항목이 두 번이면 거부', () => {
    expect(() => parseParfile('FULL=Y\nSCHEMAS=HR', true)).toThrow(DataPumpValidationError);
    expect(() => parseParfile('TABLES=HR.A,HR.A', true)).toThrow(/두 번/);
  });
});

describe('parseExportLog', () => {
  it('로그 헤더의 Starting 명령줄에서 파싱 (줄이 이어져도)', () => {
    const log = [
      ';;; ',
      'Export: Release 19.0.0.0.0 - Production on Fri Oct 2 07:48:46 2026',
      'Starting "SYSTEM"."SYS_EXPORT_TABLE_01":  system/******** directory=DATA_PUMP_DIR dumpfile=e_%U.dmp logfile=e.log',
      '  tables=HR.EMP,HR.DEPT,SALES.ORDERS:P1 parallel=2 query=HR.EMP:"WHERE id > 10"',
      'Processing object type TABLE_EXPORT/TABLE/TABLE_DATA',
    ].join('\n');
    const draft = parseExportLog(log, true);
    expect(draft).toMatchObject({ mode: 'TABLE', directory: 'DATA_PUMP_DIR', dumpfile: 'e_%U.dmp', parallel: 2, tables: ['HR.EMP', 'HR.DEPT', 'SALES.ORDERS:P1'] });
    expect(draft.dataFilter.queries).toEqual([{ owner: 'HR', table: 'EMP', where: 'WHERE id > 10' }]);
  });

  it('parfile로 돌린 로그는 파라미터가 없어 거부', () => {
    expect(() => parseExportLog('Starting "SYSTEM"."J":  system/******** parfile=x.par\nProcessing', true)).toThrow(/parfile/);
  });
});

describe('작업 이력에서', () => {
  it('저장된 요청: 파티션과 스키마별 하위 작업 소유자', () => {
    const draft = draftFromRequest(
      {
        operation: 'EXPORT',
        mode: 'TABLE',
        qualifiedTables: [{ owner: 'HR', table: 'SALES' }, { owner: 'SCOTT', table: 'EMP' }],
        tablePartitions: [{ owner: 'HR', table: 'SALES', partitions: ['P1', 'P2'] }],
        directory: 'D',
        dumpfile: 'x_%U.dmp',
        logfile: 'x.log',
      },
      { directory: 'D', dumpfile: 'x_HR_%U.dmp' },
      new Set(['HR']),
      true
    );
    expect(draft).toMatchObject({ mode: 'TABLE', dumpfile: 'x_HR_%U.dmp', tables: ['HR.SALES:P1', 'HR.SALES:P2'] });
  });

  it('요청이 없으면 대상 목록, 요약이 잘렸으면 거부', () => {
    expect(draftFromHistory({ directory: 'D', dumpfile: 'a.dmp', jobMode: 'TABLE', targetDesc: null, expected: ['QUP.BIG', 'QUP.Mixed:p1'] }, true).tables).toEqual(['QUP.BIG', 'QUP."Mixed":"p1"']);
    expect(draftFromHistory({ directory: 'D', dumpfile: 'a.dmp', jobMode: 'SCHEMA', targetDesc: 'SCHEMAS=HR,SCOTT / 제외 테이블 1개', expected: null }, true).schemas).toEqual(['HR', 'SCOTT']);
    expect(() => draftFromHistory({ directory: 'D', dumpfile: 'a.dmp', jobMode: 'TABLE', targetDesc: 'HR 테이블 12개: A, B …', expected: null }, true)).toThrow(/전체 목록/);
  });
});

describe('assertSameItems', () => {
  it('항목 수나 내용이 다르면 에러 (빠진/추가된 목록 포함)', () => {
    expect(() => assertSameItems(['A', 'B'], ['B', 'A'])).not.toThrow();
    try {
      assertSameItems(['HR.A', 'HR.B:P1'], ['HR.A']);
      throw new Error('예외가 나지 않음');
    } catch (error) {
      expect(error).toBeInstanceOf(DataPumpValidationError);
      expect((error as DataPumpValidationError).items).toEqual(['빠짐: HR.B:P1']);
    }
  });
});

describe('가져온 항목으로 만든 Import parfile', () => {
  it('파티션 항목(OWNER.T:P)이 TABLES=에 그대로 나오고 기존 Import 검사를 통과한다', async () => {
    const { buildParfile, buildPlan, assertImportCovers } = await import('./dataPumpService');
    const request = {
      operation: 'IMPORT' as const,
      mode: 'TABLE' as const,
      qualifiedTables: [{ owner: 'SALES', table: 'ORDERS' }, { owner: 'SALES', table: 'ITEMS' }],
      tablePartitions: [{ owner: 'SALES', table: 'ORDERS', partitions: ['P1', 'P2'] }],
      directory: 'D',
      dumpfile: 'e_%U.dmp',
      logfile: 'imp.log',
    };
    const plan = buildPlan(request);
    const { parfile } = buildParfile(plan, request, { dbname: 'T', user: 'SYSTEM', host: 'h', port: '1521', sid: 'S' });
    expect(parfile).toContain('TABLES=SALES.ORDERS:P1,SALES.ORDERS:P2,SALES.ITEMS');
    expect(() => assertImportCovers(plan, request, parfile)).not.toThrow();
  });
});
