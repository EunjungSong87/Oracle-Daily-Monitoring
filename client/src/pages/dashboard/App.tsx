import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getDashboard } from '../../shared/lib/api';
import type { CurrentUser, Dashboard, DashboardCard, DashboardSignal } from '../../shared/lib/types';

// 첫 화면: 전체 DB 현황. 서버는 메타데이터 DB(점검 이력/이슈/Data Pump 이력)만 읽는다 — 대상 DB에 접속하지 않으므로 1분마다 새로 고쳐도 부담이 없다.
const REFRESH_MS = 60 * 1000;

const SIGNAL_LABEL: Record<DashboardSignal, string> = { RED: '위반(ERROR)', YELLOW: '주의', GREEN: '정상', GRAY: '점검 없음' };

function Links({ card, user }: { card: DashboardCard; user: CurrentUser | null }): ReactElement {
  const links: { href: string; label: string }[] = [];
  if (card.lastRun && canSee(user, 'history')) links.push({ href: `history.html?dbms=${card.dbmsId}&run=${card.lastRun.id}`, label: '최근 점검 결과' });
  if (canSee(user, 'issues')) links.push({ href: `issues.html?dbms=${card.dbmsId}`, label: '이슈' });
  if (canSee(user, 'dailyMonitoring')) links.push({ href: `dailyMonitoring.html?dbms=${card.dbmsId}`, label: '점검 실행' });
  if (canSee(user, 'capacity')) links.push({ href: `capacity.html?dbms=${card.dbmsId}`, label: '용량' });
  if (canSee(user, 'dataPump') && (card.dataPump.running.length > 0 || card.dataPump.latest)) links.push({ href: `dataPump.html?dbms=${card.dbmsId}`, label: 'Data Pump' });
  return (
    <div className="dash-links">
      {links.map((link) => (
        <a key={link.href} href={link.href} onClick={(e) => e.stopPropagation()}>
          {link.label}
        </a>
      ))}
    </div>
  );
}

// 카드 클릭: 위반·이슈가 있으면 이슈(그 DB로 필터), 아니면 최근 점검 결과
function cardHref(card: DashboardCard, user: CurrentUser | null): string | null {
  const openIssues = card.issues.ERROR + card.issues.WARN + card.issues.other;
  if (openIssues > 0 && canSee(user, 'issues')) return `issues.html?dbms=${card.dbmsId}`;
  if (card.lastRun && canSee(user, 'history')) return `history.html?dbms=${card.dbmsId}&run=${card.lastRun.id}`;
  if (canSee(user, 'dailyMonitoring')) return `dailyMonitoring.html?dbms=${card.dbmsId}`;
  return null;
}

