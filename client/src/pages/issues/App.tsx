import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { listIssues } from '../../shared/lib/api';
import { urlParam } from '../../shared/lib/urlParams';
import { showToast } from '../../shared/lib/toastStore';
import type { IssueRow } from '../../shared/lib/types';
import { IssueCard } from './IssueCard';
import { IssueDetailModal } from './IssueDetailModal';
import { failureError, issueKind, KIND_LABELS, type IssueKind } from './issuesFormat';

const AUTO_REFRESH_STORAGE_KEY = 'issuesAutoRefreshSeconds';
const STATUS_TABS = [
  { status: 'OPEN', label: '미해결' },
  { status: 'ACKNOWLEDGED', label: '확인됨' },
  { status: 'RESOLVED', label: '해결됨' },
  { status: 'ALL', label: '전체' },
];
const LEVEL_FILTERS = ['CRITICAL', 'ERROR', 'WARN'];
const KIND_FILTERS: IssueKind[] = ['THRESHOLD', 'EXEC', 'CONNECT'];

function loadStoredAutoRefresh(): number {
  const saved = Number(localStorage.getItem(AUTO_REFRESH_STORAGE_KEY));
  return [0, 10, 30, 60, 300].includes(saved) ? saved : 0;
}

// public/issues.html 포팅.
export function App(): ReactElement {
  const [statusFilter, setStatusFilter] = useState('OPEN');
  // ?dbms=로 넘어오면 그 DB의 이슈만 (화면에서 풀 수 있음)
  const [dbmsFilter, setDbmsFilter] = useState<string | null>(() => urlParam('dbms'));
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(() => loadStoredAutoRefresh());
  const [openIssueId, setOpenIssueId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  // 비어 있으면 모든 레벨
  const [levels, setLevels] = useState<Set<string>>(() => new Set());
  // 비어 있으면 모든 종류 (임계치 위반 / 스크립트 실행 실패 / 대상 DB 접속 실패)
  const [kinds, setKinds] = useState<Set<IssueKind>>(() => new Set());
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

  const dbIssues = (issues ?? []).filter((issue) => !dbmsFilter || String(issue.dbmsId) === dbmsFilter);
  const levelCounts = (level: string): number => dbIssues.filter((issue) => issue.clevel === level).length;
  const kindCounts = (kind: IssueKind): number => dbIssues.filter((issue) => issueKind(issue) === kind).length;
  const q = search.trim().toLowerCase();
  const visibleIssues = dbIssues.filter(
    (issue) =>
      (levels.size === 0 || levels.has(issue.clevel)) &&
      (kinds.size === 0 || kinds.has(issueKind(issue))) &&
      (!q ||
        [issue.dbname, issue.taskName, issue.columnName, issue.message, issue.value, issue.assignee, issueKind(issue) === 'THRESHOLD' ? '' : failureError(issue)].some((text) =>
          String(text ?? '').toLowerCase().includes(q)
        ))
  );
  const filtering = levels.size > 0 || kinds.size > 0 || q !== '';

  function toggleIn<T>(setter: (update: (prev: Set<T>) => Set<T>) => void, value: T): void {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function toggleLevel(level: string): void {
    toggleIn(setLevels, level);
  }

  return (
    <>
      <AppHeader active="issues" />
      <ToastHost />

      <PageHeader section="모니터링 · 일일 점검" title="이슈 티켓" description="임계치 위반 항목을 티켓으로 추적합니다. 확인·해결 처리, 담당자 지정, 댓글을 남길 수 있습니다." />

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

      <div className="list-toolbar issues-filter">
        <input
          type="search"
          className="list-search"
          placeholder="DB, 점검 스크립트, 컬럼, 에러 메시지, 담당자 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="이슈 검색"
        />
        <div className="issues-level-filter" role="group" aria-label="레벨 필터">
          {LEVEL_FILTERS.map((level) => (
            <button
              key={level}
              type="button"
              className={`issue-level-chip issue-badge issue-badge-${level.toLowerCase()}${levels.has(level) ? ' issue-level-chip-on' : ''}`}
              onClick={() => toggleLevel(level)}
              aria-pressed={levels.has(level)}
            >
              {level} {levelCounts(level)}
            </button>
          ))}
        </div>
        <div className="issues-level-filter" role="group" aria-label="종류 필터">
          {KIND_FILTERS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`issue-kind-chip issue-kind issue-kind-${kind.toLowerCase()}${kinds.has(kind) ? ' issue-kind-chip-on' : ''}`}
              onClick={() => toggleIn(setKinds, kind)}
              aria-pressed={kinds.has(kind)}
              disabled={kindCounts(kind) === 0 && !kinds.has(kind)}
            >
              {KIND_LABELS[kind]} {kindCounts(kind)}
            </button>
          ))}
        </div>
        {filtering && (
          <button
            type="button"
            className="oc-link"
            onClick={() => {
              setLevels(new Set());
              setKinds(new Set());
              setSearch('');
            }}
          >
            필터 초기화
          </button>
        )}
        {issues && (
          <span className="list-count">
            {filtering ? (
              <>
                <strong>{visibleIssues.length}</strong>건 / 전체 {dbIssues.length}건
              </>
            ) : (
              <>
                전체 <strong>{dbIssues.length}</strong>건
              </>
            )}
          </span>
        )}
      </div>

      {dbmsFilter && (
        <p className="oc-hint">
          {issues?.find((issue) => String(issue.dbmsId) === dbmsFilter)?.dbname ?? `DB #${dbmsFilter}`}의 이슈만 보는 중{' '}
          <button type="button" className="oc-link" onClick={() => setDbmsFilter(null)}>
            전체 보기
          </button>
        </p>
      )}
      <div className="issues-grid">
        {issues && visibleIssues.length === 0 && <p className="issues-empty">{filtering && dbIssues.length > 0 ? '검색·필터 조건에 맞는 이슈가 없습니다.' : '해당 상태의 이슈가 없습니다.'}</p>}
        {visibleIssues.map((issue) => (
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
