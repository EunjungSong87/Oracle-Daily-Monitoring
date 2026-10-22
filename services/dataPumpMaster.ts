// 앱 밖에서 직접 돌린 Data Pump 작업의 마스터 테이블(OWNER.JOB_NAME) 메타 행 해석 (DB 접근 없는 순수 함수).
// 도커 23ai에서 expdp/impdp를 직접 돌려 확인한 내용 (process_order 번호는 버전마다 다를 수 있어 NAME 기준으로 읽음):
//   process_order = -1 : 작업 행 — OPERATION, JOB_MODE, USER_NAME, START_TIME
//   NAME/VALUE_T       : LOG_FILE_NAME, LOG_FILE_DIRECTORY, CLIENT_COMMAND, SCHEMA_LIST ('A','B'), SCHEMA_EXPR,
//                        CUSTOM_FILTER (TABLES= 일 때: ku$.schema_obj.owner_name = 'QUP' AND ku$.schema_obj.name IN ('BIG','EMP'))
//   FILE_NAME 있는 행  : FILE_TYPE 0 = 실제 덤프 파일(USER_FILE_NAME, USER_DIRECTORY), 1 = %U 템플릿
//   impdp: 마스터에 덤프를 만든 export의 메타 행(-59, -1 작업 행 등)이 같이 실려 있다. import 자신의 파라미터는 더 작은 번호(-60)이고
//          -1 작업 행은 export 작업 것이라 이름이 다르다. REMAP_SCHEMA는 NAME='REMAP_SCHEMA', OLD_VALUE=원본, VALUE_T=대상.
// 조회는 process_order < 0 인 메타 행만 (process_order 인덱스 RANGE SCAN — 오브젝트 행은 훑지 않음).

export interface MasterRow {
  PROCESS_ORDER: number;
  NAME: string | null;
  VALUE_T: string | null;
  OLD_VALUE?: string | null;
  FILE_TYPE: number | null;
  FILE_NAME: string | null;
  USER_FILE_NAME: string | null;
  USER_DIRECTORY: string | null;
  OPERATION: string | null;
  JOB_MODE: string | null;
  USER_NAME: string | null;
  START_TIME: string | null;
}

export interface MasterInfo {
  operation: string | null;
  jobMode: string | null;
  userName: string | null; // 작업을 만든 DB 계정
  startedAt: string | null; // 'YYYY-MM-DD HH24:MI:SS'
  logDirectory: string | null;
  logFile: string | null; // null = NOLOGFILE 이거나 못 찾음
  dumpDirectory: string | null;
  dumpFiles: string[];
  target: string; // 이력의 "대상" 칸용 요약
  expected: string[] | null; // 대조용 대상 (TABLE 모드 OWNER.TABLE). 모르면 null
  clientCommand: string | null;
  remap: { from: string; to: string }[]; // import의 REMAP_SCHEMA
}

const listOf = (text: string): string[] => [...text.matchAll(/'([^']*)'/g)].map((match) => match[1]);

function parseMasterRows(rows: MasterRow[], jobName: string | null = null): MasterInfo {
  const jobRow = rows.find((row) => row.PROCESS_ORDER === -1) ?? null;
  // -1 작업 행이 이 작업이 아니면 덤프를 만든 export의 행 — 이 작업은 그 덤프를 가져오는 import
  const isImport = jobName !== null && jobRow !== null && jobRow.NAME !== jobName;
  const job = isImport ? null : jobRow;
  // 같은 이름의 파라미터가 여럿이면(import 자신 + 덤프의 export) 번호가 가장 작은 것이 이 작업 것
  const param = (name: string): string | null =>
    rows.filter((row) => row.NAME === name && row.PROCESS_ORDER !== -1).sort((a, b) => a.PROCESS_ORDER - b.PROCESS_ORDER)[0]?.VALUE_T ?? null;
  const remap = rows.filter((row) => row.NAME === 'REMAP_SCHEMA' && row.OLD_VALUE && row.VALUE_T).map((row) => ({ from: String(row.OLD_VALUE), to: String(row.VALUE_T) }));
  const files = rows.filter((row) => row.FILE_NAME && row.FILE_TYPE === 0);
  const templates = rows.filter((row) => row.FILE_NAME && row.FILE_TYPE === 1);
  const dumpRows = files.length > 0 ? files : templates;
  const fileOf = (row: MasterRow) => row.USER_FILE_NAME ?? String(row.FILE_NAME).split(/[\\/]/).pop() ?? '';

  const schemas = param('SCHEMA_LIST') ? listOf(String(param('SCHEMA_LIST'))) : [];
  const custom = param('CUSTOM_FILTER');
  const tables: string[] = [];
  if (custom) {
    for (const match of custom.matchAll(/owner_name\s*=\s*'([^']+)'\s+AND\s+ku\$\.schema_obj\.name\s+IN\s*\(([^)]*)\)/gi)) {
      for (const name of listOf(match[2])) tables.push(`${match[1]}.${name}`);
    }
  }
  const mode = job?.JOB_MODE ?? null;
  const remapText = remap.map((pair) => ` / REMAP_SCHEMA ${pair.from}→${pair.to}`).join('');
  const target = isImport
    ? `덤프 ${[...new Set(dumpRows.map(fileOf))].join(', ')} (export ${jobRow?.NAME ?? '?'}의 ${jobRow?.JOB_MODE ?? '?'} 덤프)${remapText}`
    : mode === 'FULL'
      ? '전체 (FULL)'
      : tables.length > 0
        ? `테이블 ${tables.length}개: ${tables.slice(0, 10).join(', ')}${tables.length > 10 ? ' …' : ''}`
        : schemas.length > 0
          ? `SCHEMAS=${schemas.join(',')}`
          : (param('SCHEMA_EXPR') ?? '알 수 없음');

  return {
    operation: isImport ? 'IMPORT' : (job?.OPERATION ?? null),
    jobMode: isImport ? (jobRow?.JOB_MODE ?? null) : mode,
    userName: job?.USER_NAME ?? null,
    startedAt: job?.START_TIME ?? null,
    logDirectory: param('LOG_FILE_DIRECTORY'),
    logFile: param('LOG_FILE_NAME'),
    dumpDirectory: dumpRows[0]?.USER_DIRECTORY ?? null,
    dumpFiles: [...new Set(dumpRows.map(fileOf).filter(Boolean))],
    target: `[외부 실행] ${target}`,
    expected: job?.OPERATION === 'EXPORT' && tables.length > 0 ? tables : null,
    clientCommand: param('CLIENT_COMMAND'),
    remap,
  };
}

export { parseMasterRows };

export interface Runner {
  username: string | null;
  osuser: string | null;
  machine: string | null;
  program: string | null;
}

// 누가 돌렸는지: expdp/impdp 클라이언트가 붙은 세션(DBMS_DATAPUMP)이 있으면 그것, 없으면(분리된 작업) 마스터 세션.
function runnerOf(sessions: { sessionType: string; username: string | null; osuser: string | null; machine: string | null; program: string | null }[]): Runner | null {
  const pick = sessions.find((s) => s.sessionType === 'DBMS_DATAPUMP') ?? sessions.find((s) => s.sessionType === 'MASTER') ?? sessions[0];
  return pick ? { username: pick.username, osuser: pick.osuser, machine: pick.machine, program: pick.program } : null;
}

export { runnerOf };
