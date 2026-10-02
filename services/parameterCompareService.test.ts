import { describe, expect, it } from 'vitest';
import { compareParameterSnapshots, isEnvSpecific } from './parameterCompareService';
import type { ParameterInfo, ParameterSnapshot } from '../models/parameterCompareModel';

function parameter(name: string, value: string | null, isDefault = true): ParameterInfo {
  return { name, value, displayValue: value, isDefault, description: null };
}

function snapshot(parameters: ParameterInfo[], hiddenIncluded = true): ParameterSnapshot {
  return { dbname: 'DB', instance: null, parameters, source: hiddenIncluded ? 'X$' : 'V$PARAMETER', hiddenIncluded };
}

const resultOf = (items: ReturnType<typeof compareParameterSnapshots>) => Object.fromEntries(items.map((item) => [item.name, item.result]));

describe('compareParameterSnapshots', () => {
  it('값 비교는 VALUE 기준, 대소문자/앞뒤 공백 무시', () => {
    const items = compareParameterSnapshots(
      snapshot([parameter('a', 'TRUE'), parameter('b', ' 100 '), parameter('c', '1'), parameter('d', null)]),
      snapshot([parameter('a', 'true'), parameter('b', '100'), parameter('c', '2'), parameter('d', '')])
    );
    expect(resultOf(items)).toEqual({ a: 'SAME', b: 'SAME', c: 'DIFF', d: 'SAME' });
  });

  it('한쪽에만 있는 파라미터를 구분하고 이름순으로 정렬한다', () => {
    const items = compareParameterSnapshots(snapshot([parameter('z', '1'), parameter('only_src', '1')]), snapshot([parameter('z', '1'), parameter('only_tgt', '1')]));
    expect(items.map((item) => [item.name, item.result])).toEqual([
      ['only_src', 'ONLY_SOURCE'],
      ['only_tgt', 'ONLY_TARGET'],
      ['z', 'SAME'],
    ]);
  });

  it('양쪽 다 hidden을 읽었으면 기본값 hidden까지 전부 비교한다', () => {
    const items = compareParameterSnapshots(
      snapshot([parameter('_a', '1'), parameter('_b', 'X')]),
      snapshot([parameter('_a', '2'), parameter('_b', 'X')])
    );
    expect(resultOf(items)).toEqual({ _a: 'DIFF', _b: 'SAME' });
    expect(items.every((item) => item.hidden)).toBe(true);
  });

  it('한쪽만 hidden을 읽었으면 기본값 hidden은 빼고 직접 설정한 hidden끼리만 비교한다', () => {
    const withHidden = snapshot([parameter('_default_one', '1', true), parameter('_set_one', '5', false), parameter('open_cursors', '300', false)]);
    const withoutHidden = snapshot([parameter('_set_one', '5', false), parameter('open_cursors', '500', false)], false);
    const items = compareParameterSnapshots(withHidden, withoutHidden);
    expect(resultOf(items)).toEqual({ _set_one: 'SAME', open_cursors: 'DIFF' });
  });
});

describe('isEnvSpecific', () => {
  it('DB/서버마다 다른 게 정상인 파라미터를 구분한다', () => {
    expect(isEnvSpecific('db_name')).toBe(true);
    expect(isEnvSpecific('control_files')).toBe(true);
    expect(isEnvSpecific('log_archive_dest_2')).toBe(true);
    expect(isEnvSpecific('open_cursors')).toBe(false);
    expect(isEnvSpecific('sga_target')).toBe(false);
  });
});
