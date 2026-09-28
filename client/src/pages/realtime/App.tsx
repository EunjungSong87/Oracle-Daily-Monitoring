import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { useTheme } from '../../shared/hooks/useTheme';
import { getDbmsList, pollSessions } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsRow, SessionRow } from '../../shared/lib/types';
import { colorFor, WAIT_CLASS_ORDER } from './waitClasses';

// Chart.js는 client/realtimeMonitoring.html의 <head>에서 CDN <script>로 로드된 전역이다
// (원본과 동일한 로딩 방식 유지 — 번들에 포함하지 않음). 타입은 원본도 plain JS라
// 안전성이 없었던 것과 동등한 수준으로 최소한만 선언한다.
declare global {
  interface Window {
    Chart: new (canvas: HTMLCanvasElement, config: unknown) => {
      data: { labels: string[]; datasets: { label: string; data: number[]; hidden: boolean }[] };
      options: { scales: { x: { grid: { color: string }; ticks: { color: string } }; y: { grid: { color: string }; ticks: { color: string }; suggestedMax: number } } };
      update: (mode?: string) => void;
      destroy: () => void;
    };
  }
}

const POLL_INTERVAL_MS = 2000;
const MAX_SAMPLES = 60; // 2초 * 60 = 최근 2분

interface HistorySample {
  time: Date;
  counts: Record<string, number>;
  total: number;
}

function buildChartOptions(theme: 'light' | 'dark') {
  const gridColor = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const tickColor = theme === 'dark' ? '#9ca3af' : '#6b7280';
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        grid: { color: gridColor },
        ticks: { color: tickColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 10 } },
      },
      y: {
        beginAtZero: true,
        grid: { color: gridColor },
        ticks: { color: tickColor, precision: 0, font: { size: 10 } },
      },
    },
    plugins: {
      legend: { display: false }, // 위쪽 "현재 구성" 범례를 공용으로 씀
      tooltip: {
        callbacks: {
          label: (ctx: { parsed: { y: number }; dataset: { label: string } }) =>
            ctx.parsed.y > 0 ? `${ctx.dataset.label}: ${ctx.parsed.y}` : null,
        },
      },
    },
  };
}

