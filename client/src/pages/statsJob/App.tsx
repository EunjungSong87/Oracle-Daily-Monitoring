import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getDbmsList, getStatsJobStatus, runStatsJob } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsRow, StatsJobRow } from '../../shared/lib/types';

const JOB_COLUMNS = ['OWNER', 'JOB_NAME', 'ENABLED', 'STATE', 'STATUS', 'ACTUAL_START_DATE', 'RUN_DURATION', 'NEXT_RUN_DATE'];

// RUN_JOB(use_current_session=FALSE)는 비동기라 호출이 바로 반환되므로, 완료 여부는
// 잡 현황을 따로 폴링해서 확인한다. 약 60초 넘게 안 끝나면 폴링을 포기한다.
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 30;

interface RunningJob {
  previousStart: string | null;
  pollCount: number;
}

// public/statsJob.html (vanilla) 포팅. 최고관리자 전용 화면 (routers/statsJobRouters.ts와 동일 기준).
export function App(): ReactElement {
  const { user, loading: userLoading } = useCurrentUser();
  const canUse = canSee(user, 'statsJob');

  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [dbmsId, setDbmsId] = useState('');
  const [jobs, setJobs] = useState<StatsJobRow[] | null>(null);
  // 버튼 렌더링용 state와, 폴링 콜백 안에서 최신 값을 읽기 위한 ref를 같이 둔다.
  const [runningJobNames, setRunningJobNames] = useState<Set<string>>(new Set());
  const runningJobsRef = useRef<Record<string, RunningJob>>({});

  const syncRunningState = useCallback(() => {
    setRunningJobNames(new Set(Object.keys(runningJobsRef.current)));
  }, []);

  useEffect(() => {
    if (!canUse) return;
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        if (rows.length > 0) setDbmsId(String(rows[0].ID));
      })
      .catch((error) => {
        console.error('Error loading dbms list:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, [canUse]);

  const checkRunningJobsCompletion = useCallback(
    (rows: StatsJobRow[]) => {
      const running = runningJobsRef.current;
      Object.keys(running).forEach((jobName) => {
        const info = running[jobName];
        info.pollCount++;
        const row = rows.find((j) => j.JOB_NAME === jobName);
        if (!row) {
          delete running[jobName];
          return;
        }
        const startedNewRun = !!row.ACTUAL_START_DATE && row.ACTUAL_START_DATE !== info.previousStart;
        const stillRunning = row.STATE === 'RUNNING';
        if (startedNewRun && !stillRunning) {
          const succeeded = row.STATUS === 'SUCCEEDED';
          showToast(`${jobName}: ${succeeded ? '실행 완료 (성공)' : `실행 완료 (${row.STATUS})`}`, succeeded ? 'success' : 'error');
          delete running[jobName];
        } else if (info.pollCount > MAX_POLLS) {
          showToast(`${jobName}: 실행 상태 확인 시간이 초과됐습니다. 새로고침해서 확인해주세요.`, 'error');
          delete running[jobName];
        }
      });
      syncRunningState();
    },
    [syncRunningState]
  );

  const loadJobStatus = useCallback(async () => {
    if (!dbmsId) return;
    try {
      const rows = await getStatsJobStatus(dbmsId);
      checkRunningJobsCompletion(rows);
      setJobs(rows);
    } catch (error) {
      console.error('Error loading job status:', error);
      showToast('통계 잡 현황 조회 실패', 'error');
    }
  }, [dbmsId, checkRunningJobsCompletion]);

  // DBMS가 바뀌면 이전 DB에서 걸어둔 실행 추적은 의미가 없으므로 정리하고 다시 조회한다.
  useEffect(() => {
    if (!dbmsId) return;
    runningJobsRef.current = {};
    syncRunningState();
    setJobs(null);
    loadJobStatus();
  }, [dbmsId, loadJobStatus, syncRunningState]);

  // 실행 중인 잡이 있는 동안만 폴링한다.
  const hasRunning = runningJobNames.size > 0;
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(loadJobStatus, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasRunning, loadJobStatus]);

  async function runJobNow(row: StatsJobRow): Promise<void> {
    const jobName = row.JOB_NAME;
    runningJobsRef.current[jobName] = { previousStart: row.ACTUAL_START_DATE ?? null, pollCount: 0 };
    syncRunningState();
    try {
      const result = await runStatsJob(dbmsId, jobName);
      if (!result.success) {
        showToast(result.message, 'error');
        delete runningJobsRef.current[jobName];
        syncRunningState();
        return;
      }
      showToast('잡을 실행했습니다. 진행 상태를 확인합니다...');
    } catch (error) {
      console.error('Error:', error);
      showToast('잡 실행 중 오류가 발생했습니다.', 'error');
      delete runningJobsRef.current[jobName];
      syncRunningState();
    }
  }

  return (
    <>
      <AppHeader active="statsJob" />
      <ToastHost />

      <h2 className="page-title">Stats Job Status (통계 잡 현황)</h2>

      {!userLoading && !canUse && <p className="issues-empty">이 화면을 사용할 권한이 없습니다. 최고관리자에게 화면 권한을 요청하세요.</p>}

      {canUse && (
        <>
          {/* 결과 그리드는 컬럼이 많아 form 카드(max-width:640px) 안에 두면 넘치므로 form 밖에 둔다. */}
          <form onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="DBMS_ID">DBMS:</label>
            <select id="DBMS_ID" required value={dbmsId} onChange={(e) => setDbmsId(e.target.value)}>
              {dbmsRows.map((row) => (
                <option key={String(row.ID)} value={String(row.ID)}>
                  {String(row.ID)} - {row.DBNAME}
                </option>
              ))}
            </select>
          </form>

          <div style={{ marginTop: 24 }}>
            <label style={{ marginBottom: 0 }}>통계 수집 잡 현황</label>
            <p className="issues-subtitle">이름에 STAT이 들어간 사용자 스케줄러 잡을 자동으로 찾습니다.</p>
            <ResultTable
              columns={JOB_COLUMNS}
              rows={jobs}
              actions={(row) => {
                const running = runningJobNames.has(row.JOB_NAME);
                return (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={running}
                    onClick={() => runJobNow(row)}
                  >
                    {running ? '실행 중...' : '지금 실행'}
                  </button>
                );
              }}
            />
          </div>
        </>
      )}
    </>
  );
}

interface ResultTableProps<T extends Record<string, unknown>> {
  columns: string[];
  rows: T[] | null;
  actions?: (row: T) => ReactElement;
}

function ResultTable<T extends Record<string, unknown>>({ columns, rows, actions }: ResultTableProps<T>): ReactElement {
  const colSpan = columns.length + (actions ? 1 : 0);
  return (
    <table className="table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column}>{column}</th>
          ))}
          {actions && <th>ACTIONS</th>}
        </tr>
      </thead>
      <tbody>
        {rows === null && (
          <tr>
            <td colSpan={colSpan}>불러오는 중...</td>
          </tr>
        )}
        {rows?.length === 0 && (
          <tr>
            <td colSpan={colSpan}>결과가 없습니다.</td>
          </tr>
        )}
        {rows?.map((row, index) => (
          <tr key={index}>
            {columns.map((column) => (
              <td key={column}>{String(row[column] ?? '')}</td>
            ))}
            {actions && <td>{actions(row)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
