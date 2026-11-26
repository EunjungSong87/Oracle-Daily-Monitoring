import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import Chart from 'chart.js/auto';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getAlertLogConfig, getAlertLogTrend, getDbmsList, saveAlertLogConfig, searchAlertLog } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { AlertLogConfigView, AlertLogSearchParams, AlertLogSearchResult, AlertLogTrendPoint, DbmsRow } from '../../shared/lib/types';

// Monitoring > Alert Log: 예약 일일점검이 쌓는 Alert Log(ORA-/FAIL) 발생 내역(메타데이터 DB)을 DB/기간/ORA 코드로 검색한다.
// 이 화면은 대상 DB에 접속하지 않는다.

const PAGE_SIZE = 200;
const NO_CODE = '(코드 없음)';

function dayString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return dayString(date);
}

// from~to 사이 모든 날짜 (빈 날은 0으로 채우려고)
function dayRange(from: string, to: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end && result.length <= 400) {
    result.push(dayString(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function DailyChart({ labels, counts }: { labels: string[]; counts: number[] }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new Chart(canvasRef.current, {
      type: 'bar',
      data: { labels, datasets: [{ label: '발생 건수', data: counts, backgroundColor: 'rgba(239,68,68,0.6)', borderColor: '#ef4444', borderWidth: 1 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
    return () => chart.destroy();
  }, [labels, counts]);
  return (
    <div className="cap-chart">
      <canvas ref={canvasRef} />
    </div>
  );
}

export function App(): ReactElement {
  const { user, loading } = useCurrentUser();
  const canUse = canSee(user, 'alertLog');
  const isDba = user?.role === 'DBA' || user?.role === 'SUPER_ADMIN';
  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [dbmsId, setDbmsId] = useState('');
  const [fromDate, setFromDate] = useState(daysAgo(6));
  const [toDate, setToDate] = useState(dayString(new Date()));
  const [oraCode, setOraCode] = useState('');
  const [keyword, setKeyword] = useState('');
  const [configView, setConfigView] = useState<AlertLogConfigView | null>(null);
  const [retentionDays, setRetentionDays] = useState(365);
  const [applied, setApplied] = useState<AlertLogSearchParams | null>(null);
  const [result, setResult] = useState<AlertLogSearchResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [trend, setTrend] = useState<AlertLogTrendPoint[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canUse) return;
    getDbmsList()
      .then(({ rows }) => setDbmsRows(rows))
      .catch(() => showToast('DBMS 목록 조회 실패', 'error'));
    getAlertLogConfig()
      .then((view) => {
        setConfigView(view);
        setRetentionDays(view.config.retentionDays);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : '설정을 불러오지 못했습니다.', 'error'));
  }, [canUse]);

  async function runSearch(params: AlertLogSearchParams, nextOffset: number, withTrend: boolean): Promise<void> {
    setBusy(true);
    try {
      const [page, points] = await Promise.all([
        searchAlertLog({ ...params, limit: PAGE_SIZE, offset: nextOffset }),
        withTrend ? getAlertLogTrend(params) : Promise.resolve(null),
      ]);
      setApplied(params);
      setResult(page);
      setOffset(nextOffset);
      if (points) setTrend(points);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Alert Log를 검색하지 못했습니다.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void runSearch({ dbmsId: dbmsId || null, fromDate, toDate, oraCode: oraCode.trim() || undefined, keyword: keyword.trim() || undefined }, 0, true);
  }

  function filterByCode(code: string | null): void {
    if (!applied || code === null) return;
    setOraCode(code);
    void runSearch({ ...applied, oraCode: code }, 0, true);
  }

  async function saveConfig(): Promise<void> {
    try {
      await saveAlertLogConfig({ retentionDays });
      showToast('설정을 저장했습니다. 다음 예약 점검부터 반영됩니다.');
      setConfigView(await getAlertLogConfig());
    } catch (error) {
      showToast(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.', 'error');
    }
  }

  // 추이: 일자별 합계(빈 날 0) + ORA 코드별 합계(많은 순)
  const daily = useMemo(() => {
    if (!trend || !applied) return null;
    const labels = dayRange(applied.fromDate, applied.toDate);
    const byDay = new Map<string, number>();
    for (const point of trend) byDay.set(point.day, (byDay.get(point.day) ?? 0) + point.count);
    return { labels, counts: labels.map((day) => byDay.get(day) ?? 0) };
  }, [trend, applied]);
  const byCode = useMemo(() => {
    if (!trend) return [];
    const totals = new Map<string | null, number>();
    for (const point of trend) totals.set(point.oraCode, (totals.get(point.oraCode) ?? 0) + point.count);
    return [...totals.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code)));
  }, [trend]);

  const total = result?.total ?? 0;
  const available = configView?.available !== false;
  return (
    <>
      <AppHeader active="alertLog" />
      <ToastHost />
      <PageHeader section="모니터링" title="Alert Log 오류" description="Alert Log에 기록된 ORA- 오류와 FAIL 메시지를 기간별로 조회합니다." />
      {!loading && !canUse && <p className="issues-empty">이 화면을 볼 권한이 없습니다.</p>}
      {canUse && (
        <div className="rt-panel">
          <form onSubmit={handleSubmit}>
            <div className="dp-grid">
              <div>
                <label htmlFor="al-dbms">DBMS</label>
                <select id="al-dbms" value={dbmsId} onChange={(e) => setDbmsId(e.target.value)}>
                  <option value="">전체</option>
                  {dbmsRows.map((row) => (
                    <option key={row.ID} value={String(row.ID)}>
                      {row.DBNAME}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="al-from">기간</label>
                <input id="al-from" type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} />
                <input aria-label="종료일" type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} />
              </div>
              <div>
                <label htmlFor="al-code">ORA 코드</label>
                <input id="al-code" type="text" placeholder="예: ORA-00600 또는 600" value={oraCode} onChange={(e) => setOraCode(e.target.value)} />
              </div>
              <div>
                <label htmlFor="al-keyword">키워드</label>
                <input id="al-keyword" type="text" placeholder="메시지에 포함된 글자" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
              </div>
            </div>
            <div className="oc-actions">
              <button type="submit" disabled={busy || !available}>
                {busy ? '검색 중...' : '검색'}
              </button>
            </div>
          </form>
          <p className="oc-hint">
            예약 일일점검 때 대상 DB의 V$DIAG_ALERT_EXT에서 최근 2일분 ORA-/FAIL 메시지를 모아 쌓습니다 (같은 시각·메시지는 한 번만). 보관 기간{' '}
            {configView?.config.retentionDays ?? 365}일, 한 번에 최대 1년 범위까지 검색합니다.
          </p>
          {!available && <p className="pc-warning">Alert Log 이력 테이블이 없습니다. 메타데이터 DB에 scripts/add_alert_log_history.sql을 실행하세요 (설치 필요).</p>}
        </div>
      )}
      {canUse && daily && trend && (
        <div className="rt-panel">
          <h3>발생 추이</h3>
          {trend.length === 0 ? (
            <p className="issues-empty">조건에 맞는 기록이 없습니다.</p>
          ) : (
            <>
              <DailyChart labels={daily.labels} counts={daily.counts} />
              <table className="table oc-items-table">
                <thead>
                  <tr>
                    <th>ORA 코드</th>
                    <th>건수</th>
                  </tr>
                </thead>
                <tbody>
                  {byCode.slice(0, 20).map(({ code, count }) => (
                    <tr key={code ?? NO_CODE} className={code ? 'cap-row' : undefined} onClick={() => filterByCode(code)} title={code ? '이 코드로 검색' : undefined}>
                      <td className="oc-name">{code ?? NO_CODE}</td>
                      <td>{count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {byCode.length > 20 && <p className="oc-hint">상위 20개 코드만 표시합니다 (전체 {byCode.length}개).</p>}
            </>
          )}
        </div>
      )}
      {canUse && result && (
        <div className="rt-panel">
          <div className="rt-panel-header">
            <h3>검색 결과</h3>
            <span className="oc-hint">
              {total === 0 ? '0건' : `총 ${total.toLocaleString()}건 중 ${(offset + 1).toLocaleString()}–${(offset + result.rows.length).toLocaleString()}`}
            </span>
          </div>
          {result.rows.length === 0 ? (
            <p className="issues-empty">조건에 맞는 기록이 없습니다. 대상 DB가 예약 점검 대상인지 확인하세요.</p>
          ) : (
            <table className="table oc-items-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>DB</th>
                  <th>ORA 코드</th>
                  <th>MESSAGE_TYPE</th>
                  <th>메시지</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="al-nowrap">{row.logTime}</td>
                    <td className="al-nowrap">{row.dbname ?? `#${row.dbmsId}`}</td>
                    <td className="al-nowrap">{row.oraCode ?? '-'}</td>
                    <td className="al-nowrap">{row.messageType ?? '-'}</td>
                    <td className="al-msg" title={row.filename ?? undefined}>
                      {row.messageText}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {applied && total > PAGE_SIZE && (
            <div className="oc-actions">
              <button type="button" disabled={busy || offset === 0} onClick={() => runSearch(applied, Math.max(offset - PAGE_SIZE, 0), false)}>
                이전
              </button>
              <span className="oc-hint">
                {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)} 페이지
              </span>
              <button type="button" disabled={busy || offset + PAGE_SIZE >= total} onClick={() => runSearch(applied, offset + PAGE_SIZE, false)}>
                다음
              </button>
            </div>
          )}
        </div>
      )}
      {canUse && isDba && configView?.available && (
        <div className="rt-panel">
          <h3>설정</h3>
          <div className="dp-grid">
            <div>
              <label htmlFor="al-retention">보관 기간 (일)</label>
              <input id="al-retention" type="number" min={30} max={3650} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} />
            </div>
          </div>
          <div className="oc-actions">
            <button type="button" onClick={saveConfig}>
              저장
            </button>
          </div>
        </div>
      )}
    </>
  );
}
