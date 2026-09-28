import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { listIssues } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { IssueRow } from '../../shared/lib/types';
import { IssueCard } from './IssueCard';
import { IssueDetailModal } from './IssueDetailModal';

const AUTO_REFRESH_STORAGE_KEY = 'issuesAutoRefreshSeconds';
const STATUS_TABS = [
  { status: 'OPEN', label: 'Open' },
  { status: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { status: 'RESOLVED', label: 'Resolved' },
  { status: 'ALL', label: 'All' },
];

function loadStoredAutoRefresh(): number {
  const saved = Number(localStorage.getItem(AUTO_REFRESH_STORAGE_KEY));
  return [0, 10, 30, 60, 300].includes(saved) ? saved : 0;
}

// public/issues.html 포팅.
export function App(): ReactElement {
  const [statusFilter, setStatusFilter] = useState('OPEN');
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(() => loadStoredAutoRefresh());
  const [openIssueId, setOpenIssueId] = useState<number | null>(null);
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;

  const loadIssues = useCallback(() => {
    listIssues(statusFilterRef.current)
      .then(setIssues)
      .catch((error) => {
        console.error('이슈 목록 조회 실패:', error);
        showToast('이슈 목록 조회 실패', 'error');
      });
  }, []);

  useEffect(() => {
    loadIssues();
  }, [statusFilter, loadIssues]);

  // 자동 새로고침은 #issues-grid만 다시 불러오므로, 모달이 열려있어도 서로 간섭하지 않는다(원본과 동일).
  useEffect(() => {
    if (autoRefreshSeconds <= 0) return;
    const timer = setInterval(loadIssues, autoRefreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [autoRefreshSeconds, loadIssues]);

  function handleAutoRefreshChange(seconds: number): void {
    setAutoRefreshSeconds(seconds);
    localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(seconds));
  }

  return (
    <>
      <AppHeader active="issues" />
      <ToastHost />

      <h2 className="page-title">Issues</h2>
      <p className="issues-subtitle">
        임계치를 위반한 항목을 티켓으로 추적합니다. 상태를 확인/해결 처리하고, 담당자를 지정하고, 댓글을 남길 수
        있습니다.
      </p>

      <div className="issues-toolbar">
        <div className="status-tabs">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.status}
              type="button"
              className={`status-tab${statusFilter === tab.status ? ' status-tab-active' : ''}`}
              onClick={() => setStatusFilter(tab.status)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="issues-toolbar-actions">
          <button type="button" className="btn-secondary" onClick={loadIssues}>
            새로고침
          </button>
          <label htmlFor="auto-refresh-select">자동 새로고침:</label>
          <select
            id="auto-refresh-select"
            value={autoRefreshSeconds}
            onChange={(e) => handleAutoRefreshChange(Number(e.target.value))}
          >
            <option value={0}>사용 안 함</option>
            <option value={10}>10초</option>
            <option value={30}>30초</option>
            <option value={60}>1분</option>
            <option value={300}>5분</option>
          </select>
        </div>
      </div>

      <div className="issues-grid">
        {issues && issues.length === 0 && <p className="issues-empty">해당 상태의 이슈가 없습니다.</p>}
        {issues?.map((issue) => (
          <IssueCard key={issue.id} issue={issue} onOpenDetail={setOpenIssueId} />
        ))}
      </div>

      <IssueDetailModal
        open={openIssueId != null}
        issueId={openIssueId}
        onClose={() => setOpenIssueId(null)}
        onIssueChanged={loadIssues}
      />
    </>
  );
}
