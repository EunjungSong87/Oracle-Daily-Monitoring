import { describe, expect, it } from 'vitest';
import { DataPumpValidationError } from './dataPumpErrors';
import { parElement, parseIdentifier, parseParList, parseQualified, qualifiedName, sqlName, suggestByCase } from './dataPumpNames';

describe('parseIdentifier', () => {
  it('따옴표 없는 이름은 대문자로 (지금과 같음)', () => {
    expect(parseIdentifier('hr', '스키마')).toBe('HR');
    expect(parseIdentifier('  Emp_01 ', '테이블')).toBe('EMP_01');
  });

  it('큰따옴표로 감싼 이름은 대소문자를 그대로 둔다 — 지금은 "MyTable"이 MYTABLE이 되어 DB에서 못 찾고 빠졌다', () => {
    expect(parseIdentifier('"MyTable"', '테이블')).toBe('MyTable');
    expect(parseIdentifier('"p2025"', '파티션')).toBe('p2025');
    expect(parseIdentifier('"EMP"', '테이블')).toBe('EMP');
    expect(parseIdentifier('"1ABC"', '테이블')).toBe('1ABC'); // 따옴표가 있어야만 가능한 이름
  });

  it('따옴표 안이라도 필터식/parfile에 끼어들 문자는 거부한다', () => {
    for (const bad of ['"A\'B"', '"A B"', '"A,B"', '"A.B"', '"A:B"', '""', '"A"B"', '"A;B"']) {
      expect(() => parseIdentifier(bad, '테이블')).toThrow(DataPumpValidationError);
    }
    expect(() => parseIdentifier("HR') OR 1=1 --", '스키마')).toThrow(/스키마/);
  });
});

describe('sqlName / parElement — 도커 23ai expdp로 확인한 parfile 문법', () => {
  it('일반 대문자 이름은 그대로, 그 외는 큰따옴표', () => {
    expect(sqlName('HR')).toBe('HR');
    expect(sqlName('MyTable')).toBe('"MyTable"');
    expect(sqlName('1ABC')).toBe('"1ABC"');
  });

  it('parseIdentifier(sqlName(x)) === x (화면↔서버 왕복에서 이름이 바뀌지 않는다)', () => {
    for (const name of ['HR', 'MyTable', 'p2025', '1ABC', 'A$B#C']) expect(parseIdentifier(sqlName(name), 'x')).toBe(name);
  });

  it('큰따옴표가 든 원소는 원소 전체를 작은따옴표로 감싼다 (값이 "로 시작하면 expdp가 따옴표를 벗겨 QTEST로 바꿔 버림)', () => {
    expect(parElement(qualifiedName('QUP', 'EMP'))).toBe('QUP.EMP');
    expect(parElement(qualifiedName('QTest', 'MyTable', 'p2025'))).toBe('\'"QTest"."MyTable":"p2025"\'');
    expect(parElement(qualifiedName('QUP', 'Mixed'))).toBe('\'QUP."Mixed"\'');
    expect(parElement(`${sqlName('QTest')}:${sqlName('Qup2')}`)).toBe('\'"QTest":"Qup2"\''); // REMAP_SCHEMA는 쌍 전체
  });
});

describe('parseParList / parseQualified — parfile을 다시 읽어 불변식 검사', () => {
  it('작은따옴표로 감싼 원소 안의 쉼표/따옴표를 구분자로 보지 않는다', () => {
    const line = `'"QTest"."MyTable":"p2025"','"QTest".UPPER_T',QUP.EMP,'QUP."Mixed"'`;
    expect(parseParList(line).map((item) => parseQualified(item))).toEqual([
      { owner: 'QTest', table: 'MyTable', partition: 'p2025' },
      { owner: 'QTest', table: 'UPPER_T', partition: null },
      { owner: 'QUP', table: 'EMP', partition: null },
      { owner: 'QUP', table: 'Mixed', partition: null },
    ]);
  });

  it('스키마 목록', () => {
    expect(parseParList(`'"QTest"',QUP`).map((item) => parseIdentifier(item, '스키마'))).toEqual(['QTest', 'QUP']);
  });
});

describe('suggestByCase — 대문자로 못 찾았지만 대소문자 무시하면 있는 이름 (자동으로 바꾸지 않고 후보만)', () => {
  it('후보를 SQL 표기로 돌려준다', () => {
    expect(suggestByCase('MYTABLE', ['MyTable', 'EMP', 'mytable'])).toEqual(['"MyTable"', '"mytable"']);
    expect(suggestByCase('EMP', ['EMP'])).toEqual([]); // 정확히 있으면 후보가 아님
    expect(suggestByCase('NOPE', ['EMP'])).toEqual([]);
  });
});
