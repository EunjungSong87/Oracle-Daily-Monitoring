import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { cancelDataPumpJob, getDataPumpHistory, getDataPumpJobs, readDataPumpLog } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DataPumpHistory, DataPumpHistoryRow, DataPumpHistoryStatus, DataPumpJob, DataPumpLog } from '../../shared/lib/types';
import { ConfirmModal } from './ConfirmModal';
import { formatBytes, formatDuration } from './helpers';

// 대상 DB에 접속해 작업 상태를 읽으므로 너무 자주 묻지 않는다. 브라우저 탭이 안 보일 때(다른 탭/최소화)는 건너뛴다.
const REFRESH_MS = 15000;

function whenVisible(load: () => void): () => void {
  return () => {
    if (!document.hidden) load();
  };
}

// 지난 시간 / 남은 시간 / 끝날 예상 시각. 진행률·남은 시간은 Data Pump가 V$SESSION_LONGOPS에 남기는 값만 읽는다
// (작업에 ATTACH하지 않음 — 락/부하 방지). LONGOPS를 안 남기는 버전/에디션이거나 작업 초반이면 비어 있다.
function TimeCell({ job }: { job: DataPumpJob }): ReactElement {
  if (job.elapsedSec === null && job.remainingSec === null) {
    return <span className="oc-none">{job.state === 'EXECUTING' ? '계산 중' : '-'}</span>;
  }
  const finishAt = job.remainingSec !== null && job.remainingSec > 0 ? new Date(Date.now() + job.remainingSec * 1000) : null;
  return (
    <div className="dp-time-cell">
      <div>지남 {formatDuration(job.elapsedSec)}</div>
      {job.remainingSec !== null ? (
        <div>
          <strong>남음 약 {formatDuration(job.remainingSec)}</strong>
        </div>
      ) : (
        job.state === 'EXECUTING' && (
          <div
            className="dp-hint-line"
            title="진행률은 Data Pump가 V$SESSION_LONGOPS에 남기는 값으로만 봅니다 (작업에 붙지 않아 부하/락 없음). 작업 초반이거나 LONGOPS를 남기지 않는 버전·에디션이면 비어 있습니다."
          >
            남은 시간 정보 없음
          </div>
        )
      )}
      {finishAt && (
        <div className="dp-hint-line">끝날 예상 {finishAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
      )}
    </div>
  );
}

// 실행 후 대조 결과: 계획 대상 vs 로그의 exported/imported 줄 (+ import는 export 행 수). 확인하고 뺀 항목도 함께.
function VerifyBadge({ row }: { row: DataPumpHistoryRow }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const detail = row.verifyDetail;
  const ack = row.acknowledged;
  if (!row.verifyStatus && !ack) return null;
  const count = detail ? detail.notInLog.length + detail.notInPlan.length + detail.rowDiffs.length : 0;
  const label =
    row.verifyStatus === 'MATCH' ? '대조: 일치' : row.verifyStatus === 'MISMATCH' ? `대조: 불일치 ${count}개` : row.verifyStatus === 'NA' ? '대조: 판단 불가' : null;
  return (
    <div className="dp-verify">
      {label && (
        <button type="button" className={`oc-link dp-verify-${row.verifyStatus}`} onClick={() => setOpen(!open)}>
          {label}
        </button>
      )}
      {ack && (ack.missing.length > 0 || ack.filteredOut.length > 0) && (
        <div className="dp-hint-line">
          확인 후 제외: DB에 없음 {ack.missing.length}개 · 필터 {ack.filteredOut.length}개{ack.by ? ` (${ack.by})` : ''}
        </div>
      )}
      {open && detail && (
        <div className="dp-verify-detail">
          {detail.notInLog.length > 0 && <div>계획에 있는데 로그에 없음: {detail.notInLog.join(', ')}</div>}
          {detail.skipped.length > 0 && <div>TABLE_EXISTS_ACTION=SKIP으로 건너뜀: {detail.skipped.join(', ')}</div>}
          {detail.notInPlan.length > 0 && <div>로그에 있는데 계획에 없음: {detail.notInPlan.join(', ')}</div>}
          {detail.rowDiffs.length > 0 && <div>행 수 차이: {detail.rowDiffs.join(', ')}</div>}
          {ack && ack.missing.length > 0 && <div>확인하고 뺀 항목(DB에 없음): {ack.missing.join(', ')}</div>}
          {ack && ack.filteredOut.length > 0 && <div>확인하고 뺀 항목(필터): {ack.filteredOut.join(', ')}</div>}
        </div>
      )}
    </div>
  );
}

// 여러 스키마 테이블 작업은 화면 실행 때 스키마별 하위 작업(<작업 이름>_S1, _S2…)으로 나뉜다 — 목록에서는 한 묶음으로 보여 준다.
const SUB_JOB = /^(.+)_S\d+$/;

function bundleBy<T>(items: T[], name: (item: T) => string): { key: string; items: T[] }[] {
  const bundles: { key: string; items: T[] }[] = [];
  for (const item of items) {
    const key = name(item).match(SUB_JOB)?.[1] ?? name(item);
    const found = bundles.find((bundle) => bundle.key === key);
    if (found) found.items.push(item);
    else bundles.push({ key, items: [item] });
  }
  return bundles;
}

// 묶음의 결과: 하나라도 돌고 있으면 실행 중, 아니면 가장 나쁜 결과
const STATUS_ORDER: DataPumpHistoryStatus[] = ['RUNNING', 'FAILED', 'CANCELLED', 'UNKNOWN', 'COMPLETED_WITH_ERRORS', 'COMPLETED'];

function combineHistory(key: string, rows: DataPumpHistoryRow[]): DataPumpHistoryRow {
  const status = STATUS_ORDER.find((candidate) => rows.some((row) => row.status === candidate)) ?? 'UNKNOWN';
  const numbers = (pick: (row: DataPumpHistoryRow) => number | null) => rows.map(pick).filter((value): value is number => value !== null);
  const sum = (values: number[]) => (values.length > 0 ? values.reduce((total, value) => total + value, 0) : null);
  const elapsed = numbers((row) => row.elapsedSec);
  return {
    ...rows[0],
    jobName: key,
    status,
    targetDesc: `스키마별 ${rows.length}개: ${rows.map((row) => (row.targetDesc ?? '').replace(/^\[[^\]]*\] /, '')).join(' · ')}`,
    parallel: sum(numbers((row) => row.parallel)),
    elapsedSec: status === 'RUNNING' || elapsed.length === 0 ? null : Math.max(...elapsed),
    finishedAt: status === 'RUNNING' ? null : rows.map((row) => row.finishedAt ?? '').sort().pop() || null,
    errorCount: sum(numbers((row) => row.errorCount)),
    dumpBytes: sum(numbers((row) => row.dumpBytes)),
    estimatedBytes: sum(numbers((row) => row.estimatedBytes)),
    resultMessage: rows.map((row) => `${row.jobName}: ${row.resultMessage ?? STATUS_LABEL[row.status]}`).join('\n'),
  };
}

function combineJobs(key: string, jobs: DataPumpJob[]): DataPumpJob {
  const done = jobs.reduce((total, job) => total + (job.doneMb ?? 0), 0);
  const total = jobs.every((job) => job.totalMb !== null) ? jobs.reduce((sum, job) => sum + (job.totalMb ?? 0), 0) : null;
  const max = (values: (number | null)[]) => (values.some((value) => value !== null) ? Math.max(...values.map((value) => value ?? 0)) : null);
  return {
    ...jobs[0],
    jobName: key,
    state: jobs.some((job) => job.state === 'EXECUTING') ? 'EXECUTING' : jobs[0].state,
    degree: jobs.reduce((sum, job) => sum + (Number(job.degree) || 0), 0),
    doneMb: done,
    totalMb: total,
    progressPct: total ? Math.round((done / total) * 1000) / 10 : null,
    elapsedSec: max(jobs.map((job) => job.elapsedSec)),
    remainingSec: max(jobs.map((job) => job.remainingSec)),
  };
}

interface LogTarget {
  jobName: string;
  directory: string;
  logfile: string;
}

// 로그 파일은 DB 서버 DIRECTORY에 있어서 서버가 BFILE로 읽어 온다. 작업이 도는 동안은 15초마다 새로 읽는다.
function LogModal({ dbmsId, target, running, onClose }: { dbmsId: string; target: LogTarget | null; running: boolean; onClose: () => void }): ReactElement | null {
  const [log, setLog] = useState<DataPumpLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!target) return;
    try {
      setLog(await readDataPumpLog(dbmsId, target.directory, target.logfile));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그를 읽지 못했습니다.');
    }
  }, [dbmsId, target]);

  useEffect(() => {
    setLog(null);
    load();
    if (!running) return;
    const timer = window.setInterval(whenVisible(load), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, running]);

  if (!target) return null;
  return (
    <Modal open onClose={onClose} title={`로그 — ${target.jobName}`} wide="xl">
      <div className="modal-body">
        <div className="rt-modal-toolbar">
          <span className="rt-modal-meta">
            {target.directory}/{target.logfile}
            {running && ' · 실행 중이라 15초마다 새로 읽습니다'}
            {log?.truncated && ' · 파일이 커서 끝부분만 표시'}
          </span>
          <button type="button" className="btn-secondary" onClick={load}>
            새로고침
          </button>
        </div>
        {error && <p className="pc-warning">{error}</p>}
        {log && !log.exists && <p className="oc-detail-note">로그 파일이 아직 없습니다 (작업이 막 시작했거나 파일 이름이 다름).</p>}
        {log?.exists && <pre className="rt-sql-text dp-log">{log.text || '(비어 있음)'}</pre>}
        {!log && !error && <p className="oc-detail-note">읽는 중...</p>}
      </div>
    </Modal>
  );
}