function Card({ card, user, showDataPump }: { card: DashboardCard; user: CurrentUser | null; showDataPump: boolean }): ReactElement {
  const href = cardHref(card, user);
  const dp = card.dataPump;
  return (
    <div
      className={`dash-card dash-${card.signal}${href ? ' dash-clickable' : ''}`}
      role={href ? 'link' : undefined}
      tabIndex={href ? 0 : undefined}
      onClick={() => href && (window.location.href = href)}
      onKeyDown={(e) => e.key === 'Enter' && href && (window.location.href = href)}
    >
      <div className="dash-card-head">
        <span className={`dash-light dash-light-${card.signal}`} title={SIGNAL_LABEL[card.signal]} />
        <strong>{card.dbname}</strong>
        {card.memo && <span className="oc-subtle">{card.memo}</span>}
      </div>
      <div className="dash-reason">{card.signalReason}</div>
      <dl className="dash-facts">
        <dt>최근 점검</dt>
        <dd>{card.lastRun ? `${card.lastRun.at} (${card.lastRun.trigger === 'SCHEDULED' ? '예약' : '수동'})` : '없음'}</dd>
        <dt>OPEN 이슈</dt>
        <dd>
          {card.issues.ERROR + card.issues.WARN + card.issues.other === 0 ? (
            '없음'
          ) : (
            <>
              {card.issues.ERROR > 0 && <span className="dash-pill dash-pill-ERROR">ERROR {card.issues.ERROR}</span>}
              {card.issues.WARN > 0 && <span className="dash-pill dash-pill-WARN">WARN {card.issues.WARN}</span>}
              {card.issues.other > 0 && <span className="dash-pill">기타 {card.issues.other}</span>}
            </>
          )}
          {card.issues.acknowledged > 0 && <span className="oc-subtle"> · 확인됨 {card.issues.acknowledged}</span>}
        </dd>
        <dt>예약 점검</dt>
        <dd>
          {!card.autoSchedule ? (
            <span className="oc-subtle">대상 아님</span>
          ) : card.lastScheduled ? (
            <>
              <span className={card.lastScheduled.ok ? 'dash-ok' : 'dash-bad'}>{card.lastScheduled.ok ? '성공' : '실패한 점검 있음'}</span> {card.lastScheduled.at}
            </>
          ) : (
            '기록 없음'
          )}
        </dd>
        {showDataPump && (
          <>
            <dt>Data Pump</dt>
            <dd>
              {dp.running.length > 0
                ? `진행 중 ${dp.running.length}개 (${dp.running.map((job) => job.jobName).slice(0, 2).join(', ')}${dp.running.length > 2 ? ' …' : ''})`
                : dp.latest
                  ? `최근 ${dp.latest.operation} ${dp.latest.status}${dp.latest.finishedAt ? ` · ${dp.latest.finishedAt}` : ''}`
                  : '최근 7일 없음'}
            </dd>
          </>
        )}
      </dl>
      <Links card={card} user={user} />
    </div>
  );
}

export function App(): ReactElement {
  const { user, loading } = useCurrentUser();
  const canUse = canSee(user, 'dashboard');
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getDashboard()
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '대시보드를 불러오지 못했습니다.'));
  }, []);

  useEffect(() => {
    if (!canUse) return;
    load();
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [canUse, load]);

  const s = data?.summary;
  return (
    <>
      <AppHeader active="dashboard" />
      <ToastHost />
      <h2 className="page-title">전체 DB 현황</h2>
      {!loading && !canUse && <p className="issues-empty">이 화면을 볼 권한이 없습니다.</p>}
      {error && <p className="pc-warning">{error}</p>}
      {s && (
        <div className="dash-summary">
          <div>
            <span>전체 DB</span>
            <strong>{s.total}</strong>
          </div>
          <div className={s.problem > 0 ? 'dash-summary-bad' : undefined}>
            <span>문제 DB</span>
            <strong>{s.problem}</strong>
          </div>
          <div className={s.scheduledToday.enabled && s.scheduledToday.ok < s.scheduledToday.expected ? 'dash-summary-warn' : undefined}>
            <span>오늘 예약 점검 성공</span>
            <strong>
              {s.scheduledToday.ok}/{s.scheduledToday.expected}
            </strong>
            <em>{s.scheduledToday.enabled ? `예약 ${s.scheduledToday.runTime ?? ''}` : '예약 꺼짐'}</em>
          </div>
          <div className={s.openIssues > 0 ? 'dash-summary-warn' : undefined}>
            <span>OPEN 이슈</span>
            <strong>{s.openIssues}</strong>
          </div>
          <div className="dash-updated">{new Date(data.generatedAt).toLocaleTimeString('ko-KR', { hour12: false })} 기준 · 1분마다 새로고침</div>
        </div>
      )}
      {data && data.cards.length === 0 && <p className="issues-empty">등록된 DB가 없습니다.</p>}
      <div className="dash-grid">
        {data?.cards.map((card) => <Card key={card.dbmsId} card={card} user={user} showDataPump={data.dataPumpAvailable} />)}
      </div>
    </>
  );
}
