import { useEffect, useRef, useState, type ReactElement } from 'react';
import Chart from 'chart.js/auto';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getCapacity, getCapacityTrend, getDbmsList, saveCapacityConfig } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import { urlParam } from '../../shared/lib/urlParams';
import type { CapacityConfig, CapacityItem, CapacityPoint, CapacityView, DbmsRow } from '../../shared/lib/types';
import { formatBytes } from '../dataPump/helpers';

// Monitoring > Capacity: 예약 일일점검이 하루 한 번 쌓는 테이블스페이스/ASM 사용량(메타데이터 DB)으로 추이와 소진 예상일을 본다.
// 이 화면은 대상 DB에 접속하지 않는다.

function estimateLabel(item: CapacityItem): string {
  switch (item.status) {
    case 'REACHED':
      return '이미 도달';
    case 'OK':
      return `${item.date} (${item.daysLeft}일 남음)`;
    case 'NO_GROWTH':
      return '증가 없음';
    default:
      return `데이터 부족 (${item.samples}일, 7일 이상 필요)`;
  }
}

function TrendChart({ points, thresholdPct }: { points: CapacityPoint[]; thresholdPct: number }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 100) / 100;
    const chart = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: points.map((point) => point.day),
        datasets: [
          { label: '사용 (GB)', data: points.map((point) => gb(point.used)), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.15)', fill: true, pointRadius: 2 },
          { label: '최대 (GB)', data: points.map((point) => gb(point.max)), borderColor: '#9ca3af', borderDash: [6, 4], pointRadius: 0 },
          ...(thresholdPct < 100
            ? [{ label: `임계치 ${thresholdPct}%`, data: points.map((point) => gb((point.max * thresholdPct) / 100)), borderColor: '#ef4444', borderDash: [3, 3], pointRadius: 0 }]
            : []),
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { y: { beginAtZero: true, title: { display: true, text: 'GB' } } } },
    });
    return () => chart.destroy();
  }, [points, thresholdPct]);
  return (
    <div className="cap-chart">
      <canvas ref={canvasRef} />
    </div>
  );
}

