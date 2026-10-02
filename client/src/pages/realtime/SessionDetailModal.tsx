import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Modal } from '../../shared/components/Modal';
import { getRealtimeSessionDetail } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { AshSummary, LiveSessionDetail, SessionDetailResult, SqlDetail, Unavailable } from '../../shared/lib/types';
import type { DetailTarget } from './AshSelectionModal';
import { formatElapsed } from './ElapsedScatter';
import { colorFor } from './waitClasses';

interface Props {
  dbmsId: string;
  target: DetailTarget | null;
  onClose: () => void;
}

function isUnavailable(value: unknown): value is Unavailable {
  return !!value && typeof value === 'object' && 'unavailable' in value;
}

function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '-';
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function perExecution(total: number | null, executions: number | null, digits = 0): string {
  if (total === null || !executions) return '-';
  return formatNumber(total / executions, digits);
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="rt-field">
      <span className="rt-field-label">{label}</span>
      <span className="rt-field-value">{children === null || children === undefined || children === '' ? '-' : children}</span>
    </div>
  );
}

const SQL_SOURCE_LABEL: Record<NonNullable<SessionDetailResult['sqlSource']>, string> = {
  CURRENT: '지금 실행 중인 SQL',
  REQUESTED: '선택한 SQL',
  PREVIOUS: '직전에 실행한 SQL',
};

// 세션 하나의 상세: 현재 상태(V$SESSION) + ASH 요약 + SQL 전문/통계(V$SQL, 없으면 AWR).
export function SessionDetailModal({ dbmsId, target, onClose }: Props): ReactElement | null {
  const [detail, setDetail] = useState<SessionDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // ASH 요약의 SQL_ID 칩을 누르면 그 SQL로 바꿔 본다.
  const [sqlOverride, setSqlOverride] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await getRealtimeSessionDetail(dbmsId, { ...target, sqlId: sqlOverride ?? target.sqlId }));
    } catch (err) {
      console.error('Error loading session detail:', err);
      setError(err instanceof Error ? err.message : '세션 상세 조회 실패');
    } finally {
      setLoading(false);
    }
  }, [dbmsId, target, sqlOverride]);

  useEffect(() => {
    setSqlOverride(null);
    setDetail(null);
  }, [target]);

  useEffect(() => {
    load();
  }, [load]);

  if (!target) return null;

  const title = `세션 상세 — SID ${target.sid}${target.serial !== null ? `, SERIAL# ${target.serial}` : ''}`;

  async function copySql(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast('SQL을 복사했습니다.');
    } catch {
      showToast('클립보드에 복사하지 못했습니다.', 'error');
    }
  }

  return (
    <Modal open onClose={onClose} title={title} wide="xl">
      <div className="modal-body">
        <div className="rt-modal-toolbar">
          <span className="rt-modal-meta">
            {target.range ? `ASH 기간: ${target.range.from} ~ ${target.range.to.slice(11)} (DB 시각)` : 'ASH 기간: 최근 10분'}
          </span>
          <button type="button" className="btn-secondary" disabled={loading} onClick={load}>
            {loading ? '조회 중...' : '새로고침'}
          </button>
        </div>

        {error && <p className="pc-warning">{error}</p>}
        {!detail && !error && <p className="oc-detail-note">조회 중...</p>}

        {detail && (
          <>
            <SessionSection session={detail.session} />
            <AshSection ash={detail.ash} activeSqlId={sqlOverride ?? target.sqlId} onPickSql={setSqlOverride} />
            <SqlSection sql={detail.sql} sqlSource={detail.sqlSource} onCopy={copySql} />
          </>
        )}
      </div>
    </Modal>
  );
}

