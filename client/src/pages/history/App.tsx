import { useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { MonitoringResultTable } from '../../shared/components/MonitoringResultTable';
import { ToastHost } from '../../shared/components/ToastHost';
import { getDbmsList, getRunHistoryDetail, getRunHistoryList } from '../../shared/lib/api';
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
  const [detail, setDetail] = useState<RunHistoryDetail | null>(null);

  useEffect(() => {
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        // placeholder 없이 첫 번째 DBMS를 자동 선택 — 원본과 동일한 동작.
        if (rows.length > 0) setSelectedDbmsId(String(rows[0].ID));
      })
      .catch((error) => {
        console.error('DBMS 목록 조회 실패:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, []);

  function loadHistoryList(dbmsid: string, from: string, to: string): void {
    setDetail(null);
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

  async function viewDetail(id: number): Promise<void> {
    try {
      const result = await getRunHistoryDetail(id);
      setDetail(result);
    } catch (error) {
      console.error('이력 상세 조회 실패:', error);
      showToast('이력 상세 조회 실패', 'error');
    }
  }

  return (
    <>
      <AppHeader active="history" />
      <ToastHost />

      <h2 className="page-title">Run History</h2>

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
                  보기
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div id="history-detail">
        {detail && (
          <>
            <h2>
              {detail.dbname} — {formatRunAt(detail.runAt)} ({detail.triggerType === 'SCHEDULED' ? '자동' : '수동'})
            </h2>
            <MonitoringResultTable results={detail.results} />
          </>
        )}
      </div>
    </>
  );
}
