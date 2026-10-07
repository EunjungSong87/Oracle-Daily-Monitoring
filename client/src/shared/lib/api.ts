import type {
  CurrentUser,
  DbmsFormPayload,
  DbmsListResponse,
  IlmRetentionAddPayload,
  IlmRetentionRow,
  IlmRetentionUpdatePayload,
  CompareResponse,
  CompareSide,
  AshTimeRange,
  SessionDetailResult,
  ParameterCompareResponse,
  DataPumpHistory,
  DataPumpJob,
  DataPumpLog,
  DataPumpMeta,
  DataPumpRequest,
  ExportPlanResponse,
  ExportSplitOptions,
  ParfilePreview,
  PartitionImportOptions,
  PartitionImportPlan,
  PartitionManifest,
  PartitionRange,
  PartitionTableInfo,
  SourceDiffLine,
  IssueDetail,
  IssueRow,
  IssueStatus,
  JobActionResult,
  MonitoringTaskResult,
  RealtimeSnapshot,
  RunHistoryDetail,
  RunHistorySummary,
  ScheduleConfig,
  ScreenKey,
  SecurityListResponse,
  SecuritySelection,
  ScriptFormPayload,
  ScriptListResponse,
  StatsJobRow,
  TableSpecSchemas,
  TestConnectionResult,
  ThresholdFormPayload,
  ThresholdListResponse,
  UserAddPayload,
  UserBasic,
  UserScreenSetting,
  UserSummary,
  UserUpdatePayload,
} from './types';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}) as { message?: string });
    throw new Error(err.message || `POST ${url} failed: ${response.status}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function getCurrentUser(): Promise<CurrentUser | null> {
  return fetch('/auth/me')
    .then((response) => (response.ok ? (response.json() as Promise<CurrentUser>) : null))
    .catch((error) => {
      console.error('로그인 사용자 정보 조회 실패:', error);
      return null;
    });
}

export async function logout(): Promise<void> {
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch (error) {
    console.error('로그아웃 실패:', error);
  }
}

export function getDbmsList(): Promise<DbmsListResponse> {
  return getJson<DbmsListResponse>('/api/dbmslist');
}

export async function runMonResult(dbmsid: string | number): Promise<MonitoringTaskResult[]> {
  const response = await fetch('/api/dbmslist/monResult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dbmsid }),
  });
  if (!response.ok) {
    throw new Error(`monResult failed: ${response.status}`);
  }
  return (await response.json()) as MonitoringTaskResult[];
}

export function getScheduleConfig(): Promise<ScheduleConfig> {
  return getJson<ScheduleConfig>('/api/schedule');
}

export async function saveScheduleConfig(
  config: ScheduleConfig & { dbmsIds: string[] }
): Promise<void> {
  const response = await fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(`schedule save failed: ${response.status}`);
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export async function login(username: string, password: string): Promise<CurrentUser> {
  return postJson<CurrentUser>('/auth/login', { username, password });
}

// ── Databases (CRUD) ─────────────────────────────────────────────────────────
export function addDbms(payload: DbmsFormPayload): Promise<unknown> {
  return postJson('/api/addDbms', payload);
}

export function modifyDbms(payload: DbmsFormPayload): Promise<unknown> {
  return postJson('/api/modifyDbms', payload);
}

export function deleteDbms(dbmsId: string | number): Promise<unknown> {
  return postJson('/api/deleteDbms', { dbmsId });
}

export function testDbmsConnection(
  payload: Pick<DbmsFormPayload, 'username' | 'password' | 'sid' | 'ip' | 'port'> & { id?: string | number }
): Promise<TestConnectionResult> {
  return postJson('/api/testDbmsConnection', payload);
}

// ── Scripts (monitoring tasks) ───────────────────────────────────────────────
export function getScriptList(): Promise<ScriptListResponse> {
  return getJson('/api/scriptlist');
}

export async function getSqlText(id: string | number, name: string): Promise<string> {
  const result = await postJson<{ message: string; scriptconfig: string }>('/api/getSqlText', { id, name });
  return result.scriptconfig;
}

export function addScript(payload: ScriptFormPayload): Promise<unknown> {
  return postJson('/api/addScript', payload);
}

export function modifyScript(payload: ScriptFormPayload): Promise<unknown> {
  return postJson('/api/modifyScript', payload);
}

export function deleteScript(scriptId: string | number): Promise<unknown> {
  return postJson('/api/deleteScript', { scriptId });
}

// ── Thresholds ───────────────────────────────────────────────────────────────
export function getThresholdList(): Promise<ThresholdListResponse> {
  return getJson('/api/thresholdlist');
}

export function addThreshold(payload: ThresholdFormPayload): Promise<unknown> {
  return postJson('/api/addThreshold', payload);
}

export function modifyThreshold(payload: ThresholdFormPayload): Promise<unknown> {
  return postJson('/api/modifyThreshold', payload);
}

export function deleteThreshold(thresholdId: string | number): Promise<unknown> {
  return postJson('/api/deleteThreshold', { thresholdId });
}

// ── Users ────────────────────────────────────────────────────────────────────
export function listUsers(): Promise<UserSummary[]> {
  return getJson('/api/users');
}

export function getUsersBasic(): Promise<UserBasic[]> {
  return getJson('/api/users/basic');
}

export function addUser(payload: UserAddPayload): Promise<unknown> {
  return postJson('/api/users/add', payload);
}

export function updateUser(payload: UserUpdatePayload): Promise<unknown> {
  return postJson('/api/users/update', payload);
}

export function getUserScreens(id: number): Promise<{ available: boolean; screens: UserScreenSetting[] }> {
  return postJson('/api/users/screens', { id });
}

// screens: 화면키 → true(보이게) / false(숨김) / null(역할 기본값)
export function saveUserScreens(id: number, screens: Partial<Record<ScreenKey, boolean | null>>): Promise<unknown> {
  return postJson('/api/users/screens/save', { id, screens });
}

// ── Issues ───────────────────────────────────────────────────────────────────
export function listIssues(status: string): Promise<IssueRow[]> {
  return getJson(`/api/issues?status=${encodeURIComponent(status)}`);
}

export function getIssueDetail(id: number): Promise<IssueDetail> {
  return postJson('/api/issues/detail', { id });
}

export function acknowledgeIssue(id: number): Promise<unknown> {
  return postJson('/api/issues/acknowledge', { id });
}

export function resolveIssue(id: number): Promise<unknown> {
  return postJson('/api/issues/resolve', { id });
}

export function reopenIssue(id: number): Promise<unknown> {
  return postJson('/api/issues/reopen', { id });
}

export function assignIssue(id: number, assignee: string): Promise<unknown> {
  return postJson('/api/issues/assign', { id, assignee });
}

export function addIssueComment(issueId: number, text: string): Promise<unknown> {
  return postJson('/api/issues/comment', { issueId, text });
}

export type { IssueStatus };

// ── History ──────────────────────────────────────────────────────────────────
export function getRunHistoryList(
  dbmsid: string | number,
  fromDate?: string,
  toDate?: string
): Promise<RunHistorySummary[]> {
  return postJson('/api/history/list', { dbmsid: Number(dbmsid), fromDate, toDate });
}

export function getRunHistoryDetail(id: number): Promise<RunHistoryDetail> {
  return postJson('/api/history/detail', { id });
}

// ── Table Spec ───────────────────────────────────────────────────────────────
export function getSchemas(dbmsid: string | number): Promise<string[]> {
  return postJson('/api/tableSpec/schemas', { dbmsid });
}

export function getTables(dbmsid: string | number, owner: string): Promise<string[]> {
  return postJson('/api/tableSpec/tables', { dbmsid, owner });
}

export async function downloadTableSpec(
  dbmsid: string | number,
  schemas: TableSpecSchemas,
  tablesPerSheet: number
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch('/api/tableSpec/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dbmsid, schemas, tablesPerSheet }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}) as { message?: string });
    throw new Error(err.message || `요청 실패: ${response.status}`);
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match ? match[1] : 'table_spec.xlsx';
  const blob = await response.blob();
  return { blob, filename };
}

// ── Realtime ─────────────────────────────────────────────────────────────────
// since(DB 시각)를 주면 그 이후에 ASH에서 갱신된 SQL 실행만, 안 주면 최근 10분치를 함께 돌려준다.
export function pollSessions(dbmsid: string | number, since: string | null = null): Promise<RealtimeSnapshot> {
  return postJson('/api/realtime/sessions', { dbmsid, since });
}

// range를 주면 그 기간의 ASH만 보고, 안 주면(세션 목록 더블클릭) 서버가 최근 10분을 본다.
export function getRealtimeSessionDetail(
  dbmsid: string | number,
  target: { sid: number; serial: number | null; sqlId?: string | null; range?: AshTimeRange | null }
): Promise<SessionDetailResult> {
  return postJson('/api/realtime/sessionDetail', {
    dbmsid,
    sid: target.sid,
    serial: target.serial,
    sqlId: target.sqlId ?? null,
    from: target.range?.from,
    to: target.range?.to,
  });
}

// ── Stats Job ────────────────────────────────────────────────────────────────
export function getStatsJobStatus(dbmsid: string | number): Promise<StatsJobRow[]> {
  return postJson('/api/statsJob/status', { dbmsid });
}

export function runStatsJob(dbmsid: string | number, jobName: string): Promise<JobActionResult> {
  return postJson('/api/statsJob/run', { dbmsid, jobName });
}

// ── ILM Partition Retention ──────────────────────────────────────────────────
export function getIlmRetentionList(dbmsid: string | number): Promise<IlmRetentionRow[]> {
  return postJson('/api/ilmJob/list', { dbmsid });
}

export function addIlmRetention(payload: IlmRetentionAddPayload): Promise<JobActionResult> {
  return postJson('/api/ilmJob/add', payload);
}

export function updateIlmRetention(payload: IlmRetentionUpdatePayload): Promise<JobActionResult> {
  return postJson('/api/ilmJob/update', payload);
}

// ── Object Compare ───────────────────────────────────────────────────────────
export function getCompareSchemas(dbmsid: string | number): Promise<string[]> {
  return postJson('/api/objectCompare/schemas', { dbmsid });
}

export function runObjectCompare(
  source: CompareSide,
  target: CompareSide,
  types: string[],
  ignoreTablespace: boolean
): Promise<CompareResponse> {
  return postJson('/api/objectCompare/run', { source, target, types, ignoreTablespace });
}

export function getSecurityLists(sourceDbmsId: string | number, targetDbmsId: string | number): Promise<SecurityListResponse> {
  return postJson('/api/objectCompare/security/lists', { source: { dbmsid: sourceDbmsId }, target: { dbmsid: targetDbmsId } });
}

// 계정·권한 비교 — 결과 형식은 오브젝트 비교와 같다 (schema는 빈 값).
export function runSecurityCompare(
  sourceDbmsId: string | number,
  targetDbmsId: string | number,
  selection: SecuritySelection
): Promise<CompareResponse> {
  return postJson('/api/objectCompare/security/run', { source: { dbmsid: sourceDbmsId }, target: { dbmsid: targetDbmsId }, selection });
}

export function getSourceDiff(source: CompareSide, target: CompareSide, type: string, name: string): Promise<SourceDiffLine[]> {
  return postJson('/api/objectCompare/sourceDiff', { source, target, type, name });
}

// ── Parameter Compare ────────────────────────────────────────────────────────
export function runParameterCompare(sourceDbmsId: string | number, targetDbmsId: string | number): Promise<ParameterCompareResponse> {
  return postJson('/api/parameterCompare/run', { sourceDbmsId, targetDbmsId });
}

// ── Data Pump ────────────────────────────────────────────────────────────────
export function getDataPumpMeta(dbmsid: string | number): Promise<DataPumpMeta> {
  return postJson('/api/dataPump/meta', { dbmsid });
}

// 스키마(schemas) 또는 "OWNER.TABLE" 목록 텍스트(tableList) 중 하나로 분할 계획을 만든다.
// 스키마의 뷰 목록 (VIEWS_AS_TABLES, networkLink면 링크 너머)
export async function getDataPumpViews(dbmsid: string | number, owner: string, networkLink: string | null = null): Promise<string[]> {
  const { views } = await postJson<{ views: string[] }>('/api/dataPump/views', { dbmsid, owner, networkLink });
  return views;
}

export async function getDataPumpLinkSchemas(dbmsid: string | number, networkLink: string): Promise<string[]> {
  const { schemas } = await postJson<{ schemas: string[] }>('/api/dataPump/linkSchemas', { dbmsid, networkLink });
  return schemas;
}

export function planDataPumpExport(
  dbmsid: string | number,
  source: { schemas?: string[]; tableList?: string; partitionSource?: { owner: string; table: string; partitions: string[] }; refreshSizes?: boolean },
  options: ExportSplitOptions
): Promise<ExportPlanResponse> {
  return postJson('/api/dataPump/exportPlan', { dbmsid, ...source, options });
}

// networkLink가 있으면 링크 너머(데이터를 읽는) DB의 SCN
export async function getDataPumpScn(dbmsid: string | number, networkLink: string | null = null): Promise<string> {
  const { scn } = await postJson<{ scn: string }>('/api/dataPump/currentScn', { dbmsid, networkLink });
  return scn;
}

export function previewDataPump(dbmsid: string | number, request: DataPumpRequest): Promise<ParfilePreview> {
  return postJson('/api/dataPump/preview', { dbmsid, request });
}

// estimatedBytes: 분할 계획의 예상 크기 — 이력에 같이 남겨 둔다.
export function startDataPump(
  dbmsid: string | number,
  request: DataPumpRequest,
  confirmDbname?: string,
  estimatedBytes?: number
): Promise<{ jobName: string; jobNames?: string[] }> {
  return postJson('/api/dataPump/start', { dbmsid, request, confirmDbname, estimatedBytes });
}

export function getDataPumpHistory(dbmsid: string | number): Promise<DataPumpHistory> {
  return postJson('/api/dataPump/history', { dbmsid });
}

export function getDataPumpJobs(dbmsid: string | number): Promise<DataPumpJob[]> {
  return postJson('/api/dataPump/jobs', { dbmsid });
}

export function cancelDataPumpJob(dbmsid: string | number, owner: string, jobName: string): Promise<unknown> {
  return postJson('/api/dataPump/cancel', { dbmsid, owner, jobName });
}

export function readDataPumpLog(dbmsid: string | number, directory: string, logfile: string): Promise<DataPumpLog> {
  return postJson('/api/dataPump/log', { dbmsid, directory, logfile });
}

// parfile/실행 스크립트를 DB 서버 DIRECTORY에 저장. overwrite가 아니면 이미 있는 파일은 skipped로 돌아온다.
export function saveDataPumpFiles(
  dbmsid: string | number,
  directory: string,
  files: { name: string; content: string }[],
  overwrite: boolean
): Promise<{ written: string[]; skipped: string[] }> {
  return postJson('/api/dataPump/saveFiles', { dbmsid, directory, files, overwrite });
}

// ── Data Pump: Range 파티션 단위 export/import ──

export async function getPartitionTables(dbmsid: string | number, owner: string): Promise<PartitionTableInfo[]> {
  const { tables } = await postJson<{ tables: PartitionTableInfo[] }>('/api/dataPump/partition/tables', { dbmsid, owner });
  return tables;
}

export function getPartitionList(dbmsid: string | number, owner: string, table: string): Promise<{ table: PartitionTableInfo; partitions: PartitionRange[] }> {
  return postJson('/api/dataPump/partition/list', { dbmsid, owner, table });
}

// DB 서버 DIRECTORY에 있는 매니페스트(.json) 읽기
export function readPartitionManifest(dbmsid: string | number, directory: string, file: string): Promise<{ manifest: PartitionManifest; text: string }> {
  return postJson('/api/dataPump/partition/manifest', { dbmsid, directory, file });
}

// manifest: 매니페스트 원문(JSON 텍스트)
export function planPartitionImport(
  dbmsid: string | number,
  manifest: string,
  partitions: string[],
  options: PartitionImportOptions
): Promise<PartitionImportPlan> {
  return postJson('/api/dataPump/partition/importPlan', { dbmsid, manifest, partitions, options });
}
