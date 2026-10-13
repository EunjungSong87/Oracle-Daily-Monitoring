import type { CompareItem, SourceDiffLine } from '../../shared/lib/types';

// 뷰/PL/SQL "다름" 항목의 DDL: 펼칠 때 받아 온 소스 diff에서 기준 쪽 소스를 꺼내 대상 스키마에 CREATE OR REPLACE.
// (테이블/인덱스/시퀀스/시노님 DDL은 서버가 비교할 때 item.ddl로 만들어 준다)

const PLAIN_IDENTIFIER = /^[A-Z][A-Z0-9_$#]*$/;

function quoteName(name: string): string {
  return PLAIN_IDENTIFIER.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

// DBA_SOURCE 첫 줄 (서버가 "스키마." 접두어를 이미 지움): "PROCEDURE P_DIFF (p_id IN NUMBER) AS"
const CODE_HEADER = /^(\s*(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PACKAGE\s+BODY|TYPE\s+BODY|PACKAGE|TYPE|PROCEDURE|FUNCTION|TRIGGER)\s+)/i;

export function codeDdl(
  item: CompareItem,
  lines: SourceDiffLine[],
  targetSchema: string | null | undefined,
  sourceSchema?: string | null
): string[] {
  if (item.type === 'MATERIALIZED VIEW') {
    return ['-- MATERIALIZED VIEW는 CREATE OR REPLACE가 없음: 대상에서 DROP 후 기준 정의(위 소스)로 다시 만들어야 함'];
  }
  // 기준 쪽 소스 = diff에서 대상에만 있는 줄(add)을 뺀 것
  const source = lines.filter((line) => line.op !== 'add').map((line) => line.text);
  if (source.length === 0) return [];
  const prefix = targetSchema ? `${quoteName(targetSchema)}.` : '';
  // 본문에 기준 스키마 이름이 적혀 있으면(예: FROM HR.EMP) 대상에서 그 스키마를 보게 되므로 알려 준다 (자동으로 바꾸지는 않음).
  const schemaWarning =
    sourceSchema && targetSchema && sourceSchema !== targetSchema && new RegExp(`(^|[^A-Z0-9_$#])"?${sourceSchema.replace(/[$#]/g, '\\$&')}"?\\s*\\.`, 'i').test(source.join('\n'))
      ? [`-- 본문에 기준 스키마 ${sourceSchema}가 적혀 있음 — 대상(${targetSchema})에서는 그 스키마의 오브젝트를 보게 되니 확인 후 바꾸세요`]
      : [];
  if (item.type === 'VIEW') {
    return [...schemaWarning, `CREATE OR REPLACE VIEW ${prefix}${quoteName(item.name)} AS`, ...source, '/'];
  }
  const header = source[0].match(CODE_HEADER);
  const first = header ? `${header[1]}${prefix}${source[0].slice(header[1].length).trimStart()}` : source[0];
  return [
    ...schemaWarning,
    ...(item.type === 'TRIGGER' ? ['-- 트리거 본문의 ON 테이블 스키마가 대상과 맞는지 확인'] : []),
    `CREATE OR REPLACE ${first.trimStart()}`,
    ...source.slice(1),
    '/',
  ];
}

// 여러 항목의 DDL을 하나의 스크립트로 (항목마다 "-- [종류] 스키마.이름" 머리줄)
export function bundleDdl(items: { item: CompareItem; ddl: string[] }[]): string {
  return items
    .filter(({ ddl }) => ddl.length > 0)
    .map(({ item, ddl }) => [`-- [${item.type}] ${item.targetSchema ? `${item.targetSchema}.` : ''}${item.name}`, ...ddl].join('\n'))
    .join('\n\n')
    .concat('\n');
}