export function App(): ReactElement {
  const { user, loading } = useCurrentUser();
  const canUse = canSee(user, 'capacity');
  const isDba = user?.role === 'DBA' || user?.role === 'SUPER_ADMIN';
  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [dbmsId, setDbmsId] = useState('');
  const [view, setView] = useState<CapacityView | null>(null);
  const [selected, setSelected] = useState<CapacityItem | null>(null);
  const [trend, setTrend] = useState<CapacityPoint[] | null>(null);
  const [trendDays, setTrendDays] = useState(365);
  const [config, setConfig] = useState<CapacityConfig | null>(null);

  useEffect(() => {
    if (!canUse) return;
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        const wanted = urlParam('dbms');
        if (wanted && rows.some((row) => String(row.ID) === wanted)) setDbmsId(wanted);
        else if (rows.length > 0) setDbmsId(String(rows[0].ID));
      })
      .catch(() => showToast('DBMS 목록 조회 실패', 'error'));
  }, [canUse]);

  useEffect(() => {
    if (!dbmsId) return;
    setView(null);
    setSelected(null);
    setTrend(null);
    getCapacity(dbmsId)
      .then((result) => {
        setView(result);
        setConfig(result.config);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : '용량 현황을 불러오지 못했습니다.', 'error'));
  }, [dbmsId]);

  useEffect(() => {
    if (!dbmsId || !selected) return;
    setTrend(null);
    getCapacityTrend(dbmsId, selected.kind, selected.name, trendDays)
      .then(setTrend)
      .catch((error) => showToast(error instanceof Error ? error.message : '추이를 불러오지 못했습니다.', 'error'));
  }, [dbmsId, selected, trendDays]);

  async function saveConfig(): Promise<void> {
    if (!config) return;
    try {
      await saveCapacityConfig(config);
      showToast('설정을 저장했습니다. 다음 예약 점검부터 반영됩니다.');
      setView(await getCapacity(dbmsId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.', 'error');
    }
  }

  const alertDays = view?.config.alertDays ?? 30;
  return (
    <>
      <AppHeader active="capacity" />
      <ToastHost />
      <h2 className="page-title">Capacity (테이블스페이스 / ASM 사용량 추이)</h2>
      {!loading && !canUse && <p className="issues-empty">이 화면을 볼 권한이 없습니다.</p>}
      {canUse && (
        <div className="rt-panel">
          <div className="dp-row">
            <label htmlFor="cap-dbms">DBMS</label>
            <select id="cap-dbms" value={dbmsId} onChange={(e) => setDbmsId(e.target.value)}>
              {dbmsRows.map((row) => (
                <option key={row.ID} value={String(row.ID)}>
                  {row.DBNAME}
                </option>
              ))}
            </select>
          </div>
          <p className="oc-hint">
            예약 일일점검 때 하루 한 번 수집합니다 (DBA_TABLESPACE_USAGE_METRICS, V$ASM_DISKGROUP_STAT). 예상일은 최근 30일 선형회귀로 임계치(
            {view?.config.thresholdPct ?? 100}%)에 닿는 날이며, {alertDays}일 안이면 이슈 티켓이 만들어집니다.
          </p>
          {view && !view.available && (
            <p className="pc-warning">용량 이력 테이블이 없습니다. 메타데이터 DB에 scripts/add_capacity_history.sql을 실행하세요 (설치 필요).</p>
          )}
          {view?.available && view.items.length === 0 && <p className="issues-empty">아직 수집된 기록이 없습니다. 이 DB가 예약 점검 대상인지 확인하세요.</p>}
          {view?.available && view.items.length > 0 && (
            <table className="table oc-items-table">
              <thead>
                <tr>
                  <th>종류</th>
                  <th>이름</th>
                  <th>사용률</th>
                  <th>사용 / 최대</th>
                  <th>하루 증가</th>
                  <th>{view.config.thresholdPct}% 도달 예상</th>
                  <th>마지막 수집</th>
                </tr>
              </thead>
              <tbody>
                {view.items.map((item) => {
                  const imminent = item.status === 'REACHED' || (item.status === 'OK' && (item.daysLeft ?? Infinity) <= alertDays);
                  return (
                    <tr
                      key={`${item.kind}:${item.name}`}
                      className={`cap-row${selected?.kind === item.kind && selected.name === item.name ? ' cap-row-selected' : ''}`}
                      onClick={() => setSelected(item)}
                    >
                      <td>{item.kind === 'ASM' ? 'ASM' : 'TS'}</td>
                      <td className="oc-name">{item.name}</td>
                      <td>{item.usedPct !== null ? `${item.usedPct}%` : '-'}</td>
                      <td>
                        {formatBytes(item.used)} / {formatBytes(item.max)}
                      </td>
                      <td>{item.slopePerDay && item.slopePerDay > 0 ? formatBytes(item.slopePerDay) : '-'}</td>
                      <td className={imminent ? 'dash-bad' : undefined}>{estimateLabel(item)}</td>
                      <td>{item.lastDay}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      {selected && (
        <div className="rt-panel">
          <div className="rt-panel-header">
            <h3>
              {selected.kind === 'ASM' ? 'ASM 디스크그룹' : '테이블스페이스'} {selected.name} 추이
            </h3>
            <select aria-label="기간" value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))}>
              <option value={30}>30일</option>
              <option value={90}>90일</option>
              <option value={365}>1년</option>
              <option value={730}>2년</option>
            </select>
          </div>
          {trend ? <TrendChart points={trend} thresholdPct={view?.config.thresholdPct ?? 100} /> : <p className="oc-detail-note">읽는 중...</p>}
        </div>
      )}
      {canUse && isDba && view?.available && config && (
        <div className="rt-panel">
          <h3>설정</h3>
          <div className="dp-grid">
            <div>
              <label htmlFor="cap-retention">보관 기간 (일)</label>
              <input id="cap-retention" type="number" min={30} max={3650} value={config.retentionDays} onChange={(e) => setConfig({ ...config, retentionDays: Number(e.target.value) })} />
            </div>
            <div>
              <label htmlFor="cap-alert">이슈 티켓: 예상일이 N일 이내</label>
              <input id="cap-alert" type="number" min={1} max={365} value={config.alertDays} onChange={(e) => setConfig({ ...config, alertDays: Number(e.target.value) })} />
            </div>
            <div>
              <label htmlFor="cap-threshold">임계치 (%)</label>
              <input id="cap-threshold" type="number" min={50} max={100} value={config.thresholdPct} onChange={(e) => setConfig({ ...config, thresholdPct: Number(e.target.value) })} />
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
