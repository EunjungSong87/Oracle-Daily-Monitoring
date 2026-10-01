import type { CompareResultKind } from '../../shared/lib/types';

// 비교 가능한 오브젝트 타입 — 서버(models/objectCompareModel.ts의 OBJECT_TYPES)와 같은 목록/순서.
// 서버는 모르는 타입을 무시하므로 어긋나도 오류는 안 나지만, 새 타입을 추가할 땐 양쪽을 같이 고친다.
export const OBJECT_TYPES = [
  'TABLESPACE',
  'TABLE',
  'INDEX',
  'VIEW',
  'MATERIALIZED VIEW',
  'SEQUENCE',
  'SYNONYM',
  'FUNCTION',
  'PROCEDURE',
  'PACKAGE',
  'PACKAGE BODY',
  'TRIGGER',
  'TYPE',
  'TYPE BODY',
];

export const RESULT_LABEL: Record<CompareResultKind, string> = {
  SAME: '동일',
  DIFF: '다름',
  ONLY_SOURCE: '기준에만 있음',
  ONLY_TARGET: '대상에만 있음',
};
