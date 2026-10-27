import { useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { MonitoringResultTable } from '../../shared/components/MonitoringResultTable';
import { ToastHost } from '../../shared/components/ToastHost';
import { getDbmsList, getRunHistoryDetail, getRunHistoryList } from '../../shared/lib/api';
import { urlParam } from '../../shared/lib/urlParams';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsRow, RunHistoryDetail, RunHistorySummary } from '../../shared/lib/types';

function formatRunAt(runAt: string): string {
  if (!runAt || runAt.length < 14) return runAt;
  return `${runAt.slice(0, 4)}-${runAt.slice(4, 6)}-${runAt.slice(6, 8)} ${runAt.slice(8, 10)}:${runAt.slice(10, 12)}:${runAt.slice(12, 14)}`;
}

// <input type="date">의 'YYYY-MM-DD' 값을 API가 쓰는 'YYYYMMDD'로 변환합니다.
function toApiDate(value: string): string | undefined {
  return value ? value.replaceAll('-', '') : undefined;
}

// public/history.html 포팅.
export function App(): ReactElement {
  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [selectedDbmsId, setSelectedDbmsId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [historyList, setHistoryList] = useState<RunHistorySummary[] | null>(null);
  // "보기"로 연 실행 결과는 탭으로 (Daily Monitoring의 결과 탭과 같은 방식). LIST = 이력 목록 탭.
  const [resultTabs, setResultTabs] = useState<RunHistoryDetail[]>([]);
  const [activeTab, setActiveTab] = useState<number | 'LIST'>('LIST');

  useEffect(() => {
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        // ?dbms=로 넘어오면 그 DB, 아니면 첫 번째 DBMS를 자동 선택 — 원본과 동일한 동작.
        const wanted = urlParam('dbms');
        if (wanted && rows.some((row) => String(row.ID) === wanted)) setSelectedDbmsId(wanted);
        else if (rows.length > 0) setSelectedDbmsId(String(rows[0].ID));
        const run = urlParam('run');
        if (run) viewDetail(Number(run));
      })
      .catch((error) => {
        console.error('DBMS 목록 조회 실패:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, []);

  function loadHistoryList(dbmsid: string, from: string, to: string): void {
    if (!dbmsid) {
      setHistoryList(null);
      return;
    }
    getRunHistoryList(Number(dbmsid), toApiDate(from), toApiDate(to))
      .then(setHistoryList)
      .catch((error) => {
        console.error('이력 목록 조회 실패:', error);
        showToast('이력 목록 조회 실패', 'error');
      });
  }

  // 날짜 입력 자체는 "조회" 버튼을 눌러야 반영된다(원본 동작) — 그래서 의도적으로
  // fromDate/toDate를 의존성에 넣지 않고 DBMS 변경 시에만 현재 필터값으로 재조회한다.
  useEffect(() => {
    if (selectedDbmsId) loadHistoryList(selectedDbmsId, fromDate, toDate);
  }, [selectedDbmsId]);

  function applyDateFilter(): void {
    loadHistoryList(selectedDbmsId, fromDate, toDate);
  }

  function clearDateFilter(): void {
    setFromDate('');
    setToDate('');
    loadHistoryList(selectedDbmsId, '', '');
  }

  // 이미 열린 실행이면 그 탭으로, 아니면 새 탭으로 연다.
  async function viewDetail(id: number): Promise<void> {
    if (resultTabs.some((tab) => tab.id === id)) {
      setActiveTab(id);
      return;
    }
    try {
      const result = await getRunHistoryDetail(id);
      setResultTabs((current) => (current.some((tab) => tab.id === result.id) ? current : [...current, result]));
      setActiveTab(result.id);
    } catch (error) {
      console.error('이력 상세 조회 실패:', error);
      showToast('이력 상세 조회 실패', 'error');
    }
  }

  function closeTab(id: number): void {
    setResultTabs((current) => current.filter((tab) => tab.id !== id));
    setActiveTab((current) => (current === id ? 'LIST' : current));
  }

  return (
    <>
      <AppHeader active="history" />
      <ToastHost />

      <h2 className="page-title">Run History</h2>

      <div className="tab">
        <button type="button" className={`tab-link${activeTab === 'LIST' ? ' active' : ''}`} onClick={() => setActiveTab('LIST')}>
          이력 목록
        </button>
        {resultTabs.map((tab) => (
          <span key={tab.id} className={`tab-link history-tab${activeTab === tab.id ? ' active' : ''}`}>
            <button type="button" className="history-tab-open" onClick={() => setActiveTab(tab.id)} title={`${tab.dbname} ${formatRunAt(tab.runAt)}`}>
              {tab.dbname} {formatRunAt(tab.runAt).slice(5, 19)}
            </button>
            <button type="button" className="history-tab-close" aria-label={`${tab.dbname} 탭 닫기`} onClick={() => closeTab(tab.id)}>
              ×
            </button>
          </span>
        ))}
      </div>

      <div className={`tab-content${activeTab === 'LIST' ? ' active' : ''}`}>
        <div className="history-filter-bar">
          <label htmlFor="history-dbms-select">DBMS:</label>
          <select
            id="history-dbms-select"
            value={selectedDbmsId}
            onChange={(e) => setSelectedDbmsId(e.target.value)}
          >
            {dbmsRows.map((row) => (
              <option key={String(row.ID)} value={String(row.ID)}>
                {row.DBNAME} ({row.IP})
              </option>
            ))}
          </select>

          <label htmlFor="history-from-date">시작일:</label>
          <input type="date" id="history-from-date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <label htmlFor="history-to-date">종료일:</label>
          <input type="date" id="history-to-date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <button type="button" className="btn-secondary" onClick={applyDateFilter}>
            조회
          </button>
          <button type="button" className="btn-secondary" onClick={clearDateFilter}>
            전체보기
          </button>
        </div>

        <table id="history-list" className="table">
          <thead>
            <tr>
              <th>실행 시각</th>
              <th>실행 방식</th>
              <th>성공</th>
              <th>실패</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {historyList && historyList.length === 0 && (
              <tr>
                <td colSpan={5}>실행 이력이 없습니다.</td>
              </tr>
            )}
            {historyList?.map((h) => (
              <tr key={h.id}>
                <td>{formatRunAt(h.runAt)}</td>
                <td>{h.triggerType === 'SCHEDULED' ? '자동' : '수동'}</td>
                <td>{h.successCount}</td>
                <td className={h.failCount > 0 ? 'cell-error' : undefined}>{h.failCount}</td>
                <td>
                  <button type="button" className="btn-secondary" onClick={() => viewDetail(h.id)}>
                    {resultTabs.some((tab) => tab.id === h.id) ? '탭 열기' : '보기'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

      </div>

      {resultTabs.map((tab) => (
        <div key={tab.id} className={`tab-content${activeTab === tab.id ? ' active' : ''}`}>
          <h3>
            {tab.dbname} — {formatRunAt(tab.runAt)} ({tab.triggerType === 'SCHEDULED' ? '자동' : '수동'})
          </h3>
          <MonitoringResultTable results={tab.results} />
        </div>
      ))}
    </>
  );
}
