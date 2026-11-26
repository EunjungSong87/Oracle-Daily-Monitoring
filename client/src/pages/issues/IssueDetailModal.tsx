import { useEffect, useState, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { canSee, isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import {
  acknowledgeIssue,
  addIssueComment,
  assignIssue,
  getIssueDetail,
  getUsersBasic,
  reopenIssue,
  resolveIssue,
  runMonResult,
} from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { IssueDetail, UserBasic } from '../../shared/lib/types';
import { failureError, failureLabel, formatDate, formatRelative, issueKind, KIND_LABELS, STATUS_LABELS } from './issuesFormat';

interface Props {
  open: boolean;
  issueId: number | null;
  onClose: () => void;
  onIssueChanged: () => void;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }): ReactElement {
  return (
    <div className="issue-modal-info-row">
      <span className="issue-modal-info-label">{label}</span>
      <span>{value === null || value === undefined || value === '' ? '-' : value}</span>
    </div>
  );
}

function modalTitle(detail: IssueDetail | null): string {
  if (!detail) return '이슈 상세';
  const kind = issueKind(detail);
  if (kind === 'CONNECT') return `${detail.dbname} — 대상 DB 접속 실패`;
  if (kind === 'EXEC') return `${detail.taskName} — 스크립트 실행 실패`;
  return `${detail.taskName} — ${detail.columnName}`;
}

// public/issues.html의 #issue-modal-overlay(renderIssueModal 등) 포팅 + 실패 티켓 표시/재점검/바로가기.
export function IssueDetailModal({ open, issueId, onClose, onIssueChanged }: Props): ReactElement {
  const { user } = useCurrentUser();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [assigneeOptions, setAssigneeOptions] = useState<UserBasic[]>([]);
  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [commentText, setCommentText] = useState('');
  const [rechecking, setRechecking] = useState(false);

  async function refresh(id: number): Promise<void> {
    try {
      const [detailResult, users] = await Promise.all([getIssueDetail(id), getUsersBasic().catch(() => [])]);
      setDetail(detailResult);
      setAssigneeOptions(users);
      setSelectedAssignee(detailResult.assignee || '');
    } catch (error) {
      console.error('이슈 상세 조회 실패:', error);
      showToast('이슈 상세 조회 실패', 'error');
    }
  }

  useEffect(() => {
    if (open && issueId != null) {
      setCommentText('');
      refresh(issueId);
    }
    if (!open) setDetail(null);
  }, [open, issueId]);

  async function runAction(action: () => Promise<unknown>, successMessage: string): Promise<void> {
    if (issueId == null) return;
    try {
      await action();
      showToast(successMessage);
      await refresh(issueId);
      onIssueChanged();
    } catch (error) {
      console.error('처리 실패:', error);
      showToast('처리 실패', 'error');
    }
  }

  function handleSaveAssignee(): void {
    if (!selectedAssignee) {
      showToast('담당자를 선택해주세요.', 'error');
      return;
    }
    runAction(() => assignIssue(issueId!, selectedAssignee), '담당자를 지정했습니다.');
  }

  // 원인을 고친 뒤 바로 확인: 그 DB를 지금 점검하면 서버가 티켓을 다시 동기화한다 (정상이면 자동 해제).
  async function handleRecheck(): Promise<void> {
    if (!detail || issueId == null) return;
    setRechecking(true);
    try {
      await runMonResult(detail.dbmsId);
      showToast(`${detail.dbname} 재점검 완료 — 티켓 상태를 갱신했습니다.`);
    } catch (error) {
      console.error('재점검 실패:', error);
      showToast(`${detail.dbname} 재점검 실패 (대상 DB 접속 실패 티켓을 확인하세요)`, 'error');
    } finally {
      setRechecking(false);
      await refresh(issueId);
      onIssueChanged();
    }
  }

  async function handleSubmitComment(): Promise<void> {
    const text = commentText.trim();
    if (!text) {
      showToast('댓글 내용을 입력해주세요.', 'error');
      return;
    }
    if (issueId == null) return;
    try {
      await addIssueComment(issueId, text);
      setCommentText('');
      await refresh(issueId);
    } catch (error) {
      console.error('댓글 등록 실패:', error);
      showToast('댓글 등록 실패', 'error');
    }
  }

  const kind = detail ? issueKind(detail) : 'THRESHOLD';
  const detailColumns = detail && detail.details.length > 0 ? Object.keys(detail.details[0]) : [];

  return (
    <Modal open={open} onClose={onClose} title={modalTitle(detail)} wide>
      <div className="modal-body">
        {detail && (
          <>
            <div className="issue-modal-badges">
              <span className={`issue-badge issue-badge-${detail.clevel.toLowerCase()}`}>{detail.clevel}</span>
              <span className={`issue-badge issue-badge-status-${detail.status.toLowerCase()}`}>{STATUS_LABELS[detail.status] || detail.status}</span>
              <span className={`issue-kind issue-kind-${kind.toLowerCase()}`}>{KIND_LABELS[kind]}</span>
            </div>

            {kind !== 'THRESHOLD' && (
              <div className="issue-modal-failure">
                <div className="issue-failure-head">
                  {detail.value && detail.value !== failureLabel(detail) && <code className="issue-error-code">{detail.value}</code>}
                  <span>{failureLabel(detail)}</span>
                </div>
                <pre className="issue-error issue-error-full">{failureError(detail)}</pre>
                <p className="issue-modal-hint">
                  {kind === 'EXEC'
                    ? '이 스크립트의 SQL이 대상 DB에서 실행되지 못했습니다. 권한·객체 존재 여부·SQL 문법을 확인하세요. 다음 점검에서 정상 실행되면 자동으로 해제됩니다.'
                    : '대상 DB에 접속하지 못해 점검 스크립트가 실행되지 않았습니다. 리스너·네트워크·계정 상태를 확인하세요. 다음 점검에서 접속되면 자동으로 해제됩니다.'}
                </p>
              </div>
            )}

            <div className="issue-modal-info">
              <InfoRow label="DB" value={detail.dbname} />
              {kind !== 'CONNECT' && <InfoRow label="점검 스크립트" value={`${detail.taskName} (#${detail.taskId})`} />}
              {kind === 'THRESHOLD' && <InfoRow label="위반 컬럼" value={detail.columnName} />}
              {kind === 'THRESHOLD' && <InfoRow label="메시지" value={detail.message} />}
              <InfoRow label="최초 감지" value={`${formatDate(detail.firstSeenAt)} (${formatRelative(detail.firstSeenAt)})`} />
              <InfoRow label="최근 감지" value={`${formatDate(detail.lastSeenAt)} (${formatRelative(detail.lastSeenAt)})`} />
              {detail.status === 'RESOLVED' && <InfoRow label="해결" value={`${formatDate(detail.resolvedAt)} · ${detail.resolvedBy === 'auto' ? '자동 해제' : detail.resolvedBy || '-'}`} />}
              <InfoRow label="재오픈 횟수" value={detail.reopenCount} />
            </div>

            <div className="issue-modal-links">
              <button type="button" className="btn-secondary" onClick={handleRecheck} disabled={rechecking}>
                {rechecking ? '재점검 중…' : '지금 재점검'}
              </button>
              {detail.latestRunHistoryId != null && canSee(user, 'history') && (
                <a className="btn-link" href={`history.html?dbms=${detail.dbmsId}&run=${detail.latestRunHistoryId}`}>
                  감지된 점검 결과 보기
                </a>
              )}
              {kind === 'EXEC' && isDbaOrAbove(user) && canSee(user, 'scripts') && (
                <a className="btn-link" href={`monitoringScript.html?task=${detail.taskId}`}>
                  스크립트 SQL 열기
                </a>
              )}
              {kind === 'CONNECT' && isDbaOrAbove(user) && canSee(user, 'databases') && (
                <a className="btn-link" href="databases.html">
                  DB 접속 정보 확인
                </a>
              )}
            </div>

            <div className="issue-modal-assignee">
              <label htmlFor="issue-assignee-select">담당자</label>
              <select id="issue-assignee-select" value={selectedAssignee} onChange={(e) => setSelectedAssignee(e.target.value)}>
                <option value="">담당자 미지정</option>
                {assigneeOptions.map((u) => (
                  <option key={u.username} value={u.username}>
                    {u.displayName ? `${u.displayName} (${u.username})` : u.username}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={handleSaveAssignee}>
                저장
              </button>
            </div>

            <div className="issue-modal-actions">
              {detail.status === 'OPEN' && (
                <button type="button" className="btn-secondary" onClick={() => runAction(() => acknowledgeIssue(issueId!), '이슈를 확인 처리했습니다.')}>
                  확인 처리 (Acknowledge)
                </button>
              )}
              {(detail.status === 'OPEN' || detail.status === 'ACKNOWLEDGED') && (
                <button type="button" className="btn-secondary" onClick={() => runAction(() => resolveIssue(issueId!), '이슈를 해결 처리했습니다.')}>
                  해결 처리 (Resolve)
                </button>
              )}
              {detail.status === 'RESOLVED' && (
                <button type="button" className="btn-secondary" onClick={() => runAction(() => reopenIssue(issueId!), '이슈를 재오픈했습니다.')}>
                  재오픈 (Reopen)
                </button>
              )}
            </div>

            {kind === 'THRESHOLD' && detail.details.length > 0 && (
              <>
                <h3 className="issue-modal-subheading">위반한 행 ({detail.details.length}건)</h3>
                <div className="issue-modal-table-wrap">
                  <table className="table issue-modal-table">
                    <thead>
                      <tr>
                        {detailColumns.map((col) => (
                          <th key={col} className={col === detail.columnName ? 'issue-col-violated' : undefined}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.details.map((rowData, idx) => (
                        <tr key={idx}>
                          {detailColumns.map((col) => (
                            <td key={col} className={col === detail.columnName ? `issue-col-violated issue-col-${detail.clevel.toLowerCase()}` : undefined}>
                              {String(rowData[col] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {kind === 'CONNECT' && detail.details.length > 0 && (
              <>
                <h3 className="issue-modal-subheading">실행되지 못한 스크립트 ({detail.details.length}건)</h3>
                <ul className="issue-affected-tasks">
                  {detail.details.map((row, idx) => (
                    <li key={idx}>{String(row.TASK_NAME ?? row.TASK_ID ?? '-')}</li>
                  ))}
                </ul>
              </>
            )}

            <h3 className="issue-modal-subheading">댓글 · 처리 이력</h3>
            <div className="comment-list">
              {detail.comments.length === 0 ? (
                <p className="comment-empty">아직 댓글이 없습니다.</p>
              ) : (
                detail.comments.map((comment) => (
                  <div key={comment.id} className={`comment-item${comment.commentType === 'STATUS_CHANGE' ? ' comment-item-system' : ''}`}>
                    <div className="comment-item-meta">
                      {comment.author || '익명'} · {formatDate(comment.createdAt)}
                    </div>
                    <div className="comment-item-text">{comment.commentText}</div>
                  </div>
                ))
              )}
            </div>

            <div className="comment-form">
              <textarea placeholder="댓글을 입력하세요" value={commentText} onChange={(e) => setCommentText(e.target.value)} />
              <button type="button" className="btn-secondary" onClick={handleSubmitComment}>
                댓글 등록
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
