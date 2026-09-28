import { useEffect, useState, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import {
  acknowledgeIssue,
  addIssueComment,
  assignIssue,
  getIssueDetail,
  getUsersBasic,
  reopenIssue,
  resolveIssue,
} from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { IssueDetail, UserBasic } from '../../shared/lib/types';
import { formatDate, STATUS_LABELS } from './issuesFormat';

interface Props {
  open: boolean;
  issueId: number | null;
  onClose: () => void;
  onIssueChanged: () => void;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }): ReactElement {
  return (
    <div className="issue-modal-info-row">
      <strong>{label}: </strong>
      {value === null || value === undefined || value === '' ? '-' : value}
    </div>
  );
}

// public/issues.html의 #issue-modal-overlay(renderIssueModal 등) 포팅.
export function IssueDetailModal({ open, issueId, onClose, onIssueChanged }: Props): ReactElement {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [assigneeOptions, setAssigneeOptions] = useState<UserBasic[]>([]);
  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [commentText, setCommentText] = useState('');

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

  return (
    <Modal open={open} onClose={onClose} title={detail ? `${detail.taskName} — ${detail.columnName}` : '이슈 상세'} wide>
      <div className="modal-body">
        {detail && (
          <>
            <div className="issue-modal-badges">
              <span className={`issue-badge issue-badge-${detail.clevel.toLowerCase()}`}>{detail.clevel}</span>
              <span className={`issue-badge issue-badge-status-${detail.status.toLowerCase()}`}>
                {STATUS_LABELS[detail.status] || detail.status}
              </span>
            </div>

            <div>
              <InfoRow label="DB" value={detail.dbname} />
              <InfoRow label="메시지" value={detail.message} />
              <InfoRow label="최초 감지" value={formatDate(detail.firstSeenAt)} />
              <InfoRow label="최근 감지" value={formatDate(detail.lastSeenAt)} />
              <InfoRow label="재오픈 횟수" value={detail.reopenCount} />
            </div>

            <div className="issue-modal-assignee">
              <label htmlFor="issue-assignee-select">담당자</label>
              <select
                id="issue-assignee-select"
                value={selectedAssignee}
                onChange={(e) => setSelectedAssignee(e.target.value)}
              >
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
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => runAction(() => acknowledgeIssue(issueId!), '이슈를 확인 처리했습니다.')}
                >
                  확인 처리 (Acknowledge)
                </button>
              )}
              {(detail.status === 'OPEN' || detail.status === 'ACKNOWLEDGED') && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => runAction(() => resolveIssue(issueId!), '이슈를 해결 처리했습니다.')}
                >
                  해결 처리 (Resolve)
                </button>
              )}
              {detail.status === 'RESOLVED' && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => runAction(() => reopenIssue(issueId!), '이슈를 재오픈했습니다.')}
                >
                  재오픈 (Reopen)
                </button>
              )}
            </div>

            {detail.details.length > 0 && (
              <>
                <h3 className="issue-modal-subheading">영향받은 행 ({detail.details.length}건)</h3>
                <table className="table issue-modal-table">
                  <thead>
                    <tr>
                      {Object.keys(detail.details[0]).map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.details.map((rowData, idx) => (
                      <tr key={idx}>
                        {Object.keys(detail.details[0]).map((col) => (
                          <td key={col}>{String(rowData[col] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <h3 className="issue-modal-subheading">댓글</h3>
            <div className="comment-list">
              {detail.comments.length === 0 ? (
                <p className="comment-empty">아직 댓글이 없습니다.</p>
              ) : (
                detail.comments.map((comment) => (
                  <div
                    key={comment.id}
                    className={`comment-item${comment.commentType === 'STATUS_CHANGE' ? ' comment-item-system' : ''}`}
                  >
                    <div className="comment-item-meta">
                      {comment.author || '익명'} · {formatDate(comment.createdAt)}
                    </div>
                    <div className="comment-item-text">{comment.commentText}</div>
                  </div>
                ))
              )}
            </div>

            <div className="comment-form">
              <textarea
                placeholder="댓글을 입력하세요"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
              />
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
