import type { ReactElement } from 'react';
import type { IssueRow } from '../../shared/lib/types';
import { formatDate, STATUS_LABELS } from './issuesFormat';

interface Props {
  issue: IssueRow;
  onOpenDetail: (id: number) => void;
}

// public/issues.html의 buildIssueCard() 포팅.
export function IssueCard({ issue, onOpenDetail }: Props): ReactElement {
  const clevelLower = issue.clevel.toLowerCase();
  const cardClass = `issue-card issue-card-${clevelLower}${issue.status === 'RESOLVED' ? ' issue-card-resolved' : ''}`;
  const detailText =
    issue.occurrenceCount > 1
      ? `${issue.columnName}: ${issue.value} 외 ${issue.occurrenceCount - 1}건`
      : `${issue.columnName}: ${issue.value}`;

  return (
    <div className={cardClass}>
      <div className="issue-card-header">
        <span className={`issue-badge issue-badge-${clevelLower}`}>{issue.clevel}</span>
        <span className={`issue-badge issue-badge-status-${issue.status.toLowerCase()}`}>
          {STATUS_LABELS[issue.status] || issue.status}
        </span>
        <span className="issue-dbname">{issue.dbname}</span>
      </div>
      <div className="issue-task">{issue.taskName}</div>
      <div className="issue-detail">{detailText}</div>
      {issue.message && <div className="issue-message">{issue.message}</div>}
      <div className="issue-meta">{issue.assignee ? `담당자: ${issue.assignee}` : '담당자 미지정'}</div>
      <div className="issue-runat">최근 감지: {formatDate(issue.lastSeenAt)}</div>
      <div className="issue-card-actions">
        <button type="button" className="btn-secondary" onClick={() => onOpenDetail(issue.id)}>
          상세
        </button>
      </div>
    </div>
  );
}