// public/realtimeMonitoring.html 포팅.
export function App(): ReactElement {
  const { theme } = useTheme();
  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [dbmsId, setDbmsId] = useState('');
  const [polling, setPolling] = useState(false);
  const [statusText, setStatusText] = useState('대기 중');
  const [statusLive, setStatusLive] = useState(false);
  const [nowCounts, setNowCounts] = useState<Record<string, number>>({});
  const [activeTotal, setActiveTotal] = useState<number | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<InstanceType<Window['Chart']> | null>(null);
  const historyRef = useRef<HistorySample[]>([]);

  function updateChart(): void {
    const chart = chartRef.current;
    if (!chart) return;
    const history = historyRef.current;
    chart.data.labels = history.map((h) => h.time.toLocaleTimeString('ko-KR', { hour12: false }));
    chart.data.datasets.forEach((ds) => {
      const values = history.map((h) => h.counts[ds.label] || 0);
      ds.data = values;
      ds.hidden = !values.some((v) => v > 0);
    });
    chart.options.scales.y.suggestedMax = Math.max(5, ...history.map((h) => h.total));
    chart.update(history.length <= 1 ? 'none' : undefined);
  }

  // 차트는 마운트 시 한 번만 만들고, 언마운트 시 정리한다.
  useEffect(() => {
    if (!canvasRef.current) return;
    const chart = new window.Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: WAIT_CLASS_ORDER.map((cls) => ({
          label: cls,
          data: [],
          borderColor: colorFor(cls),
          backgroundColor: colorFor(cls) + '26',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.35,
          fill: true,
          hidden: true,
        })),
      },
      options: buildChartOptions(theme),
    });
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // 최초 1회만 생성 — 테마 변경 반영은 아래 별도 effect가 담당한다.
  }, []);

  // 원본은 차트 생성 시점의 테마를 한 번만 읽어 고정해서, 다크모드를 나중에 토글하면
  // 새로고침 전까지 격자/눈금 색이 안 바뀌는 한계가 있었다. useTheme가 반응형이므로
  // 테마가 바뀔 때마다 옵션을 갱신해 즉시 반영한다(원본 대비 개선).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const opts = buildChartOptions(theme);
    chart.options.scales.x.grid.color = opts.scales.x.grid.color;
    chart.options.scales.x.ticks.color = opts.scales.x.ticks.color;
    chart.options.scales.y.grid.color = opts.scales.y.grid.color;
    chart.options.scales.y.ticks.color = opts.scales.y.ticks.color;
    chart.update('none');
  }, [theme]);

  useEffect(() => {
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        if (rows.length > 0) {
          setDbmsId(String(rows[0].ID));
          setPolling(true);
        } else {
          setStatusText('DBMS를 선택하세요');
        }
      })
      .catch((error) => {
        console.error('DBMS 목록 조회 실패:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, []);

  // DBMS를 바꾸면 누적 추이 히스토리를 비운다.
  useEffect(() => {
    historyRef.current = [];
    updateChart();
  }, [dbmsId]);

  async function pollOnce(currentDbmsId: string): Promise<void> {
    try {
      const { sessions: fetched } = await pollSessions(currentDbmsId);
      const counts: Record<string, number> = {};
      let total = 0;
      fetched.forEach((s) => {
        if (s.waitClass === 'IDLE') return;
        counts[s.waitClass] = (counts[s.waitClass] || 0) + 1;
        total += 1;
      });

      historyRef.current = [...historyRef.current, { time: new Date(), counts, total }].slice(-MAX_SAMPLES);

      setNowCounts(counts);
      setActiveTotal(total);
      setSessions(fetched);
      updateChart();
      setStatusText('실시간 갱신 중');
      setStatusLive(true);
    } catch (error) {
      console.error('실시간 세션 조회 실패:', error);
      setStatusText(`조회 실패: ${error instanceof Error ? error.message : String(error)}`);
      setStatusLive(false);
    }
  }

  // 폴링 주기 관리 — dbmsId/polling이 바뀌면 cleanup에서 이전 interval을 반드시 정리하고
  // 새로 시작하므로, 원본에 있던 "DBMS 전환 시 이전 interval이 안 지워져 2배속으로 폴링되는"
  // 버그가 구조적으로 재현되지 않는다(수동으로 "고친" 게 아니라 useEffect의 기본 동작).
  useEffect(() => {
    if (!polling || !dbmsId) return;
    pollOnce(dbmsId);
    const timer = setInterval(() => pollOnce(dbmsId), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, dbmsId]);

  function togglePolling(): void {
    if (!polling && !dbmsId) {
      showToast('DBMS를 먼저 선택하세요', 'error');
      return;
    }
    if (polling) {
      setPolling(false);
      setStatusText('일시정지됨');
      setStatusLive(false);
    } else {
      setPolling(true);
    }
  }

  const sortedSessions = [...sessions].sort((a, b) => {
    if (a.status === b.status) return a.sid - b.sid;
    return a.status === 'ACTIVE' ? -1 : 1;
  });
  const hasActiveSegments = Object.keys(nowCounts).length > 0;

  return (
    <>
      <AppHeader active="realtime" />
      <ToastHost />

      <h2 className="page-title">Real-Time Monitoring</h2>

      <div className="rt-toolbar">
        <label htmlFor="rt-dbms-select" style={{ margin: 0 }}>
          DBMS:
        </label>
        <select id="rt-dbms-select" value={dbmsId} onChange={(e) => setDbmsId(e.target.value)}>
          {dbmsRows.length === 0 && <option value="">등록된 DBMS가 없습니다</option>}
          {dbmsRows.map((row) => (
            <option key={String(row.ID)} value={String(row.ID)}>
              {row.DBNAME} ({row.IP}:{String(row.PORT)}/{row.SID})
            </option>
          ))}
        </select>
        <button type="button" className="btn-secondary" id="rt-toggle-btn" onClick={togglePolling}>
          {polling ? '일시정지' : '재개'}
        </button>
        <span>
          <span className={`rt-status-dot${statusLive ? ' live' : ''}`} />
          <span>{statusText}</span>
        </span>
        <span className="rt-total">Active Sessions: {activeTotal ?? '-'}</span>
      </div>

      <div className="rt-panel">
        <h3>현재 Active Session 구성 (Wait Class)</h3>
        {hasActiveSegments && (
          <div className="aas-now">
            {WAIT_CLASS_ORDER.filter((cls) => nowCounts[cls]).map((cls) => (
              <div
                key={cls}
                style={{ flex: `${nowCounts[cls]} 0 0`, backgroundColor: colorFor(cls) }}
                title={`${cls}: ${nowCounts[cls]}`}
              />
            ))}
          </div>
        )}
        {activeTotal === 0 && <p className="aas-now-empty">활성 세션이 없습니다.</p>}
        <div className="aas-legend">
          {WAIT_CLASS_ORDER.map((cls) => (
            <span key={cls}>
              <span className="legend-swatch" style={{ backgroundColor: colorFor(cls) }} />
              {cls}
            </span>
          ))}
        </div>
      </div>

      <div className="rt-panel">
        <h3>최근 추이 (2초 간격, 최근 {MAX_SAMPLES}개 샘플)</h3>
        <div className="aas-chart">
          <canvas ref={canvasRef} />
        </div>
      </div>

      <div className="rt-panel">
        <h3>
          세션 목록 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({sessions.length}건)</span>
        </h3>
        <table id="rt-session-table" className="table" style={{ width: '100%', maxWidth: 'none', margin: 0 }}>
          <thead>
            <tr>
              <th>SID</th>
              <th>SERIAL#</th>
              <th>USERNAME</th>
              <th>STATUS</th>
              <th>WAIT CLASS</th>
              <th>EVENT</th>
              <th>SQL_ID</th>
              <th>PROGRAM</th>
              <th>MACHINE</th>
              <th>LOGON_TIME</th>
              <th>LAST_CALL_ET(초)</th>
            </tr>
          </thead>
          <tbody>
            {sortedSessions.map((s) => (
              <tr key={s.sid}>
                <td>{s.sid}</td>
                <td>{s.serial}</td>
                <td>{s.username}</td>
                <td>{s.status}</td>
                <td>
                  <span className="wait-badge" style={{ backgroundColor: colorFor(s.waitClass) }}>
                    {s.waitClass}
                  </span>
                </td>
                <td>{s.event ?? ''}</td>
                <td>{s.sqlId ?? ''}</td>
                <td>{s.program ?? ''}</td>
                <td>{s.machine ?? ''}</td>
                <td>{s.logonTime ?? ''}</td>
                <td>{s.lastCallEt ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 && <p className="issues-empty">세션 정보가 없습니다.</p>}
      </div>
    </>
  );
}
