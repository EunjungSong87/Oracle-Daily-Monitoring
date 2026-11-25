import type { ReactElement } from 'react';
import type { BlockingSnapshot, SessionRow, Unavailable } from '../../shared/lib/types';
import { colorFor } from './waitClasses';

// 넓은 화면에서 오른쪽 빈 공간에 두는 요약 사이드바. 새 조회 없이 매 폴링에 이미 받은
// 세션 목록 / 블로킹 / 추이 히스토리를 화면에서 집계만 한다 (좁은 화면에서는 위쪽 카드 줄로 내려온다).

interface Props {
  sessions: SessionRow[];
  blocking: BlockingSnapshot | Unavailable | null;
  recentTotals: number[]; // 최근 추이 샘플별 non-idle active 세션 수
  onOpenSession: (sid: number, serial: number) => void;
}

const TOP_N = 5;

interface Ranked {
  key: string;
  count: number;
  color?: string;
  sub?: string;
}

function rank(rows: SessionRow[], keyOf: (s: SessionRow) => string | null, colorOf?: (s: SessionRow) => string): Ranked[] {
  const map = new Map<string, Ranked>();
  rows.forEach((s) => {
    const key = keyOf(s);
    if (!key) return;
    const item = map.get(key) ?? { key, count: 0, color: colorOf?.(s) };
    item.count += 1;
    map.set(key, item);
  });
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, TOP_N);
}

function formatSec(sec: number | null): string {
  if (sec === null) return '-';
  if (sec < 60) return `${sec}초`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  return `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분`;
}

function RankList({ title, items, empty }: { title: string; items: Ranked[]; empty: string }): ReactElement {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="rt-panel rt-side-card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="rt-side-empty">{empty}</p>
      ) : (
        <ul className="rt-rank">
          {items.map((item) => (
            <li key={item.key} title={`${item.key}: ${item.count}`}>
              <div className="rt-rank-top">
                <span className="rt-rank-name">{item.key}</span>
                <span className="rt-rank-count">{item.count}</span>
              </div>
              <div className="rt-event-track">
                <span
                  className="rt-event-fill"
                  style={{ width: `${(item.count / max) * 100}%`, backgroundColor: item.color ?? 'var(--primary)' }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SummarySidebar({ sessions, blocking, recentTotals, onOpenSession }: Props): ReactElement {
  // IDLE 대기가 아닌 세션만 (위 Active Session 그래프와 같은 기준).
  const working = sessions.filter((s) => s.waitClass !== 'IDLE');
  const activeCount = sessions.filter((s) => s.status === 'ACTIVE').length;
  const waiting = working.filter((s) => s.waitClass !== 'CPU').length;
  const peak = recentTotals.length > 0 ? Math.max(...recentTotals) : null;
  const avg = recentTotals.length > 0 ? recentTotals.reduce((a, b) => a + b, 0) / recentTotals.length : null;

  const blockingRoots = blocking && 'roots' in blocking ? blocking.roots : null;
  const blockedTotal = blockingRoots?.reduce((sum, root) => sum + root.waiterCount, 0) ?? 0;

  const longRunning = [...working]
    .filter((s) => s.lastCallEt !== null)
    .sort((a, b) => (b.lastCallEt ?? 0) - (a.lastCallEt ?? 0))
    .slice(0, TOP_N);

  const topEvents = rank(working, (s) => (s.waitClass === 'CPU' ? 'ON CPU' : s.event), (s) => colorFor(s.waitClass));
  const topSql = rank(working, (s) => s.sqlId);
  const topUsers = rank(working, (s) => s.username || null);
  const topPrograms = rank(working, (s) => s.program);

  return (
    <aside className="rt-side">
      <div className="rt-panel rt-side-card">
        <h3>요약</h3>
        <div className="rt-kpis">
          <div className="rt-kpi">
            <span className="rt-kpi-label">전체 세션</span>
            <span className="rt-kpi-value">{sessions.length}</span>
          </div>
          <div className="rt-kpi">
            <span className="rt-kpi-label">ACTIVE</span>
            <span className="rt-kpi-value">{activeCount}</span>
          </div>
          <div className="rt-kpi">
            <span className="rt-kpi-label">대기 중 (CPU 외)</span>
            <span className={`rt-kpi-value${waiting > 0 ? ' rt-kpi-warn' : ''}`}>{waiting}</span>
          </div>
          <div className="rt-kpi">
            <span className="rt-kpi-label">Blocking</span>
            <span className={`rt-kpi-value${blockingRoots && blockingRoots.length > 0 ? ' rt-kpi-danger' : ''}`}>
              {blockingRoots ? blockingRoots.length : '-'}
              {blockedTotal > 0 && <small> / 대기 {blockedTotal}</small>}
            </span>
          </div>
          <div className="rt-kpi">
            <span className="rt-kpi-label">최근 2분 최대</span>
            <span className="rt-kpi-value">{peak ?? '-'}</span>
          </div>
          <div className="rt-kpi">
            <span className="rt-kpi-label">최근 2분 평균</span>
            <span className="rt-kpi-value">{avg === null ? '-' : avg.toFixed(1)}</span>
          </div>
        </div>
      </div>

      <div className="rt-panel rt-side-card">
        <h3>오래 실행 중인 세션</h3>
        {longRunning.length === 0 ? (
          <p className="rt-side-empty">실행 중인 세션이 없습니다.</p>
        ) : (
          <ul className="rt-long">
            {longRunning.map((s) => (
              <li key={`${s.sid}/${s.serial}`}>
                <button type="button" title="클릭하면 세션 상세 / SQL" onClick={() => onOpenSession(s.sid, s.serial)}>
                  <span className="wait-dot" style={{ backgroundColor: colorFor(s.waitClass) }} />
                  <span className="rt-long-main">
                    <span className="rt-long-who">
                      {s.sid} · {s.username || '-'}
                    </span>
                    <span className="rt-long-sub">{s.sqlId ?? s.event ?? ''}</span>
                  </span>
                  <span className="rt-long-time">{formatSec(s.lastCallEt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <RankList title="Top 대기 이벤트" items={topEvents} empty="대기 중인 세션이 없습니다." />
      <RankList title="Top SQL_ID" items={topSql} empty="실행 중인 SQL이 없습니다." />
      <RankList title="Top 사용자" items={topUsers} empty="-" />
      <RankList title="Top 프로그램" items={topPrograms} empty="-" />
    </aside>
  );
}