interface Props {
  dbmsId: string;
  dbname: string; // 외부 작업 취소 확인용
  directories: string[]; // 로그 위치를 모를 때 직접 고르는 DIRECTORY 목록
}

// 작업 행의 "앱에서 시작 / 외부(직접 실행)" 배지와 실행자
function SourceCell({ job }: { job: DataPumpJob }): ReactElement {
  const runner = job.runner;
  return (
    <div className="dp-hint-line">
      <span className={`issue-badge ${job.source === 'EXTERNAL' ? 'oc-badge-DIFF' : 'oc-badge-SAME'}`}>{job.source === 'EXTERNAL' ? '외부(직접 실행)' : '앱에서 시작'}</span>
      {runner && (
        <span title={runner.program ?? ''}>
          {' '}
          {runner.username ?? '?'} · {runner.osuser ?? '?'}@{runner.machine ?? '?'}
        </span>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<DataPumpHistoryStatus, string> = {
  RUNNING: '실행 중',
  COMPLETED: '성공',
  COMPLETED_WITH_ERRORS: '에러 있음',
  FAILED: '실패',
  CANCELLED: '취소',
  UNKNOWN: '확인 불가',
};

const STATUS_BADGE: Record<DataPumpHistoryStatus, string> = {
  RUNNING: 'oc-badge-ONLY_SOURCE',
  COMPLETED: 'oc-badge-SAME',
  COMPLETED_WITH_ERRORS: 'oc-badge-DIFF',
  FAILED: 'oc-badge-ONLY_TARGET',
  CANCELLED: 'oc-badge-DIFF',
  UNKNOWN: 'oc-badge-DIFF',
};

export function JobsTab({ dbmsId, dbname, directories }: Props): ReactElement {
  // 로그 위치를 모르는 작업(NOLOGFILE, 마스터 테이블을 못 읽음)은 DIRECTORY와 파일 이름을 직접 입력해서 연다
  const [manualLog, setManualLog] = useState<{ jobName: string; directory: string; logfile: string } | null>(null);
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'APP' | 'EXTERNAL'>('ALL');
  const [jobs, setJobs] = useState<DataPumpJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<DataPumpHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);
  const [cancelTarget, setCancelTarget] = useState<DataPumpJob[] | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setJobs(await getDataPumpJobs(dbmsId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '작업 목록을 읽지 못했습니다.');
    }
  }, [dbmsId]);

  // 이력 조회는 서버가 끝난 작업의 로그를 읽어 결과를 채우는 일까지 하므로 주기적으로가 아니라,
  // 처음 열 때와 실행 중 작업 목록이 바뀔 때(작업이 시작/종료됨)만 다시 읽는다.
  const loadHistory = useCallback(async () => {
    try {
      setHistory(await getDataPumpHistory(dbmsId));
      setHistoryError(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : '작업 이력을 읽지 못했습니다.');
    }
  }, [dbmsId]);

  useEffect(() => {
    setJobs(null);
    load();
    const timer = window.setInterval(whenVisible(load), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const runningKey = jobs === null ? null : jobs.map((job) => `${job.owner}.${job.jobName}`).sort().join(',');
  useEffect(() => {
    if (runningKey !== null) loadHistory();
  }, [runningKey, loadHistory]);

  const runningNames = new Set((jobs ?? []).map((job) => job.jobName));

  async function cancel(typedDbname: string): Promise<void> {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      // 스키마별로 나눠 실행한 묶음은 한꺼번에 취소한다.
      for (const job of cancelTarget) await cancelDataPumpJob(dbmsId, job.owner, job.jobName, job.source === 'EXTERNAL' ? typedDbname : undefined);
      showToast(`${cancelTarget.map((job) => job.jobName).join(', ')} 작업을 취소했습니다.`);
      setCancelTarget(null);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '작업을 취소하지 못했습니다.', 'error');
    } finally {
      setCancelling(false);
    }
  }

  // 로그 위치는 작업 이력에서 찾는다 (이 화면 밖에서 시작한 작업은 모름).
  // 로그 위치: 이력(앱 작업) → 마스터 테이블(외부 작업, 서버가 채움) → 둘 다 없으면 직접 입력
  function openLog(job: DataPumpJob): void {
    const known = history?.rows.find((row) => row.jobName === job.jobName && (row.jobOwner ?? '') === job.owner && row.logfile);
    if (known) {
      setLogTarget({ jobName: job.jobName, directory: known.directory, logfile: known.logfile });
      return;
    }
    if (job.logDirectory && job.logFile) {
      setLogTarget({ jobName: job.jobName, directory: job.logDirectory, logfile: job.logFile });
      return;
    }
    setManualLog({ jobName: job.jobName, directory: directories.includes('DATA_PUMP_DIR') ? 'DATA_PUMP_DIR' : (directories[0] ?? ''), logfile: '' });
  }

  type RowKind = 'single' | 'group' | 'sub';

  function renderJob(job: DataPumpJob, kind: RowKind, members?: DataPumpJob[]): ReactElement {
    return (
        <tr key={`${kind}:${job.owner}.${job.jobName}`} className={kind === 'sub' ? 'dp-sub-row' : undefined}>
          <td className="oc-name">
            {kind === 'sub' ? '└ ' : ''}
            {job.owner}.{job.jobName}
            {kind === 'group' && <div className="dp-hint-line">스키마별 작업 {members?.length}개 묶음</div>}
          </td>
          <td>
            {job.operation} / {job.jobMode}
            {kind !== 'sub' && <SourceCell job={job} />}
            {job.noLogfile && kind !== 'group' && <div className="dp-hint-line">로그 없음 (직접 입력해서 열기)</div>}
          </td>
          <td>
            <span className={`issue-badge ${job.state === 'EXECUTING' ? 'oc-badge-SAME' : 'oc-badge-DIFF'}`}>{job.state}</span>
          </td>
          <td>
            {job.progressPct !== null ? (
              <>
                <div className="dp-progress-cell">
                  <span className="rt-event-track">
                    <span className="rt-event-fill dp-progress-fill" style={{ width: `${Math.min(100, job.progressPct)}%` }} />
                  </span>
                  <span>{job.progressPct}%</span>
                </div>
                {job.totalMb !== null && (
                  <div className="dp-hint-line">
                    {formatBytes((job.doneMb ?? 0) * 1024 * 1024)} / {formatBytes(job.totalMb * 1024 * 1024)}
                  </div>
                )}
              </>
            ) : (
              <span className="oc-none">-</span>
            )}
          </td>
          <td>
            <TimeCell job={job} />
          </td>
          <td>{job.degree}</td>
          <td className="dp-actions">
            {kind !== 'group' && (
              <button type="button" className="btn-secondary" onClick={() => openLog(job)}>
                로그
              </button>
            )}
            {kind !== 'sub' && (
              <button type="button" className="btn-danger" onClick={() => setCancelTarget(members ?? [job])}>
                취소
              </button>
            )}
          </td>
        </tr>
    );
  }

  function renderHistory(row: DataPumpHistoryRow, kind: RowKind): ReactElement {
    return (
        <tr key={`${kind}:${row.id}`} className={kind === 'sub' ? 'dp-sub-row' : undefined}>
          <td className="dp-nowrap">{row.startedAt}</td>
          <td>
            <div className="oc-name">
              {kind === 'sub' ? '└ ' : ''}
              {row.jobName}
            </div>
            <div className="dp-hint-line">
              {row.operation} / {row.jobMode}
              {row.parallel && row.parallel > 1 ? ` · PARALLEL ${row.parallel}` : ''}
              {row.tableExistsAction ? ` · ${row.tableExistsAction}` : ''}
            </div>
          </td>
          <td className="dp-target-cell" title={row.targetDesc ?? ''}>
            {row.targetDesc}
          </td>
          <td>
            {row.startedBy ?? '-'}
            {row.source === 'EXTERNAL' && (
              <div className="dp-hint-line" title={row.runner?.program ?? ''}>
                <span className="issue-badge oc-badge-DIFF">외부</span> {row.runner?.osuser ?? '?'}@{row.runner?.machine ?? '?'}
              </div>
            )}
            {row.cancelledBy && <div className="dp-hint-line">취소: {row.cancelledBy}</div>}
          </td>
          <td title={row.resultMessage ?? ''}>
            <span className={`issue-badge ${STATUS_BADGE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
            {row.status === 'COMPLETED_WITH_ERRORS' && row.errorCount !== null && <div className="dp-hint-line">에러 {row.errorCount}개</div>}
            {row.errorSummary && <div className="dp-hint-line dp-error-summary" title={row.errorSummary}>{row.errorSummary}</div>}
            <VerifyBadge row={row} />
          </td>
          <td className="dp-nowrap">
            {row.status === 'RUNNING' ? <span className="oc-none">진행 중</span> : formatDuration(row.elapsedSec)}
            {row.finishedAt && <div className="dp-hint-line">끝 {row.finishedAt.slice(11)}</div>}
          </td>
          <td className="dp-nowrap">
            {row.dumpBytes !== null ? (
              <div>덤프 {formatBytes(row.dumpBytes)}</div>
            ) : (
              row.estimatedBytes === null && <span className="oc-none">-</span>
            )}
            {row.estimatedBytes !== null && <div className="dp-hint-line">예상 {formatBytes(row.estimatedBytes)}</div>}
          </td>
          <td className="dp-actions">
            {kind !== 'group' && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                row.logfile
                  ? setLogTarget({ jobName: row.jobName, directory: row.directory, logfile: row.logfile })
                  : setManualLog({ jobName: row.jobName, directory: row.directory || directories[0] || '', logfile: '' })
              }
            >
              로그
            </button>
            )}
          </td>
        </tr>
    );
  }

  return (
    <>
      <div className="rt-panel">
        <div className="rt-panel-header">
          <h3>
            DB에서 실행 중인 Data Pump 작업 <span className="oc-subtle">DBA_DATAPUMP_JOBS · 15초마다 갱신</span>
          </h3>
          <button type="button" className="btn-secondary" onClick={load}>
            새로고침
          </button>
        </div>
        {error && <p className="pc-warning">{error}</p>}
        {jobs && jobs.length === 0 && <p className="issues-empty">지금 실행 중이거나 멈춰 있는 Data Pump 작업이 없습니다.</p>}
        {jobs && jobs.length > 0 && (
          <table className="table oc-items-table">
            <thead>
              <tr>
                <th>작업</th>
                <th>종류</th>
                <th>상태</th>
                <th>진행률</th>
                <th>시간</th>
                <th>PARALLEL</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bundleBy(jobs, (job) => job.jobName).flatMap(({ key, items }) =>
                items.length === 1 ? [renderJob(items[0], 'single')] : [renderJob(combineJobs(key, items), 'group', items), ...items.map((job) => renderJob(job, 'sub'))]
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="rt-panel">
        <div className="rt-panel-header">
          <h3>
            작업 이력 <span className="oc-subtle">앱에서 시작한 작업 + 감시 중 발견한 외부 작업 · 최근 100개 · 끝난 작업도 로그를 볼 수 있습니다</span>
          </h3>
          <div className="rt-panel-controls">
            <select aria-label="이력 필터" value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value as typeof historyFilter)}>
              <option value="ALL">전체</option>
              <option value="APP">앱에서 시작</option>
              <option value="EXTERNAL">외부(직접 실행)</option>
            </select>
            <button type="button" className="btn-secondary" onClick={loadHistory}>
              새로고침
            </button>
          </div>
        </div>
        {historyError && <p className="pc-warning">{historyError}</p>}
        {history && !history.available && (
          <p className="pc-warning">작업 이력 테이블이 없습니다. 메타데이터 DB에 scripts/add_datapump_history.sql을 실행하세요.</p>
        )}
        {history?.available && history.rows.length === 0 && <p className="issues-empty">아직 이 DB에서 시작한 작업이 없습니다.</p>}
        {history?.available && history.rows.length > 0 && (
          <table className="table oc-items-table">
            <thead>
              <tr>
                <th>시작</th>
                <th>작업</th>
                <th>대상</th>
                <th>시작한 사람</th>
                <th>결과</th>
                <th>수행 시간</th>
                <th>크기</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bundleBy(
                history.rows.filter((row) => historyFilter === 'ALL' || (row.source ?? 'APP') === historyFilter),
                (row) => row.jobName
              ).flatMap(({ key, items }) =>
                items.length === 1 ? [renderHistory(items[0], 'single')] : [renderHistory(combineHistory(key, items), 'group'), ...items.map((row) => renderHistory(row, 'sub'))]
              )}
            </tbody>
          </table>
        )}
      </div>

      <LogModal dbmsId={dbmsId} target={logTarget} running={!!logTarget && runningNames.has(logTarget.jobName)} onClose={() => setLogTarget(null)} />
      <ConfirmModal
        open={!!cancelTarget}
        title="작업 취소"
        confirmLabel="작업 취소"
        danger
        busy={cancelling}
        requireText={cancelTarget?.some((job) => job.source === 'EXTERNAL') ? dbname : null}
        onConfirm={cancel}
        onClose={() => setCancelTarget(null)}
      >
        <p>
          <strong>{cancelTarget?.map((job) => `${job.owner}.${job.jobName}`).join(', ')}</strong>
          을(를) 즉시 중지하고 작업을 지웁니다. 다시 이어서 실행할 수 없습니다.
        </p>
        {cancelTarget?.some((job) => job.source === 'EXTERNAL') && (
          <div className="pc-warning">
            <strong>앱 밖에서 직접 실행한 작업입니다</strong> — 다른 사람이 돌리는 마이그레이션일 수 있습니다.
            {cancelTarget
              .filter((job) => job.source === 'EXTERNAL')
              .map((job) => (
                <div key={job.jobName}>
                  {job.jobName}: 실행 계정 {job.runner?.username ?? '?'} · OS 사용자 {job.runner?.osuser ?? '?'} · MACHINE {job.runner?.machine ?? '?'}
                  {job.runner?.program ? ` · ${job.runner.program}` : ''}
                </div>
              ))}
          </div>
        )}
        <p className="oc-hint">Import 도중에 취소하면 이미 들어간 데이터/오브젝트는 그대로 남습니다.</p>
      </ConfirmModal>
      <ConfirmModal
        open={!!manualLog}
        title={`로그 열기 — ${manualLog?.jobName ?? ''}`}
        confirmLabel="열기"
        onConfirm={() => {
          if (!manualLog?.logfile.trim()) return;
          setLogTarget({ jobName: manualLog.jobName, directory: manualLog.directory, logfile: manualLog.logfile.trim() });
          setManualLog(null);
        }}
        onClose={() => setManualLog(null)}
      >
        <p className="oc-hint">이 작업의 로그 위치를 알 수 없습니다 (NOLOGFILE이거나 마스터 테이블을 읽지 못함). DIRECTORY와 로그 파일 이름을 직접 입력하세요.</p>
        <label htmlFor="dp-manual-dir">DIRECTORY</label>
        <select id="dp-manual-dir" value={manualLog?.directory ?? ''} onChange={(e) => manualLog && setManualLog({ ...manualLog, directory: e.target.value })}>
          {directories.map((dir) => (
            <option key={dir} value={dir}>
              {dir}
            </option>
          ))}
        </select>
        <label htmlFor="dp-manual-file">로그 파일 이름</label>
        <input id="dp-manual-file" type="text" placeholder="예: exp_20261022.log" value={manualLog?.logfile ?? ''} onChange={(e) => manualLog && setManualLog({ ...manualLog, logfile: e.target.value })} />
      </ConfirmModal>
    </>
  );
}
