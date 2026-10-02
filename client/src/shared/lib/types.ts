// 백엔드 응답 형태 (models/dbmsModel.ts의 QueryResult/ScheduleConfig, controllers/authController.ts의 /auth/me와 일치).

export type Role = 'VIEWER' | 'DBA' | 'SUPER_ADMIN';

export interface CurrentUser {
  username: string;
  role: Role;
}

// GET /api/dbmslist 한 행 — 실제 컬럼은 ID, DBNAME, USERNAME, SID, IP, PORT, MEMO,
// CREATETIME, UPDATETIME, AUTO_SCHEDULE (system.monitoring_dbms_list 기준)이지만,
// 화면은 서버가 내려준 columns 순서대로 그대로 렌더링하므로 값 타입만 느슨하게 둔다.
export type DbmsRow = Record<string, unknown> & {
  ID: string | number;
  DBNAME: string;
  SID: string;
  IP: string;
  MEMO?: string;
  AUTO_SCHEDULE?: string;
};

export interface DbmsListResponse {
  columns: string[];
  rows: DbmsRow[];
}

export interface CellAlert {
  level: string;
  message?: string;
}

export type MonitoringResultRow = Record<string, unknown> & {
  _alerts?: Record<string, CellAlert>;
};

export interface MonitoringTaskResult {
  task_name: string;
  success: boolean;
  error?: string;
  columns: string[];
  rows: MonitoringResultRow[];
}

export interface ScheduleConfig {
  enabled: string; // 'Y' | 'N'
  runTime: string; // 'HH:MM'
}

// RUN/Download 버튼이 체크된 행에서 뽑아내는 요약 정보.
export interface DbConfig {
  id: string;
  dbname: string;
  sid: string;
  ip: string;
  memo: string;
}

// ── Databases (add/modify/testConnection) ──────────────────────────────────
export interface DbmsFormPayload {
  id?: string | number;
  dbname: string;
  username: string;
  password?: string;
  sid: string;
  ip: string;
  port: string;
  memo?: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
}

// ── Scripts (monitoring_tasks) ──────────────────────────────────────────────
export type ScriptRow = Record<string, unknown> & {
  ID: string | number;
  NAME: string;
  CATEGORY?: string;
  DESCRIPTION?: string;
  SCHEDULE?: string;
  IS_ACTIVE: string;
};

export interface ScriptListResponse {
  columns: string[];
  rows: ScriptRow[];
}

export interface ScriptFormPayload {
  id: string | number;
  name: string;
  category?: string;
  description?: string;
  sql_text: string;
  schedule?: string;
  is_active: string;
}

// ── Thresholds ───────────────────────────────────────────────────────────────
export type ThresholdRow = Record<string, unknown> & {
  ID: string | number;
  TASK_ID: string | number;
  TASK_NAME: string;
  COLUMN_NAME: string;
  CONDITION_TYPE: string;
  OPERATOR: string;
  THRESHOLD: string;
  CLEVEL: string;
  MESSAGE?: string;
  IS_ACTIVE: string;
};

export interface ThresholdListResponse {
  columns: string[];
  rows: ThresholdRow[];
}

export interface ThresholdFormPayload {
  id?: string | number;
  task_id: string | number;
  column_name: string;
  condition_type: string;
  operator: string;
  threshold: string;
  clevel: string;
  message?: string;
  is_active: string;
}

