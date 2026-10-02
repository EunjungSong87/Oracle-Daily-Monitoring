import { useEffect, useRef, useState, type ReactElement } from 'react';
import Chart from 'chart.js/auto';
import type { TooltipItem } from 'chart.js';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { useTheme } from '../../shared/hooks/useTheme';
import { getDbmsList, pollSessions } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { AshExecution, DbmsRow, SessionRow } from '../../shared/lib/types';
import { colorFor, WAIT_CLASS_ORDER } from './waitClasses';
import { ElapsedScatter, type ElapsedPoint } from './ElapsedScatter';
import { SessionDetailModal } from './SessionDetailModal';
import { AshSelectionModal, type DetailTarget } from './AshSelectionModal';

// Chart.js는 번들에 포함한다 (vite.config.ts에서 별도 'chart' 청크로 분리).
// 예전처럼 CDN에서 받으면 인터넷이 안 되는 내부망에서 window.Chart가 없어 페이지 전체가 죽는다.
// 아래 타입은 이 파일에서 실제로 건드리는 필드만 좁혀서 선언한 것 — Chart.js 자체 타입은
// datasets/scales가 차트 종류별 유니언이라 그대로 쓰면 필드 접근마다 좁히기가 필요하다.
type ChartInstance = {
  data: { labels: string[]; datasets: { label: string; data: number[]; hidden: boolean }[] };
  options: { scales: { x: { grid: { color: string }; ticks: { color: string } }; y: { grid: { color: string }; ticks: { color: string }; suggestedMax: number } } };
  update: (mode?: 'none') => void;
  destroy: () => void;
};

const POLL_INTERVAL_MS = 2000;
const MAX_SAMPLES = 60; // 2초 * 60 = 최근 2분

// SQL 경과시간 산점도에서 고를 수 있는 표시 구간. 실행 기록은 가장 긴 구간만큼만 보관한다
// (서버도 화면을 처음 열 때 최근 10분치를 준다).
const SCATTER_WINDOWS = [
  { label: '2분', ms: 2 * 60 * 1000 },
  { label: '5분', ms: 5 * 60 * 1000 },
  { label: '10분', ms: 10 * 60 * 1000 },
];
const SCATTER_KEEP_SEC = SCATTER_WINDOWS[SCATTER_WINDOWS.length - 1].ms / 1000;
// 다음 폴링 때 since를 "이번 DB 시각 - 이만큼"으로 잡아, 폴링 사이 경계에 걸린 샘플을 놓치지 않게 겹쳐 조회한다.
const ASH_OVERLAP_SEC = 5;

// 'YYYY-MM-DD HH24:MI:SS'(DB 시각) 문자열 ↔ 숫자. 시간대 변환 없이 숫자 그대로 다룬다
// (DB 시각과 브라우저 시각의 차이는 폴링마다 offset으로 따로 맞춘다).
function dbTimeToMs(value: string): number {
  const [date, time] = value.split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, se] = time.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, se);
}

