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
  ScriptFormPayload,
  ScriptListResponse,
  StatsJobRow,
  TableSpecSchemas,
  TestConnectionResult,
  ThresholdFormPayload,
  ThresholdListResponse,
  UserAddPayload,
  UserBasic,
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

export function getSourceDiff(source: CompareSide, target: CompareSide, type: string, name: string): Promise<SourceDiffLine[]> {
  return postJson('/api/objectCompare/sourceDiff', { source, target, type, name });
}

// ── Parameter Compare ────────────────────────────────────────────────────────
export function runParameterCompare(sourceDbmsId: string | number, targetDbmsId: string | number): Promise<ParameterCompareResponse> {
  return postJson('/api/parameterCompare/run', { sourceDbmsId, targetDbmsId });
}
