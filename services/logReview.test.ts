import { describe, expect, it } from 'vitest';
import { analyze, detectSuspiciousConnections, limitText, parseTimestamp, summarize, validateLineNumbers, MAX_LINES } from './logReview';

const ALERT_LOG = [
  'Mon Nov 17 10:15:32 2026',
  'Errors in file /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/ORCL_ora_1234.trc  (incident=12345):',
  'ORA-00600: internal error code, arguments: [kcbz_check_objd_typ], [], [], []',
  '2026-11-17T11:00:00.123456+09:00',
  'Thread 1 cannot allocate new log, sequence 1234',
  'Checkpoint not complete',
  'ORA-01555 caused by SQL statement below (SQL ID: abc123, Query Duration=1234 sec, SCN: 0x0000.12345678):',
  'ORA-28000: the account is locked',
  'ORA-12012: error on auto execute of job 123',
  'Completed: ALTER DATABASE OPEN',
].join('\n');

const listenerLine = (time: string, ip: string, code: number) =>
  `17-NOV-2026 ${time} * (CONNECT_DATA=(SERVICE_NAME=ORCL)(CID=(PROGRAM=sqlplus)(HOST=apphost)(USER=app))) * (ADDRESS=(PROTOCOL=tcp)(HOST=${ip})(PORT=51234)) * establish * ORCL * ${code}`;

describe('analyze — ALERT', () => {
  const findings = analyze('ALERT', ALERT_LOG);
  const at = (line: number) => findings.find((f) => f.line === line && !f.synthetic);

  it('규칙별 심각도/카테고리', () => {
    expect(at(2)).toMatchObject({ severity: 'INFO', category: 'TRACE' });
    expect(at(3)).toMatchObject({ severity: 'CRITICAL', category: 'INTERNAL', label: '내부 오류' });
    expect(at(5)).toMatchObject({ severity: 'WARN', category: 'REDO' });
    expect(at(6)).toMatchObject({ severity: 'WARN', label: '체크포인트 지연' });
    expect(at(7)).toMatchObject({ severity: 'WARN', category: 'UNDO' });
    expect(at(8)).toMatchObject({ severity: 'CRITICAL', category: 'SECURITY' });
    expect(at(9)).toMatchObject({ severity: 'INFO', category: 'OTHER', label: '기타 ORA 오류 (ORA-12012)' });
    expect(at(10)).toBeUndefined();
  });

  it('시각은 머리 줄에서 이어받음 (11g / 12.2+ 포맷)', () => {
    expect(at(3)?.time).toBe('2026-11-17 10:15:32');
    expect(at(5)?.time).toBe('2026-11-17 11:00:00');
  });

  it('context는 전후 2줄', () => {
    expect(at(3)).toMatchObject({ contextFrom: 1, context: ALERT_LOG.split('\n').slice(0, 5) });
  });

  it('요약', () => {
    expect(summarize(findings)).toMatchObject({ critical: 2, warn: 3, info: 2, security: 1, total: 7 });
  });
});

describe('analyze — LISTENER / CRS', () => {
  it('리스너: 타임아웃, 리턴코드 ≠ 0, 기타 TNS', () => {
    const text = [
      listenerLine('10:00:00', '10.0.0.1', 0),
      listenerLine('10:00:01', '10.0.0.2', 12514),
      'TNS-12514: TNS:listener does not currently know of service requested in connect descriptor',
      'TNS-12535: TNS:operation timed out',
      'TNS-01189: The listener could not authenticate the user',
    ].join('\n');
    const findings = analyze('LISTENER', text);
    expect(findings.map((f) => [f.line, f.severity, f.category, f.label])).toEqual([
      [2, 'WARN', 'CONNECTION', '연결 실패(코드 12514)'],
      [3, 'INFO', 'OTHER', '기타 TNS 오류 (TNS-12514)'],
      [4, 'WARN', 'CONNECTION', '연결 타임아웃'],
      [5, 'CRITICAL', 'SECURITY', '리스너 권한 부족/인증 실패'],
    ]);
    expect(findings[0].time).toBe('2026-11-17 10:00:01');
  });

  it('CRS: 하트비트/Eviction은 CRITICAL, 섞인 ORA도 잡음', () => {
    const text = [
      '2026-11-17 10:15:32.123 [OCSSD(1234)]CRS-1612: Network communication with node rac2 (2) missing for 50% of timeout interval.',
      '2026-11-17 10:15:40.000 [CRSD(2222)]CRS-2765: Resource ora.asm has failed on server rac1',
      '2026-11-17 10:16:00.000 [OHASD(3333)]ORA-00600: internal error code',
      '17-NOV-2026 10:17:00 CRS-8011: reboot advisory message from host: rac2',
    ].join('\n');
    const findings = analyze('CRS', text);
    expect(findings.map((f) => [f.severity, f.category])).toEqual([
      ['CRITICAL', 'CLUSTER'],
      ['INFO', 'OTHER'],
      ['CRITICAL', 'INTERNAL'],
      ['WARN', 'CLUSTER'],
    ]);
    expect(findings[3].time).toBe('2026-11-17 10:17:00');
  });
});

