import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { compareRows, parseErrorSummary, parseLogItems, reconcile } from './dataPumpLogVerify';

// 도커 23ai에서 직접 돌린 expdp/impdp 로그 (services/__fixtures__/datapump)
const log = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', 'datapump', `${name}.log`), 'utf-8');

describe('parseLogItems', () => {
  it('파티션 줄과 따옴표 이름', () => {
    expect(parseLogItems(log('qt_api1'))).toEqual([
      { action: 'exported', owner: 'QTest', table: 'MyTable', partition: 'p2025', subpartition: null, rows: 1 },
      { action: 'exported', owner: 'QTest', table: 'UPPER_T', partition: null, subpartition: null, rows: 1 },
    ]);
  });

  it('서브파티션 줄은 파티션 이름까지, 0 rows도 항목', () => {
    const items = parseLogItems(log('qt_comp'));
    expect(items.map((item) => [item.table, item.partition, item.subpartition, item.rows])).toEqual([
      ['COMP', 'P1', 'SYS_SUBP1368', 4],
      ['COMP', 'P1', 'SYS_SUBP1369', 6],
      ['EMP', null, null, 5],
      ['EMPTY_T', null, null, 0],
      ['Mixed', null, null, 0],
    ]);
  });

  it('import 줄', () => {
    expect(parseLogItems(log('qt_imp3')).map((item) => `${item.action} ${item.owner}.${item.table}:${item.partition} ${item.rows}`)).toEqual([
      'imported QUP2.MyTable:p2025 1',
      'imported QUP2.UPPER_T:null 1',
    ]);
  });
});

describe('parseErrorSummary', () => {
  it('ORA- 줄을 코드별로 요약', () => {
    const summary = parseErrorSummary(log('t1'));
    expect(summary).toContain('ORA-39166 ×5');
    expect(summary).toContain('ORA-31655 ×1');
    expect(parseErrorSummary(log('qt_api1'))).toBeNull();
  });
});

describe('reconcile — 계획 대상 vs 로그', () => {
  it('일치', () => {
    const result = reconcile(['QTest.MyTable:p2025', 'QTest.UPPER_T'], log('qt_api1'));
    expect(result).toMatchObject({ status: 'MATCH', notInLog: [], notInPlan: [] });
  });

  it('계획에 있는데 로그에 없음 / 로그에 있는데 계획에 없음', () => {
    const result = reconcile(['QTest.MyTable:p2025', 'QTest.MyTable:P2026', 'QTest.GONE'], log('qt_api1'));
    expect(result.status).toBe('MISMATCH');
    expect(result.notInLog).toEqual(['QTest.MyTable:P2026', 'QTest.GONE']);
    expect(result.notInPlan).toEqual(['QTest.UPPER_T']);
  });

  it('통째 테이블은 파티션/서브파티션 줄 어느 것이든 있으면 됨, 파티션 대상은 서브파티션 줄의 파티션 이름으로', () => {
    expect(reconcile(['QUP.COMP:P1', 'QUP.EMP', 'QUP.EMPTY_T', 'QUP.Mixed'], log('qt_comp')).status).toBe('MATCH');
    expect(reconcile(['QUP.COMP', 'QUP.EMP', 'QUP.EMPTY_T', 'QUP.Mixed'], log('qt_comp')).status).toBe('MATCH');
  });

  it('import에서 TABLE_EXISTS_ACTION=SKIP으로 건너뛴 테이블은 "successfully completed"여도 불일치로 잡고 이유를 붙인다', () => {
    const result = reconcile(['QUP2.COMP', 'QUP2.EMP', 'QUP2.EMPTY_T', 'QUP2.Mixed'], log('qt_imp2'));
    expect(result.status).toBe('MISMATCH');
    expect(result.notInLog).toHaveLength(4);
    expect(result.skipped).toEqual(['QUP2.COMP', 'QUP2.Mixed', 'QUP2.EMP', 'QUP2.EMPTY_T']);
  });

  it('대상 목록이 없으면(스키마/FULL import, 비교할 export 기록 없음) 판단 안 함', () => {
    expect(reconcile(null, log('qt_imp1')).status).toBe('NA');
  });
});

describe('compareRows — export 로그 vs import 로그 (REMAP 반영)', () => {
  it('행 수가 같으면 차이 없음', () => {
    expect(compareRows(parseLogItems(log('qt_comp')), parseLogItems(log('qt_imp1')), [{ from: 'QUP', to: 'QUP2' }])).toEqual([]);
  });

  it('행 수가 다르면 표시', () => {
    const exported = parseLogItems(log('qt_comp')).map((item) => (item.table === 'EMP' ? { ...item, rows: 7 } : item));
    expect(compareRows(exported, parseLogItems(log('qt_imp1')), [{ from: 'QUP', to: 'QUP2' }])).toEqual(['QUP2.EMP: export 7행 / import 5행']);
  });
});

describe('LOGTIME=ALL + METRICS=YES 로그 (23ai 실제 로그)', () => {
  const text = readFileSync(path.join(__dirname, '__fixtures__/datapump/logtime_metrics.log'), 'utf8');

  it('줄 앞 시각·작업자 표시와 줄 끝 수행 시간을 떼고 읽는다', () => {
    expect(parseLogItems(text).map((item) => `${item.owner}.${item.table}${item.partition ? `:${item.partition}` : ''}=${item.rows}`)).toEqual(['CMP_SRC.MIG_SALES:P2026_01=526', 'CMP_SRC.MIG_CUST=500']);
    expect(reconcile(['CMP_SRC.MIG_SALES:P2026_01', 'CMP_SRC.MIG_CUST'], text).status).toBe('MATCH');
  });

  it('결과 줄과 덤프 파일 목록도 읽는다', async () => {
    const { parseDataPumpLog } = await import('./dataPumpHistoryService');
    expect(parseDataPumpLog(text)).toMatchObject({ status: 'COMPLETED', elapsedSec: 49, dumpFiles: ['lt1_01_01.dmp'] });
  });
});