// ── Users ────────────────────────────────────────────────────────────────────
export interface UserSummary {
  id: number;
  username: string;
  displayName: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface UserBasic {
  username: string;
  displayName: string | null;
}

export interface UserAddPayload {
  username: string;
  password: string;
  displayName?: string;
  role: Role;
}

export interface UserUpdatePayload {
  id: number;
  displayName?: string;
  role: Role;
  isActive: boolean;
  newPassword?: string;
}

// ── Issues ───────────────────────────────────────────────────────────────────
export type IssueStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface IssueRow {
  id: number;
  dbmsId: string | number;
  dbname: string;
  taskId: string | number;
  taskName: string;
  columnName: string;
  clevel: string;
  message: string | null;
  value: string | null;
  occurrenceCount: number;
  details: Record<string, unknown>[];
  status: IssueStatus;
  assignee: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  reopenCount: number;
  latestRunHistoryId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  issueId: number;
  commentType: 'COMMENT' | 'STATUS_CHANGE';
  author: string | null;
  commentText: string;
  createdAt: string;
}

export interface IssueDetail extends IssueRow {
  comments: IssueComment[];
}

// ── History ──────────────────────────────────────────────────────────────────
export interface RunHistorySummary {
  id: number;
  dbmsId: string | number;
  dbname: string;
  runAt: string;
  triggerType: 'MANUAL' | 'SCHEDULED';
  successCount: number;
  failCount: number;
}

export interface RunHistoryDetail extends RunHistorySummary {
  results: MonitoringTaskResult[];
}

// ── Table Spec ───────────────────────────────────────────────────────────────
export interface TableSpecSchemas {
  [owner: string]: 'ALL' | string[];
}

// ── Realtime ─────────────────────────────────────────────────────────────────
export interface SessionRow {
  sid: number;
  serial: number;
  username: string;
  status: string;
  waitClass: string;
  event: string | null;
  sqlId: string | null;
  program: string | null;
  machine: string | null;
  logonTime: string | null;
  lastCallEt: number | null;
  sqlElapsedSec: number | null;
  sqlExecId: number | null; // 지금 돌고 있는 실행의 번호 — 산점도에서 "아직 실행 중"인 실행을 빼는 데 씀
  dbTime: string; // 조회 시점의 DB 서버 시각 'YYYY-MM-DD HH24:MI:SS'
}

// ── Realtime: ASH / AWR (/api/realtime/ashExecutions, /api/realtime/sessionDetail) ──
export interface AshTimeRange {
  from: string;
  to: string;
}

export interface AshExecution {
  sid: number;
  serial: number;
  username: string | null;
  sqlId: string | null;
  sqlExecId: number | null;
  sqlExecStart: string | null;
  samples: number;
  firstSample: string;
  lastSample: string;
  maxElapsedSec: number | null;
  topEvent: string;
  topWaitClass: string;
  program: string | null;
  module: string | null;
  machine: string | null;
}

export interface AshSummary {
  range: AshTimeRange;
  samples: number;
  firstSample: string | null;
  lastSample: string | null;
  username: string | null;
  program: string | null;
  module: string | null;
  machine: string | null;
  events: { event: string; waitClass: string; samples: number }[];
  blockingSessions: number[];
  sqlIds: string[];
  source: 'V$ACTIVE_SESSION_HISTORY' | 'DBA_HIST_ACTIVE_SESS_HISTORY';
}

export interface LiveSessionDetail {
  sid: number;
  serial: number;
  username: string | null;
  status: string;
  osuser: string | null;
  machine: string | null;
  terminal: string | null;
  program: string | null;
  module: string | null;
  action: string | null;
  clientInfo: string | null;
  serviceName: string | null;
  spid: string | null;
  logonTime: string | null;
  lastCallEt: number | null;
  state: string | null;
  event: string | null;
  waitClass: string | null;
  waitSec: number | null;
  blockingSession: number | null;
  sqlId: string | null;
  sqlChildNumber: number | null;
  sqlExecStart: string | null;
  sqlElapsedSec: number | null;
  prevSqlId: string | null;
}

export interface SqlDetail {
  sqlId: string;
  source: 'V$SQL' | 'AWR';
  planHashValue: number | null;
  parsingSchema: string | null;
  module: string | null;
  executions: number | null;
  elapsedSec: number | null;
  cpuSec: number | null;
  bufferGets: number | null;
  diskReads: number | null;
  rowsProcessed: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  sqlText: string;
}

// 권한/라이선스 문제 등으로 그 부분만 조회하지 못했을 때.
export interface Unavailable {
  unavailable: string;
}

export interface SessionDetailResult {
  session: LiveSessionDetail | null;
  ash: AshSummary | Unavailable | null;
  sql: SqlDetail | Unavailable | null;
  sqlSource: 'CURRENT' | 'REQUESTED' | 'PREVIOUS' | null;
}

export interface RealtimeSnapshot {
  timestamp: string;
  dbNow: string; // DB 서버 현재 시각 — 다음 폴링 때 since로 넘긴다
  sessions: SessionRow[];
  // ASH의 SQL 실행 목록(산점도용). ASH 권한/라이선스가 없으면 { unavailable }.
  executions: AshExecution[] | Unavailable;
}

// POST /api/statsJob/status 한 행 (DBA_SCHEDULER_JOBS + 최근 실행 이력, models/statsJobModel.ts 기준).
export type StatsJobRow = Record<string, unknown> & {
  JOB_NAME: string;
  STATE?: string | null;
  STATUS?: string | null;
  ACTUAL_START_DATE?: string | null;
};

// POST /api/ilmJob/list 한 행 (PGDBA.DEL_JOB_TABLE_LIST 기준).
export type IlmRetentionRow = Record<string, unknown> & {
  TABLE_OWNER: string;
  TABLE_NAME: string;
};

// /api/statsJob/run, /api/ilmJob/add|update 응답 — 실패도 200 + success:false로 내려온다.
export interface JobActionResult {
  success: boolean;
  message: string;
}

export interface IlmRetentionUpdatePayload {
  dbmsid: string | number;
  tableOwner: string;
  tableName: string;
  workGroup: string | null;
  deleteCycle: string | null;
  oggSyncYn: string | null;
  status: string | null;
  comments: string | null;
  memo: string | null;
}

export interface IlmRetentionAddPayload extends IlmRetentionUpdatePayload {
  stdColumn: string | null;
  rangeType: string | null;
  partitionYn: string | null;
  partitionType: string | null;
  startHighvalue: string | null;
  endHighvalue: string | null;
  stdDate: string | null;
}

// ── Object Compare (/api/objectCompare/*) ────────────────────────────────────
export type CompareResultKind = 'SAME' | 'DIFF' | 'ONLY_SOURCE' | 'ONLY_TARGET';

export interface CompareSide {
  dbmsid: string | number;
  schema: string;
}

// info=true면 참고용(예: 테이블스페이스 크기)이라 "다름" 판정에는 들어가지 않는다.
export interface CompareDiffRow {
  item: string;
  attribute: string;
  source: string | null;
  target: string | null;
  info?: boolean;
}

export interface CompareItem {
  type: string;
  name: string;
  result: CompareResultKind;
  summary: string;
  diffs: CompareDiffRow[];
  hasSourceDiff: boolean;
}

export interface CompareResponse {
  source: CompareSide & { dbname: string };
  target: CompareSide & { dbname: string };
  types: string[];
  items: CompareItem[];
}

export interface SourceDiffLine {
  op: 'same' | 'del' | 'add';
  text: string;
  sourceLine: number | null;
  targetLine: number | null;
}

// ── Parameter Compare (/api/parameterCompare/run) ────────────────────────────
export interface ParameterSideValue {
  value: string | null;
  displayValue: string | null;
  isDefault: boolean;
}

export interface ParameterItem {
  name: string;
  result: CompareResultKind;
  envSpecific: boolean;
  hidden: boolean;
  description: string | null;
  source: ParameterSideValue | null;
  target: ParameterSideValue | null;
}

export interface ParameterCompareSide {
  dbmsid: string | number;
  dbname: string;
  instance: { instanceName: string; hostName: string; version: string } | null;
  source: 'X$' | 'X_$_VIEW' | 'V$SYSTEM_PARAMETER';
  hiddenIncluded: boolean;
}

export interface ParameterCompareResponse {
  source: ParameterCompareSide;
  target: ParameterCompareSide;
  hiddenFullyCompared: boolean;
  items: ParameterItem[];
}
