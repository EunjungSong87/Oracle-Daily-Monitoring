import type { KeyboardEvent, ReactElement } from 'react';
import type { IssueRow } from '../../shared/lib/types';
import { failureError, failureLabel, formatDate, formatRelative, issueKind, KIND_LABELS, STATUS_LABELS, violationItems } from './issuesFormat';

interface Props {
  issue: IssueRow;
  onOpenDetail: (id: number) => void;
}

const MAX_ITEMS = 3;

// 무엇이 문제인지가 카드 본문에서 바로 읽히도록 종류별로 다르게 그린다.
// - 임계치 위반: 위반 컬럼 + 위반한 대상(식별 값·값) 목록
// - 스크립트 실행 실패: 실패 유형 + 에러 코드 + 에러 원문
// - 대상 DB 접속 실패: 접속 에러 + 그 때문에 못 돈 스크립트 수
export function IssueCard({ issue, onOpenDetail }: Props): ReactElement {
  const kind = issueKind(issue);
  const clevelLower = issue.clevel.toLowerCase();
  const cardClass = `issue-card issue-card-${clevelLower} issue-card-kind-${kind.toLowerCase()}${issue.status === 'RESOLVED' ? ' issue-card-resolved' : ''}`;

  function handleKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenDetail(issue.id);
    }
  }

  return (
    <div className={cardClass} role="button" tabIndex={0} onClick={() => onOpenDetail(issue.id)} onKeyDown={handleKey} aria-label={`${issue.dbname} ${issue.taskName} 이슈 상세`}>
      <div className="issue-card-header">
        <span className={`issue-badge issue-badge-${clevelLower}`}>{issue.clevel}</span>
        <span className={`issue-badge issue-badge-status-${issue.status.toLowerCase()}`}>{STATUS_LABELS[issue.status] || issue.status}</span>
        <span className="issue-dbname" title={issue.dbname}>
          {issue.dbname}
        </span>
      </div>

      <div className={`issue-kind issue-kind-${kind.toLowerCase()}`}>{KIND_LABELS[kind]}</div>
      <div className="issue-task" title={issue.taskName}>
        {kind === 'CONNECT' ? '모든 점검 스크립트 미실행' : issue.taskName}
      </div>

      {kind === 'THRESHOLD' ? <ThresholdBody issue={issue} /> : <FailureBody issue={issue} />}

      <div className="issue-card-footer">
        <span className={issue.assignee ? 'issue-assignee' : 'issue-assignee issue-assignee-none'}>{issue.assignee ? `담당 ${issue.assignee}` : '담당자 미지정'}</span>
        <span className="issue-runat" title={`최초 감지 ${formatDate(issue.firstSeenAt)}\n최근 감지 ${formatDate(issue.lastSeenAt)}`}>
          {issue.reopenCount > 0 && <span className="issue-reopen">재발 {issue.reopenCount}회 · </span>}
          {issue.status === 'RESOLVED' ? `해결 ${formatRelative(issue.resolvedAt)}` : `감지 ${formatRelative(issue.lastSeenAt)}`}
        </span>
      </div>
    </div>
  );
}

function ThresholdBody({ issue }: { issue: IssueRow }): ReactElement {
  const items = violationItems(issue);
  const shown = items.slice(0, MAX_ITEMS);
  return (
    <>
      <div className="issue-detail">
        <code className="issue-column">{issue.columnName}</code>
        {issue.occurrenceCount > 1 && <span className="issue-count">{issue.occurrenceCount}건</span>}
      </div>
      {shown.length > 0 ? (
        <ul className="issue-objects">
          {shown.map((item, idx) => (
            <li key={idx}>
              <span className="issue-object-name">{item.label ?? `#${idx + 1}`}</span>
              <span className="issue-object-value">{item.value}</span>
            </li>
          ))}
          {items.length > MAX_ITEMS && <li className="issue-objects-more">외 {items.length - MAX_ITEMS}건</li>}
        </ul>
      ) : (
        <div className="issue-detail-value">값: {issue.value ?? '-'}</div>
      )}
      {issue.message && <div className="issue-message">{issue.message}</div>}
    </>
  );
}

function FailureBody({ issue }: { issue: IssueRow }): ReactElement {
  const error = failureError(issue);
  const kind = issueKind(issue);
  return (
    <>
      <div className="issue-failure-head">
        {issue.value && issue.value !== failureLabel(issue) && <code className="issue-error-code">{issue.value}</code>}
        <span>{failureLabel(issue)}</span>
        {kind === 'CONNECT' && issue.details.length > 1 && <span className="issue-count">스크립트 {issue.details.length}개 영향</span>}
      </div>
      <pre className="issue-error" title={error}>
        {error}
      </pre>
    </>
  );
}