function SessionSection({ session }: { session: LiveSessionDetail | null }): ReactElement {
  return (
    <section className="rt-detail-section">
      <h4>세션 (V$SESSION)</h4>
      {!session ? (
        <p className="oc-detail-note">이미 종료된 세션입니다. 아래는 ASH/AWR에 남은 기록입니다.</p>
      ) : (
        <div className="rt-fields">
          <Field label="상태">
            {session.status}
            {session.state && ` / ${session.state}`}
          </Field>
          <Field label="USERNAME">{session.username}</Field>
          <Field label="OS USER">{session.osuser}</Field>
          <Field label="MACHINE">{session.machine}</Field>
          <Field label="PROGRAM">{session.program}</Field>
          <Field label="MODULE / ACTION">{[session.module, session.action].filter(Boolean).join(' / ')}</Field>
          <Field label="SERVICE">{session.serviceName}</Field>
          <Field label="SPID (OS PID)">{session.spid}</Field>
          <Field label="LOGON">{session.logonTime}</Field>
          <Field label="LAST_CALL_ET">{session.lastCallEt === null ? null : formatElapsed(session.lastCallEt)}</Field>
          <Field label="EVENT">
            {session.event}
            {session.waitSec !== null && ` (${session.waitSec}초째 대기)`}
          </Field>
          <Field label="WAIT CLASS">{session.waitClass}</Field>
          <Field label="BLOCKING SESSION">
            {session.blockingSession !== null ? <span className="rt-blocker">{session.blockingSession}</span> : null}
          </Field>
          <Field label="SQL_ID (현재)">{session.sqlId}</Field>
          <Field label="SQL 실행 시작">
            {session.sqlExecStart}
            {session.sqlElapsedSec !== null && ` (${formatElapsed(session.sqlElapsedSec)}째)`}
          </Field>
          <Field label="SQL_ID (직전)">{session.prevSqlId}</Field>
          {session.clientInfo && <Field label="CLIENT INFO">{session.clientInfo}</Field>}
        </div>
      )}
    </section>
  );
}

