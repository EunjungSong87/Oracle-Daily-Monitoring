import { useEffect, useState, type ReactElement } from 'react';
import { ConfirmModal } from '../dataPump/ConfirmModal';
import { useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { killRealtimeSession } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { BlockingNode, BlockingSnapshot, Unavailable } from '../../shared/lib/types';

// Blocking 체인 트리: 최상위 블로커 → 대기자들. 데이터는 실시간 폴링(/api/realtime/sessions)에 같이 실려 온다 — 따로 조회하지 않는다.
// 최상위 블로커가 N초 이상 막고 있으면 강조. Kill은 SUPER_ADMIN만 (서버도 막는다).

const DEFAULT_ALERT_SEC = 60;
const ALERT_KEY = 'rt-blocking-alert-sec';

function readAlertSec(): number {
  try {
    const value = Number(localStorage.getItem(ALERT_KEY));
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_ALERT_SEC;
  } catch {
    return DEFAULT_ALERT_SEC;
  }
}

function formatSec(sec: number | null): string {
  if (sec === null) return '-';
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}분 ${sec % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

interface Props {
  dbmsId: string;
  dbname: string;
  blocking: BlockingSnapshot | Unavailable | null;
  onOpenDetail: (sid: number, serial: number) => void;
}

export function BlockingPanel({ dbmsId, dbname, blocking, onOpenDetail }: Props): ReactElement {
  const { user } = useCurrentUser();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const [alertSec, setAlertSec] = useState(readAlertSec);
  const [killTarget, setKillTarget] = useState<BlockingNode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(ALERT_KEY, String(alertSec));
    } catch {
      // 저장 못 해도 이번 화면에서는 동작
    }
  }, [alertSec]);

  const snapshot = blocking && 'roots' in blocking ? blocking : null;

  async function kill(typed: string): Promise<void> {
    if (!killTarget) return;
    setBusy(true);
    try {
      await killRealtimeSession(dbmsId, { instId: killTarget.instId, sid: killTarget.sid, serial: killTarget.serial }, typed);
      showToast(`세션 ${killTarget.sid},${killTarget.serial},@${killTarget.instId}을(를) Kill했습니다.`);
      setKillTarget(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Kill하지 못했습니다.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function killCell(node: BlockingNode): ReactElement | null {
    if (!isSuperAdmin) return null;
    const noPriv = snapshot?.canKill === false;
    const reason = node.killDisabled ?? (noPriv ? '권한 없음' : null);
    return (
      <button
        type="button"
        className="btn-danger rt-kill-btn"
        disabled={reason !== null}
        title={reason ?? 'ALTER SYSTEM KILL SESSION ... IMMEDIATE'}
        onClick={(e) => {
          e.stopPropagation();
          setKillTarget(node);
        }}
      >
        {noPriv && !node.killDisabled ? '권한 없음' : 'Kill'}
      </button>
    );
  }

  function rows(node: BlockingNode, depth: number, rootAlert: boolean): ReactElement[] {
    const own = (
      <tr
        key={`${node.instId}:${node.sid}:${depth}`}
        className={`rt-session-row${depth === 0 ? ' rt-blocker-row' : ''}${depth === 0 && rootAlert ? ' rt-blocker-alert' : ''}`}
        title="더블클릭하면 세션 상세 / SQL"
        onDoubleClick={() => onOpenDetail(node.sid, node.serial)}
      >
        <td style={{ paddingLeft: `${8 + depth * 20}px`, whiteSpace: 'nowrap' }}>
          {depth > 0 ? '└ ' : ''}
          {node.sid}
        </td>
        <td>{node.serial}</td>
        <td>{node.instId}</td>
        <td>{node.username ?? ''}</td>
        <td>{node.machine ?? ''}</td>
        <td>{node.program ?? ''}</td>
        <td>{node.sqlId ?? ''}</td>
        <td>{node.event ?? ''}</td>
        <td>{depth === 0 ? (node.waitSec !== null ? formatSec(node.waitSec) : `막는 중 ${formatSec((node as { blockedSec?: number }).blockedSec ?? null)}`) : formatSec(node.waitSec)}</td>
        <td>{node.objectName ?? (node.rowWaitObj !== null && depth > 0 ? `obj# ${node.rowWaitObj}` : '')}</td>
        {isSuperAdmin && <td>{killCell(node)}</td>}
      </tr>
    );
    return [own, ...node.waiters.flatMap((w) => rows(w, depth + 1, rootAlert))];
  }

  const alertCount = snapshot ? snapshot.roots.filter((root) => root.blockedSec >= alertSec).length : 0;

  return (
    <div className="rt-panel">
      <div className="rt-panel-header">
        <h3>
          Blocking 체인{' '}
          {snapshot && snapshot.roots.length > 0 && (
            <span className={alertCount > 0 ? 'dash-bad' : undefined}>
              (최상위 블로커 {snapshot.roots.length}
              {alertCount > 0 ? `, ${alertSec}초 이상 ${alertCount}` : ''})
            </span>
          )}
        </h3>
        <div className="rt-panel-controls">
          <label htmlFor="rt-blocking-alert" style={{ margin: 0 }}>
            강조 기준(초)
          </label>
          <input
            id="rt-blocking-alert"
            type="number"
            min={1}
            style={{ width: 80 }}
            value={alertSec}
            onChange={(e) => setAlertSec(Math.max(1, Number(e.target.value) || DEFAULT_ALERT_SEC))}
          />
        </div>
      </div>
      {blocking && 'unavailable' in blocking && <p className="pc-warning">Blocking 정보를 읽지 못했습니다 (GV$SESSION 권한 확인): {blocking.unavailable}</p>}
      {snapshot && snapshot.roots.length === 0 && <p className="issues-empty">지금 블로킹이 없습니다.</p>}
      {snapshot?.truncated && <p className="pc-warning">대기 세션이 많아 500개까지만 보여 줍니다.</p>}
      {snapshot && snapshot.roots.length > 0 && (
        <table className="table" style={{ width: '100%', maxWidth: 'none', margin: 0 }}>
          <thead>
            <tr>
              <th>SID</th>
              <th>SERIAL#</th>
              <th>INST_ID</th>
              <th>USERNAME</th>
              <th>MACHINE</th>
              <th>PROGRAM</th>
              <th>SQL_ID</th>
              <th>EVENT</th>
              <th>대기 시간</th>
              <th>잠긴 오브젝트</th>
              {isSuperAdmin && <th>Kill</th>}
            </tr>
          </thead>
          <tbody>{snapshot.roots.flatMap((root) => rows(root, 0, root.blockedSec >= alertSec))}</tbody>
        </table>
      )}
      <ConfirmModal
        open={killTarget !== null}
        title="세션 Kill"
        confirmLabel="Kill"
        danger
        requireText={dbname}
        busy={busy}
        onConfirm={kill}
        onClose={() => !busy && setKillTarget(null)}
      >
        {killTarget && (
          <>
            <p>
              아래 세션을 <strong>ALTER SYSTEM KILL SESSION '{killTarget.sid},{killTarget.serial},@{killTarget.instId}' IMMEDIATE</strong>로 끊습니다. 진행 중인 트랜잭션은 롤백됩니다.
            </p>
            <dl className="dash-facts">
              <dt>DB</dt>
              <dd>{dbname}</dd>
              <dt>SID / SERIAL# / INST_ID</dt>
              <dd>
                {killTarget.sid} / {killTarget.serial} / {killTarget.instId}
              </dd>
              <dt>USERNAME</dt>
              <dd>{killTarget.username ?? '-'}</dd>
              <dt>MACHINE</dt>
              <dd>{killTarget.machine ?? '-'}</dd>
              <dt>PROGRAM</dt>
              <dd>{killTarget.program ?? '-'}</dd>
              <dt>SQL_ID</dt>
              <dd>{killTarget.sqlId ?? '-'}</dd>
              <dt>EVENT</dt>
              <dd>{killTarget.event ?? '-'}</dd>
            </dl>
          </>
        )}
      </ConfirmModal>
    </div>
  );
}
