import oracledb from 'oracledb';
import * as db from '../db';

export type IssueStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface IssueRow {
  id: number;
  dbmsId: number;
  dbname: string;
  taskId: number;
  taskName: string;
  columnName: string;
  clevel: string;
  message: string | null;
  value: string | null;
  occurrenceCount: number;
  details: Record<string, any>[];
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

const ISSUE_COLUMNS = `id, dbms_id, dbname, task_id, task_name, column_name, clevel, message, value,
                        occurrence_count, details, status, assignee, first_seen_at, last_seen_at,
                        acknowledged_at, acknowledged_by, resolved_at, resolved_by, reopen_count,
                        latest_run_history_id, created_at, updated_at`;

function mapIssueRow(row: Record<string, any>): IssueRow {
  let details: Record<string, any>[] = [];
  try {
    details = row.DETAILS ? JSON.parse(row.DETAILS) : [];
  } catch {
    details = [];
  }
  return {
    id: row.ID,
    dbmsId: row.DBMS_ID,
    dbname: row.DBNAME,
    taskId: row.TASK_ID,
    taskName: row.TASK_NAME,
    columnName: row.COLUMN_NAME,
    clevel: row.CLEVEL,
    message: row.MESSAGE,
    value: row.VALUE,
    occurrenceCount: row.OCCURRENCE_COUNT,
    details,
    status: row.STATUS,
    assignee: row.ASSIGNEE,
    firstSeenAt: row.FIRST_SEEN_AT,
    lastSeenAt: row.LAST_SEEN_AT,
    acknowledgedAt: row.ACKNOWLEDGED_AT,
    acknowledgedBy: row.ACKNOWLEDGED_BY,
    resolvedAt: row.RESOLVED_AT,
    resolvedBy: row.RESOLVED_BY,
    reopenCount: row.REOPEN_COUNT,
    latestRunHistoryId: row.LATEST_RUN_HISTORY_ID,
    createdAt: row.CREATED_AT,
    updatedAt: row.UPDATED_AT,
  };
}

function mapComment(row: Record<string, any>): IssueComment {
  return {
    id: row.ID,
    issueId: row.ISSUE_ID,
    commentType: row.COMMENT_TYPE,
    author: row.AUTHOR,
    commentText: row.COMMENT_TEXT,
    createdAt: row.CREATED_AT,
  };
}

// 티켓에 "system" 또는 사용자 이름으로 댓글 한 건을 남깁니다.
// (상태 변경 시 자동으로 STATUS_CHANGE 댓글을 남겨 감사 이력을 겸합니다.)
async function insertComment(
  connection: oracledb.Connection,
  issueId: number,
  commentType: 'COMMENT' | 'STATUS_CHANGE',
  author: string | null,
  text: string
): Promise<void> {
  const maxRes = await connection.execute<any[]>('select nvl(max(id),0)+1 as nextid from system.monitoring_issue_comments');
  const nextId = maxRes.rows?.[0][0];
  await connection.execute(
    `insert into system.monitoring_issue_comments (id, issue_id, comment_type, author, comment_text, created_at)
     values (:id, :issueId, :commentType, :author, :commentText, TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'))`,
    { id: nextId, issueId, commentType, author, commentText: text },
    { autoCommit: true }
  );
}

interface AlertGroup {
  taskId: number;
  taskName: string;
  column: string;
  level: string;
  message: string;
  rows: Record<string, any>[];
}

// 이번 실행 결과(_alerts가 붙은 rows)에서 (task_id, column) 단위로 위반 행을 묶습니다.
// 같은 컬럼을 위반한 행이 여러 개(예: 여러 테이블스페이스가 동시에 초과)여도
// 하나의 그룹으로 묶어 티켓 하나에 occurrence_count/details로 담습니다.
function collectAlertGroups(results: Record<string, any>[]): Map<string, AlertGroup> {
  const groups = new Map<string, AlertGroup>();
  for (const task of results) {
    if (!task.success) continue;
    for (const dataRow of task.rows ?? []) {
      const alerts = dataRow._alerts;
      if (!alerts) continue;
      for (const column of Object.keys(alerts)) {
        const alert = alerts[column];
        if (alert.level === 'INFO') continue;

        const key = `${task.task_id}:${column}`;
        let group = groups.get(key);
        if (!group) {
          group = { taskId: task.task_id, taskName: task.task_name, column, level: alert.level, message: alert.message, rows: [] };
          groups.set(key, group);
        }
        const { _alerts, ...rest } = dataRow;
        group.rows.push(rest);
        group.level = alert.level;
        group.message = alert.message;
      }
    }
  }
  return groups;
}

// 이번 실행에서 감지된 위반사항을 monitoring_issues와 동기화합니다.
// - 새 위반 -> OPEN 티켓 생성
// - RESOLVED였던 티켓이 재발 -> 같은 행을 OPEN으로 재오픈(reopen_count 증가)
// - 이미 OPEN/ACKNOWLEDGED인 티켓 -> 최신 값만 갱신(상태/담당자는 유지)
// - 더 이상 감지되지 않는 OPEN/ACKNOWLEDGED 티켓 -> 자동 RESOLVED
// 점검 응답에 영향을 주면 안 되므로, 실패는 호출하는 쪽(dbmsService)에서 흡수합니다.
async function syncIssues(
  dbmsId: number | string,
  dbname: string,
  runHistoryId: number | null,
  results: Record<string, any>[]
): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const groups = collectAlertGroups(results);

    const existingRes = await connection.execute<Record<string, any>>(
      `select id, task_id, column_name, status
         from system.monitoring_issues
        where dbms_id = :dbmsId`,
      { dbmsId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const existingByKey = new Map<string, { id: number; status: string }>();
    for (const row of existingRes.rows ?? []) {
      existingByKey.set(`${row.TASK_ID}:${row.COLUMN_NAME}`, { id: row.ID, status: row.STATUS });
    }

    for (const [key, group] of groups) {
      const existing = existingByKey.get(key);
      const rawValue = group.rows[0]?.[group.column];
      const value = rawValue === undefined || rawValue === null ? null : String(rawValue);
      const details = JSON.stringify(group.rows);

      if (!existing) {
        const maxRes = await connection.execute<any[]>('select nvl(max(id),0)+1 as nextid from system.monitoring_issues');
        const nextId = maxRes.rows?.[0][0];
        await connection.execute(
          `insert into system.monitoring_issues
             (id, dbms_id, dbname, task_id, task_name, column_name, clevel, message, value,
              occurrence_count, details, status, first_seen_at, last_seen_at, latest_run_history_id,
              created_at, updated_at)
           values
             (:id, :dbmsId, :dbname, :taskId, :taskName, :columnName, :clevel, :message, :value,
              :occurrenceCount, :details, 'OPEN', TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'), TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'),
              :runHistoryId, TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'), TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'))`,
          {
            id: nextId,
            dbmsId,
            dbname,
            taskId: group.taskId,
            taskName: group.taskName,
            columnName: group.column,
            clevel: group.level,
            message: group.message,
            value,
            occurrenceCount: group.rows.length,
            details,
            runHistoryId,
          },
          { autoCommit: true }
        );
        continue;
      }

      if (existing.status === 'RESOLVED') {
        await connection.execute(
          `update system.monitoring_issues
              set status = 'OPEN', reopen_count = reopen_count + 1,
                  resolved_at = NULL, resolved_by = NULL,
                  clevel = :clevel, message = :message, value = :value,
                  occurrence_count = :occurrenceCount, details = :details,
                  last_seen_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'),
                  updated_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'),
                  latest_run_history_id = :runHistoryId
            where id = :id`,
          {
            id: existing.id,
            clevel: group.level,
            message: group.message,
            value,
            occurrenceCount: group.rows.length,
            details,
            runHistoryId,
          },
          { autoCommit: true }
        );
        await insertComment(connection, existing.id, 'STATUS_CHANGE', 'system', '자동 재오픈: 조건이 다시 감지되었습니다.');
        continue;
      }

      // OPEN 또는 ACKNOWLEDGED — 상태/담당자는 유지하고 최신 감지 정보만 갱신
      await connection.execute(
        `update system.monitoring_issues
            set clevel = :clevel, message = :message, value = :value,
                occurrence_count = :occurrenceCount, details = :details,
                last_seen_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'),
                updated_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'),
                latest_run_history_id = :runHistoryId
          where id = :id`,
        {
          id: existing.id,
          clevel: group.level,
          message: group.message,
          value,
          occurrenceCount: group.rows.length,
          details,
          runHistoryId,
        },
        { autoCommit: true }
      );
    }

    // 이번 실행에 더 이상 나타나지 않는, 아직 열려있는 티켓은 자동 해제
    for (const [key, existing] of existingByKey) {
      if (groups.has(key)) continue;
      if (existing.status === 'RESOLVED') continue;
      await connection.execute(
        `update system.monitoring_issues
            set status = 'RESOLVED', resolved_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'), resolved_by = 'auto',
                updated_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS')
          where id = :id`,
        { id: existing.id },
        { autoCommit: true }
      );
      await insertComment(connection, existing.id, 'STATUS_CHANGE', 'system', '자동 해제: 조건이 더 이상 감지되지 않습니다.');
    }
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function listIssues(statuses?: IssueStatus[]): Promise<IssueRow[]> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    let where = '';
    const binds: Record<string, any> = {};
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map((_, i) => `:status${i}`).join(', ');
      where = `where status in (${placeholders})`;
      statuses.forEach((s, i) => {
        binds[`status${i}`] = s;
      });
    }

    const query = `select ${ISSUE_COLUMNS}
                     from system.monitoring_issues
                    ${where}
                    order by case clevel when 'ERROR' then 0 else 1 end, last_seen_at desc`;
    const result = await connection.execute<Record<string, any>>(query, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchInfo: { DETAILS: { type: oracledb.STRING } },
    });
    return (result.rows ?? []).map(mapIssueRow);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function getIssueDetail(id: number | string): Promise<IssueDetail | null> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();

    const issueRes = await connection.execute<Record<string, any>>(
      `select ${ISSUE_COLUMNS} from system.monitoring_issues where id = :id`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchInfo: { DETAILS: { type: oracledb.STRING } } }
    );
    const row = issueRes.rows?.[0];
    if (!row) return null;

    const commentsRes = await connection.execute<Record<string, any>>(
      `select id, issue_id, comment_type, author, comment_text, created_at
         from system.monitoring_issue_comments
        where issue_id = :id
        order by created_at asc, id asc`,
      { id },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const comments = (commentsRes.rows ?? []).map(mapComment);

    return { ...mapIssueRow(row), comments };
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function acknowledgeIssue(id: number | string, assignee?: string): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    await connection.execute(
      `update system.monitoring_issues
          set status = 'ACKNOWLEDGED', acknowledged_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'),
              acknowledged_by = :assignee, assignee = nvl(:assignee, assignee),
              updated_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS')
        where id = :id`,
      { id, assignee: assignee ?? null },
      { autoCommit: true }
    );
    await insertComment(
      connection,
      Number(id),
      'STATUS_CHANGE',
      assignee || 'system',
      `상태 변경: 확인함(ACKNOWLEDGED)${assignee ? ` (담당자: ${assignee})` : ''}`
    );
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function resolveIssue(id: number | string, resolvedBy?: string): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    await connection.execute(
      `update system.monitoring_issues
          set status = 'RESOLVED', resolved_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS'),
              resolved_by = :resolvedBy, updated_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS')
        where id = :id`,
      { id, resolvedBy: resolvedBy ?? null },
      { autoCommit: true }
    );
    await insertComment(
      connection,
      Number(id),
      'STATUS_CHANGE',
      resolvedBy || 'system',
      `상태 변경: 해결됨(RESOLVED)${resolvedBy ? ` (처리자: ${resolvedBy})` : ''}`
    );
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function reopenIssue(id: number | string, reopenedBy?: string): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    await connection.execute(
      `update system.monitoring_issues
          set status = 'OPEN', reopen_count = reopen_count + 1,
              resolved_at = NULL, resolved_by = NULL,
              acknowledged_at = NULL, acknowledged_by = NULL,
              updated_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS')
        where id = :id`,
      { id },
      { autoCommit: true }
    );
    await insertComment(
      connection,
      Number(id),
      'STATUS_CHANGE',
      reopenedBy || 'system',
      `상태 변경: 재오픈(OPEN)${reopenedBy ? ` (처리자: ${reopenedBy})` : ''}`
    );
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function assignIssue(id: number | string, assignee: string): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    await connection.execute(
      `update system.monitoring_issues
          set assignee = :assignee, updated_at = TO_CHAR(SYSDATE,'YYYYMMDDHH24MISS')
        where id = :id`,
      { id, assignee },
      { autoCommit: true }
    );
    await insertComment(connection, Number(id), 'STATUS_CHANGE', assignee || 'system', `담당자 지정: ${assignee}`);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

async function addComment(issueId: number | string, author: string | undefined, text: string): Promise<void> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    await insertComment(connection, Number(issueId), 'COMMENT', author ?? null, text);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

export { syncIssues, listIssues, getIssueDetail, acknowledgeIssue, resolveIssue, reopenIssue, assignIssue, addComment };
