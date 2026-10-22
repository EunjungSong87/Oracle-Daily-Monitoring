// 실행 후 대조: expdp/impdp 로그의 ". . exported/imported" 줄을 읽어 계획의 대상 목록과 비교한다 (DB 접근 없는 순수 함수).
// 로그 줄 예 (23ai):
//   . . exported "QTest"."MyTable":"p2025"                     5.5 KB       1 rows
//   . . exported "QUP"."COMP":"P1"."SYS_SUBP1368"              5.6 KB       4 rows
//   . . imported "QUP2"."EMP"                                  5.1 KB       5 rows
//   Table "QUP2"."COMP" exists. All dependent metadata and data will be skipped due to table_exists_action of skip

export interface LogItem {
  action: 'exported' | 'imported';
  owner: string;
  table: string;
  partition: string | null;
  subpartition: string | null;
  rows: number | null;
}

export interface VerifyResult {
  status: 'MATCH' | 'MISMATCH' | 'NA';
  notInLog: string[]; // 계획에 있는데 로그에 없음
  notInPlan: string[]; // 로그에 있는데 계획에 없음
  skipped: string[]; // TABLE_EXISTS_ACTION=SKIP으로 건너뛴 테이블 (이유 표시용)
}

const ITEM_LINE = /^\. \. (exported|imported) "([^"]+)"\."([^"]+)"(?::"([^"]+)")?(?:\."([^"]+)")?\s+.*?(\d+) rows\s*$/;
const SKIP_LINE = /^Table "([^"]+)"\."([^"]+)" exists\..*skipped/;

function parseLogItems(text: string): LogItem[] {
  const items: LogItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(ITEM_LINE);
    if (!match) continue;
    items.push({
      action: match[1] as LogItem['action'],
      owner: match[2],
      table: match[3],
      partition: match[4] ?? null,
      subpartition: match[5] ?? null,
      rows: Number(match[6]),
    });
  }
  return items;
}

// ORA- 줄을 코드별로 묶어 "ORA-39166 ×5: 첫 메시지 / …" (없으면 null)
function parseErrorSummary(text: string): string | null {
  const byCode = new Map<string, { count: number; first: string }>();
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^(ORA-\d{5}):\s*(.*)$/);
    if (!match) continue;
    const found = byCode.get(match[1]);
    if (found) found.count++;
    else byCode.set(match[1], { count: 1, first: match[2] });
  }
  if (byCode.size === 0) return null;
  return [...byCode]
    .map(([code, { count, first }]) => `${code} ×${count}: ${first}`)
    .join(' / ')
    .slice(0, 3900);
}

// expected: 정확한 이름의 OWNER.TABLE(통째 — 그 테이블의 어떤 줄이든 있으면 됨) 또는 OWNER.TABLE:PART. null이면 판단하지 않음.
function reconcile(expected: string[] | null, text: string): VerifyResult {
  const items = parseLogItems(text);
  const skipped = text
    .split(/\r?\n/)
    .map((line) => line.trim().match(SKIP_LINE))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => `${match[1]}.${match[2]}`);
  if (!expected) return { status: 'NA', notInLog: [], notInPlan: [], skipped };
  const tableKey = (item: LogItem) => `${item.owner}.${item.table}`;
  const partKey = (item: LogItem) => (item.partition ? `${tableKey(item)}:${item.partition}` : null);
  const loggedTables = new Set(items.map(tableKey));
  const loggedParts = new Set(items.map(partKey).filter((key): key is string => !!key));
  const notInLog = expected.filter((key) => (key.includes(':') ? !loggedParts.has(key) : !loggedTables.has(key)));
  const wholeExpected = new Set(expected.filter((key) => !key.includes(':')));
  const partExpected = new Set(expected.filter((key) => key.includes(':')));
  const notInPlan = [
    ...new Set(
      items
        .filter((item) => !wholeExpected.has(tableKey(item)) && !(partKey(item) && partExpected.has(partKey(item) as string)))
        .map((item) => partKey(item) ?? tableKey(item))
    ),
  ];
  return { status: notInLog.length === 0 && notInPlan.length === 0 ? 'MATCH' : 'MISMATCH', notInLog, notInPlan, skipped };
}

// export 로그와 import 로그의 테이블(파티션)별 행 수 비교. import 쪽 이름은 REMAP_SCHEMA를 반영한 대상 스키마.
function compareRows(exported: LogItem[], imported: LogItem[], remapSchemas: { from: string; to: string }[]): string[] {
  const remap = new Map(remapSchemas.map((pair) => [pair.from, pair.to]));
  const sum = (items: LogItem[], owner: (item: LogItem) => string) => {
    const map = new Map<string, number>();
    for (const item of items) {
      const key = `${owner(item)}.${item.table}${item.partition ? `:${item.partition}` : ''}`;
      map.set(key, (map.get(key) ?? 0) + (item.rows ?? 0));
    }
    return map;
  };
  const exp = sum(exported, (item) => remap.get(item.owner) ?? item.owner);
  const imp = sum(imported, (item) => item.owner);
  const diffs: string[] = [];
  for (const [key, rows] of imp) {
    const before = exp.get(key);
    if (before !== undefined && before !== rows) diffs.push(`${key}: export ${before}행 / import ${rows}행`);
  }
  return diffs;
}

export { parseLogItems, parseErrorSummary, reconcile, compareRows };