function shiftDbTime(value: string, seconds: number): string {
  return new Date(dbTimeToMs(value) + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function executionKey(sid: number, serial: number, sqlId: string | null, sqlExecId: number | null): string {
  return `${sid}/${serial}/${sqlId}/${sqlExecId}`;
}

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
    interaction: { mode: 'index' as const, intersect: false },
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
          // 값이 0인 항목은 null을 돌려 툴팁에서 숨긴다. Chart.js는 undefined일 때만 기본 라벨로
          // 대체하고 null은 그대로 쓰지만, 타입 선언에는 null이 빠져 있어 캐스팅한다.
          label: ((ctx: TooltipItem<'line'>) =>
            (ctx.parsed.y ?? 0) > 0 ? `${ctx.dataset.label}: ${ctx.parsed.y}` : null) as (
            ctx: TooltipItem<'line'>,
          ) => string,
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
  const [elapsedPoints, setElapsedPoints] = useState<ElapsedPoint[]>([]);
  const [scatterWindowMs, setScatterWindowMs] = useState(SCATTER_WINDOWS[1].ms);
  const [logScale, setLogScale] = useState(false);
  const [ashUnavailable, setAshUnavailable] = useState<string | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const [selection, setSelection] = useState<AshExecution[] | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);
  const historyRef = useRef<HistorySample[]>([]);
  // 산점도용 SQL 실행 기록 (ASH). 같은 실행이 다음 폴링에 다시 오면 최신 값으로 덮어쓴다.
  const executionsRef = useRef(new Map<string, AshExecution>());
  const ashSinceRef = useRef<string | null>(null);

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
    const chart = new Chart(canvasRef.current, {
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
    chartRef.current = chart as unknown as ChartInstance;
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
    executionsRef.current = new Map();
    ashSinceRef.current = null;
    setElapsedPoints([]);
    setAshUnavailable(null);
  }, [dbmsId]);

  // ASH에서 받은 실행 기록을 합치고, "끝난 실행"만 점으로 만든다.
  // 아직 V$SESSION에서 같은 실행(SQL_EXEC_ID)이 돌고 있으면 걸린 시간이 확정되지 않았으므로 찍지 않는다.
  function mergeExecutions(rows: AshExecution[], fetched: SessionRow[], dbNow: string): void {
    const executions = executionsRef.current;
    rows.forEach((row) => executions.set(executionKey(row.sid, row.serial, row.sqlId, row.sqlExecId), row));
    const oldest = shiftDbTime(dbNow, -SCATTER_KEEP_SEC);
    executions.forEach((row, key) => {
      if (row.lastSample < oldest) executions.delete(key);
    });

    const running = new Set(
      fetched
        .filter((session) => session.status === 'ACTIVE' && session.sqlExecId !== null)
        .map((session) => executionKey(session.sid, session.serial, session.sqlId, session.sqlExecId))
    );
    // DB 시각을 브라우저 시각 축으로 옮기는 보정값 (두 시계의 시간대/오차를 한 번에 흡수).
    const offset = Date.now() - dbTimeToMs(dbNow);
    const points: ElapsedPoint[] = [];
    executions.forEach((row, key) => {
      if (running.has(key) || row.maxElapsedSec === null) return;
      points.push({ x: dbTimeToMs(row.lastSample) + offset, y: row.maxElapsedSec, elapsedSec: row.maxElapsedSec, execution: row });
    });
    setElapsedPoints(points);
  }

  async function pollOnce(currentDbmsId: string): Promise<void> {
    try {
      const { sessions: fetched, dbNow, executions } = await pollSessions(currentDbmsId, ashSinceRef.current);
      if ('unavailable' in executions) {
        setAshUnavailable(executions.unavailable);
      } else {
        setAshUnavailable(null);
        mergeExecutions(executions, fetched, dbNow);
        ashSinceRef.current = shiftDbTime(dbNow, -ASH_OVERLAP_SEC);
      }
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

  // 실행 하나의 상세 창: 그 실행이 돈 구간(시작 ~ 마지막 샘플)의 ASH와 그 SQL을 본다.
  function openExecutionDetail(execution: AshExecution): void {
    setDetailTarget({
      sid: execution.sid,
      serial: execution.serial,
      sqlId: execution.sqlId,
      range: { from: execution.sqlExecStart ?? execution.firstSample, to: shiftDbTime(execution.lastSample, 1) },
    });
  }

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
        <div className="rt-panel-header">
          <h3>SQL 경과 시간 (Active Session)</h3>
          <div className="rt-panel-controls">
            <div className="status-tabs">
              {SCATTER_WINDOWS.map((option) => (
                <button
                  key={option.ms}
                  type="button"
                  className={`status-tab${scatterWindowMs === option.ms ? ' status-tab-active' : ''}`}
                  onClick={() => setScatterWindowMs(option.ms)}
                >
                  최근 {option.label}
                </button>
              ))}
            </div>
            <label className="oc-check">
              <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
              로그 스케일
            </label>
          </div>
        </div>
        {ashUnavailable && (
          <p className="pc-warning">
            ASH를 조회하지 못해 이 그래프를 그릴 수 없습니다 ({ashUnavailable}). 접속 계정의 V$ACTIVE_SESSION_HISTORY 조회
            권한과 Diagnostics Pack 사용 여부를 확인하세요. 위의 세션 목록/추이 그래프는 그대로 동작합니다.
          </p>
        )}
        <div className="aas-chart rt-scatter">
          <ElapsedScatter
            points={elapsedPoints}
            windowMs={scatterWindowMs}
            logScale={logScale}
            theme={theme}
            onPick={(point) => openExecutionDetail(point.execution)}
            onSelect={(points) => setSelection(points.map((point) => point.execution))}
          />
        </div>
        <p className="rt-hint">
          점 하나가 끝난 SQL 실행 하나입니다 (ASH 기준): 가로는 끝난 시각, 세로는 걸린 시간, 색은 그 실행의 주요 wait class.
          점을 누르면 그 실행의 상세를, <strong>드래그로 영역을 고르면</strong> 그 안의 실행 목록을 보여줍니다. 1초보다 짧게 끝난
          실행은 ASH 샘플에 안 잡힐 수 있습니다.
        </p>
      </div>

      <div className="rt-panel">
        <h3>
          세션 목록 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({sessions.length}건 · 더블클릭하면 세션 상세 / SQL)</span>
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
              <tr
                key={s.sid}
                className="rt-session-row"
                title="더블클릭하면 세션 상세 / SQL 전문을 봅니다"
                onDoubleClick={() => setDetailTarget({ sid: s.sid, serial: s.serial, sqlId: null, range: null })}
              >
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

      <AshSelectionModal
        executions={selection}
        hidden={detailTarget !== null}
        onClose={() => setSelection(null)}
        onOpenDetail={openExecutionDetail}
      />
      <SessionDetailModal dbmsId={dbmsId} target={detailTarget} onClose={() => setDetailTarget(null)} />
    </>
  );
}