function AshSection({
  ash,
  activeSqlId,
  onPickSql,
}: {
  ash: AshSummary | Unavailable | null;
  activeSqlId: string | null;
  onPickSql: (sqlId: string) => void;
}): ReactElement {
  return (
    <section className="rt-detail-section">
      <h4>
        ASH 요약
        {ash && !isUnavailable(ash) && (
          <span className="oc-info-tag">{ash.source === 'V$ACTIVE_SESSION_HISTORY' ? 'ASH (메모리)' : 'AWR ASH'}</span>
        )}
      </h4>
      {ash === null && <p className="oc-detail-note">이 기간에 이 세션의 ASH 샘플이 없습니다.</p>}
      {isUnavailable(ash) && (
        <p className="pc-warning">
          ASH를 조회하지 못했습니다 ({ash.unavailable}). V$ACTIVE_SESSION_HISTORY 조회 권한과 Diagnostics Pack 사용 여부를 확인하세요.
        </p>
      )}
      {ash && !isUnavailable(ash) && (
        <>
          <div className="rt-fields">
            <Field label="샘플 수">{`${ash.samples}개 (≈ 활성 ${formatElapsed(ash.samples)})`}</Field>
            <Field label="기간">{`${ash.firstSample ?? ''} ~ ${ash.lastSample?.slice(11) ?? ''}`}</Field>
            <Field label="USER / MACHINE">{[ash.username, ash.machine].filter(Boolean).join(' / ')}</Field>
            <Field label="PROGRAM / MODULE">{[ash.program, ash.module].filter(Boolean).join(' / ')}</Field>
            <Field label="BLOCKING SESSION">
              {ash.blockingSessions.length > 0
                ? ash.blockingSessions.map((sid) => (
                    <span key={sid} className="rt-blocker">
                      {sid}
                    </span>
                  ))
                : null}
            </Field>
            <Field label="실행한 SQL">
              {ash.sqlIds.length > 0
                ? ash.sqlIds.map((sqlId) => (
                    <button
                      key={sqlId}
                      type="button"
                      className={`rt-sql-chip${sqlId === activeSqlId ? ' rt-sql-chip-active' : ''}`}
                      title="이 SQL의 전문/통계 보기"
                      onClick={() => onPickSql(sqlId)}
                    >
                      {sqlId}
                    </button>
                  ))
                : null}
            </Field>
          </div>
          <div className="rt-event-bars">
            {ash.events.map((event) => (
              <div key={event.event} className="rt-event-bar">
                <span className="rt-event-name">{event.event}</span>
                <span className="rt-event-track">
                  <span
                    className="rt-event-fill"
                    style={{ width: `${(event.samples / ash.samples) * 100}%`, backgroundColor: colorFor(event.waitClass) }}
                  />
                </span>
                <span className="rt-event-count">
                  {event.samples} ({Math.round((event.samples / ash.samples) * 100)}%)
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function SqlSection({
  sql,
  sqlSource,
  onCopy,
}: {
  sql: SqlDetail | Unavailable | null;
  sqlSource: SessionDetailResult['sqlSource'];
  onCopy: (text: string) => void;
}): ReactElement {
  return (
    <section className="rt-detail-section">
      <h4>
        SQL
        {sqlSource && <span className="oc-subtle">{SQL_SOURCE_LABEL[sqlSource]}</span>}
        {sql && !isUnavailable(sql) && <span className="oc-info-tag">{sql.source === 'V$SQL' ? 'V$SQL' : 'AWR'}</span>}
      </h4>
      {sql === null && (
        <p className="oc-detail-note">
          {sqlSource ? 'V$SQL과 AWR 어디에도 이 SQL이 남아 있지 않습니다.' : '이 세션에서 볼 SQL이 없습니다.'}
        </p>
      )}
      {isUnavailable(sql) && <p className="pc-warning">SQL 정보를 조회하지 못했습니다 ({sql.unavailable}).</p>}
      {sql && !isUnavailable(sql) && (
        <>
          <div className="rt-fields">
            <Field label="SQL_ID">{sql.sqlId}</Field>
            <Field label="PLAN HASH">{sql.planHashValue}</Field>
            <Field label="PARSING SCHEMA">{sql.parsingSchema}</Field>
            <Field label="실행 횟수">{formatNumber(sql.executions)}</Field>
            <Field label="경과 (누적 / 1회 평균)">{`${formatNumber(sql.elapsedSec, 3)}초 / ${perExecution(sql.elapsedSec, sql.executions, 3)}초`}</Field>
            <Field label="CPU (누적)">{`${formatNumber(sql.cpuSec, 3)}초`}</Field>
            <Field label="BUFFER GETS (누적 / 1회)">{`${formatNumber(sql.bufferGets)} / ${perExecution(sql.bufferGets, sql.executions)}`}</Field>
            <Field label="DISK READS (누적 / 1회)">{`${formatNumber(sql.diskReads)} / ${perExecution(sql.diskReads, sql.executions)}`}</Field>
            <Field label="ROWS (누적 / 1회)">{`${formatNumber(sql.rowsProcessed)} / ${perExecution(sql.rowsProcessed, sql.executions, 1)}`}</Field>
            <Field label={sql.source === 'V$SQL' ? '최초 적재 / 마지막 실행' : 'AWR 기록 기간'}>{`${sql.firstSeen ?? '-'} ~ ${sql.lastSeen ?? '-'}`}</Field>
          </div>
          {sql.source === 'AWR' && (
            <p className="oc-hint">공유 풀(V$SQL)에서 이미 밀려나 AWR에 저장된 기록을 보여줍니다. 통계는 AWR 보관 기간 전체 합계입니다.</p>
          )}
          <div className="rt-sql-toolbar">
            <button type="button" className="btn-secondary" onClick={() => onCopy(sql.sqlText)}>
              SQL 복사
            </button>
          </div>
          <pre className="rt-sql-text">{sql.sqlText}</pre>
        </>
      )}
    </section>
  );
}