describe('detectSuspiciousConnections — IP별 연속 접속 실패', () => {
  it('같은 IP가 5분 안에 6번 실패 → 합성 finding 1개', () => {
    const lines = [
      ...['10:00:00', '10:01:00', '10:02:00', '10:03:00', '10:04:00', '10:05:00'].map((t) => listenerLine(t, '10.0.0.5', 1017)),
      listenerLine('10:02:30', '10.0.0.9', 12514),
      listenerLine('10:03:30', '10.0.0.5', 0),
    ];
    const found = detectSuspiciousConnections(lines);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'CRITICAL',
      category: 'SECURITY',
      line: 1,
      label: 'IP 10.0.0.5 에서 6건 연속 접속 실패 (2026-11-17 10:00:00~2026-11-17 10:05:00)',
      synthetic: true,
      contextFrom: null,
    });
    expect(found[0].context).toHaveLength(6);
  });

  it('threshold 미달이거나 창 밖으로 흩어지면 안 생김', () => {
    const four = ['10:00:00', '10:01:00', '10:02:00', '10:03:00'].map((t) => listenerLine(t, '10.0.0.5', 12514));
    expect(detectSuspiciousConnections(four)).toEqual([]);
    const spread = ['10:00:00', '10:11:00', '10:22:00', '10:33:00', '10:44:00'].map((t) => listenerLine(t, '10.0.0.5', 12514));
    expect(detectSuspiciousConnections(spread)).toEqual([]);
  });

  it('analyze(LISTENER)에 합성 finding이 같이 들어감', () => {
    const text = ['10:00:00', '10:00:10', '10:00:20', '10:00:30', '10:00:40'].map((t) => listenerLine(t, '192.168.1.7', 12514)).join('\n');
    const findings = analyze('LISTENER', text);
    expect(findings.filter((f) => f.synthetic)).toHaveLength(1);
    expect(findings.filter((f) => !f.synthetic)).toHaveLength(5);
    expect(summarize(findings)).toMatchObject({ critical: 1, warn: 5, security: 1 });
  });
});

describe('골라낸 줄(대용량 리스너 로그) — 원본 줄 번호', () => {
  const picked = [listenerLine('10:00:00', '10.0.0.5', 12514), 'TNS-12514: TNS:listener does not currently know of service', listenerLine('10:00:30', '10.0.0.5', 12514)];
  const content = picked.join('\n');

  it('줄 번호를 원본 기준으로, 전후 줄은 연속이 아니라 contextFrom null', () => {
    const findings = analyze('LISTENER', content, [1000, 1001, 5000]);
    expect(findings.map((f) => [f.line, f.label])).toEqual([
      [1000, '연결 실패(코드 12514)'],
      [1001, '기타 TNS 오류 (TNS-12514)'],
      [5000, '연결 실패(코드 12514)'],
    ]);
    expect(findings.every((f) => f.contextFrom === null)).toBe(true);
  });

  it('합성 finding도 원본 줄 번호', () => {
    const lines = ['10:00:00', '10:00:10', '10:00:20', '10:00:30', '10:00:40'].map((t) => listenerLine(t, '10.0.0.5', 1017));
    expect(detectSuspiciousConnections(lines, 10, 5, [11, 22, 33, 44, 55])[0]).toMatchObject({ line: 11 });
  });

  it('validateLineNumbers: 개수·증가 순·원본 줄 수 검사', () => {
    expect(validateLineNumbers(content, [1000, 1001, 5000], 6000)).toBeNull();
    expect(validateLineNumbers(content, [1000, 1001], 6000)).not.toBeNull();
    expect(validateLineNumbers(content, [1000, 1000, 5000], 6000)).not.toBeNull();
    expect(validateLineNumbers(content, [1000, 1001, 5000], 4000)).not.toBeNull();
    expect(validateLineNumbers(content, 'x', 6000)).not.toBeNull();
  });
});

describe('기타', () => {
  it('타임스탬프 포맷이 아니면 null', () => {
    expect(parseTimestamp('Completed: ALTER DATABASE OPEN', 'ALERT')).toBeNull();
    expect(parseTimestamp('17-XXX-2026 10:00:00 *', 'LISTENER')).toBeNull();
  });

  it('줄 수가 MAX_LINES를 넘으면 뒷부분(최근)만, 줄 번호는 원본 기준', () => {
    const text = `${'x\n'.repeat(MAX_LINES + 10)}ORA-00600: internal error\n`;
    const limited = limitText(text);
    expect(limited).toMatchObject({ truncatedLines: true, truncatedBytes: false, lineCount: MAX_LINES, lineOffset: 11 });
    expect(limited.text.endsWith('ORA-00600: internal error')).toBe(true);
    const findings = analyze('ALERT', limited.text, limited.lineOffset);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: MAX_LINES + 11, contextFrom: MAX_LINES + 9 });
  });
});
