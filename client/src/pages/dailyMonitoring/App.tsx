import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { MonitoringResultTable } from '../../shared/components/MonitoringResultTable';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getDbmsList, runMonResult } from '../../shared/lib/api';
import { urlParam } from '../../shared/lib/urlParams';
import {
  chooseDownloadFolder,
  getSavedDownloadDirHandle,
  isFileSystemAccessSupported,
  saveHtmlToFolder,
} from '../../shared/lib/downloadFolder';
import { showToast } from '../../shared/lib/toastStore';
import type { DbConfig, DbmsListResponse, MonitoringTaskResult } from '../../shared/lib/types';
import { DbmsListTable } from './DbmsListTable';
import { ScheduleSettings } from './ScheduleSettings';

// 새로고침/다른 페이지 이동 후 돌아와도 실행 결과 탭이 사라지지 않도록, public/dailyMonitoring.html의
// vanilla 버전과 동일한 sessionStorage 키를 그대로 사용한다.
const RESULT_TABS_KEY = 'dailyMonitoringResultTabs';

interface ResultTabEntry {
  dbname: string;
  results: MonitoringTaskResult[];
  // 점검 자체가 실패(대상 DB 접속 실패 등)했을 때의 사유 — 있으면 결과 대신 이걸 보여 준다
  error?: string;
  dbmsId?: string;
  ranAt?: string;
}

function loadStoredResultTabs(): ResultTabEntry[] {
  try {
    return JSON.parse(sessionStorage.getItem(RESULT_TABS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveStoredResultTabs(tabs: ResultTabEntry[]): void {
  try {
    sessionStorage.setItem(RESULT_TABS_KEY, JSON.stringify(tabs));
  } catch {
    // 저장 공간 부족/차단 — 탭 유지만 안 될 뿐 화면은 정상
  }
}

function nowLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type TabStatus = 'running' | 'fail' | 'warn' | 'ok';

function tabStatus(tab: ResultTabEntry | undefined, isRunning: boolean): TabStatus {
  if (isRunning) return 'running';
  if (tab?.error) return 'fail';
  if (tab && tab.results.some((r) => !r.success)) return 'warn';
  return 'ok';
}

const TAB_STATUS_LABEL: Record<TabStatus, string> = { running: '점검 실행 중', fail: '점검 실패', warn: '실행 실패한 스크립트 있음', ok: '실행 완료' };

export function App(): ReactElement {
  const { user } = useCurrentUser();
  const [dbmsData, setDbmsData] = useState<DbmsListResponse | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState('tab1');
  const [resultTabs, setResultTabs] = useState<ResultTabEntry[]>(() => loadStoredResultTabs());
  const [downloadFolderLabel, setDownloadFolderLabel] = useState('');
  // 지금 점검이 돌고 있는 DB 이름 (탭에 진행 표시, 같은 DB 중복 실행 방지)
  const [running, setRunning] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    getDbmsList()
      .then((data) => {
        setDbmsData(data);
        // ?dbms=로 넘어오면 그 DB만 체크
        const wanted = urlParam('dbms');
        const defaultChecked = new Set(
          wanted && data.rows.some((row) => String(row.ID) === wanted)
            ? [wanted]
            : data.rows.filter((row) => row.AUTO_SCHEDULE === 'Y').map((row) => String(row.ID))
        );
        setCheckedIds(defaultChecked);
      })
      .catch((error) => {
        console.error('Error fetching dbms list:', error);
        showToast('DB 목록 조회 실패', 'error');
      });
  }, []);

  useEffect(() => {
    refreshDownloadFolderLabel();
  }, []);

  async function refreshDownloadFolderLabel(): Promise<void> {
    if (!isFileSystemAccessSupported()) {
      setDownloadFolderLabel('(이 브라우저는 미지원)');
      return;
    }
    const handle = await getSavedDownloadDirHandle();
    setDownloadFolderLabel(handle ? `저장 위치: ${handle.name}` : '(미설정 — 기본 다운로드 폴더 사용)');
  }

  async function handleChooseDownloadFolder(): Promise<void> {
    if (!isFileSystemAccessSupported()) {
      showToast('이 브라우저는 다운로드 폴더 지정을 지원하지 않습니다 (Chrome/Edge 권장)', 'error');
      return;
    }
    try {
      const handle = await chooseDownloadFolder();
      if (!handle) return;
      showToast(`다운로드 위치가 "${handle.name}"(으)로 설정되었습니다`);
      refreshDownloadFolderLabel();
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') {
        console.error('폴더 선택 실패:', err);
        showToast('다운로드 위치 설정 실패', 'error');
      }
    }
  }

  function toggleRow(id: string): void {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function checkAll(): void {
    if (!dbmsData) return;
    setCheckedIds(new Set(dbmsData.rows.map((row) => String(row.ID))));
  }

  function uncheckAll(): void {
    setCheckedIds(new Set());
  }

  // 같은 DB로 다시 RUN하면 새 탭을 또 만들지 않고 내용만 갱신한다 (vanilla 버전의 addResultTab과 동일).
  function upsertResultTab(entry: ResultTabEntry): void {
    setResultTabs((current) => {
      const idx = current.findIndex((t) => t.dbname === entry.dbname);
      const next = idx >= 0 ? [...current] : [...current, entry];
      if (idx >= 0) next[idx] = entry;
      saveStoredResultTabs(next);
      return next;
    });
  }

  function closeResultTab(dbname: string): void {
    setResultTabs((current) => {
      const next = current.filter((t) => t.dbname !== dbname);
      saveStoredResultTabs(next);
      return next;
    });
    if (activeTab === dbname) setActiveTab('tab1');
  }

  function closeAllResultTabs(): void {
    setResultTabs([]);
    saveStoredResultTabs([]);
    if (!running.has(activeTab)) setActiveTab('tab1');
  }

  function setDbRunning(dbname: string, on: boolean): void {
    setRunning((current) => {
      const next = new Set(current);
      if (on) next.add(dbname);
      else next.delete(dbname);
      return next;
    });
  }

  async function runOne(dbConfig: DbConfig, buttonName: string): Promise<void> {
    setDbRunning(dbConfig.dbname, true);

    let results: MonitoringTaskResult[];
    try {
      results = await runMonResult(dbConfig.id);
    } catch (error) {
      console.error('DBMS 조회 중 오류:', error);
      const message = error instanceof Error ? error.message : String(error);
      showToast(`${dbConfig.dbname} 점검 실행 실패`, 'error');
      upsertResultTab({ dbname: dbConfig.dbname, results: [], error: message, dbmsId: dbConfig.id, ranAt: nowLabel() });
      if (buttonName !== 'downloadButton') setActiveTab(dbConfig.dbname);
      return;
    } finally {
      setDbRunning(dbConfig.dbname, false);
    }

    // 무엇이 실패했는지 토스트에서 바로 보이게 스크립트 이름을 붙인다
    const failedTasks = results.filter((r) => !r.success);
    if (failedTasks.length > 0) {
      const names = failedTasks
        .slice(0, 3)
        .map((r) => r.task_name)
        .join(', ');
      showToast(`${dbConfig.dbname} 점검 완료 — 실행 실패 ${failedTasks.length}건: ${names}${failedTasks.length > 3 ? ' 외' : ''}`, 'error');
    } else {
      showToast(`${dbConfig.dbname} 점검 완료`);
    }

    upsertResultTab({ dbname: dbConfig.dbname, results, dbmsId: dbConfig.id, ranAt: nowLabel() });

    if (buttonName === 'downloadButton') {
      // flushSync로 탭 전환을 동기 커밋시킨 뒤에 outerHTML을 읽어야, 방금 갱신된
      // 결과 탭 내용이 스냅샷에 포함된다 (vanilla 버전의 openTab() 직후 동기 DOM 읽기와 동일 효과).
      flushSync(() => setActiveTab(dbConfig.dbname));

      const now = new Date();
      const filename = `${dbConfig.dbname}_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}.html`;
      const html = document.documentElement.outerHTML;
      const outcome = await saveHtmlToFolder(html, filename);
      showToast(outcome.message, outcome.type);
    } else {
      setActiveTab(dbConfig.dbname);
    }
  }

  function runChecked(buttonName: string): void {
    if (!dbmsData) return;
    if (checkedIds.size === 0) {
      showToast('점검할 DB를 선택하세요.', 'error');
      return;
    }
    dbmsData.rows.forEach((row) => {
      const id = String(row.ID);
      if (!checkedIds.has(id)) return;
      const dbname = String(row.DBNAME);
      if (running.has(dbname)) return; // 이미 도는 DB는 건너뜀
      const dbConfig: DbConfig = {
        id,
        dbname,
        sid: String(row.SID),
        ip: String(row.IP),
        memo: String(row.MEMO ?? ''),
      };
      // vanilla 버전과 동일하게 await 없이 병렬로 실행한다.
      runOne(dbConfig, buttonName);
    });
  }

  const showSchedule = useMemo(() => isDbaOrAbove(user), [user]);
  // 결과 탭 + 아직 결과가 없는 실행 중인 DB
  const tabNames = [...resultTabs.map((t) => t.dbname), ...[...running].filter((name) => !resultTabs.some((t) => t.dbname === name))];

  return (
    <>
      <AppHeader active="dailyMonitoring" />
      <ToastHost />

      <PageHeader section="모니터링" title="일일 점검" description="DB를 선택해 점검 스크립트를 실행하고, 임계치를 넘은 항목과 실행에 실패한 스크립트를 바로 확인합니다." />

      <div id="tab-list" className="tab">
        <button type="button" className={`tab-link${activeTab === 'tab1' ? ' active' : ''}`} onClick={() => setActiveTab('tab1')}>
          DBMS LIST
        </button>
        {tabNames.map((dbname) => {
          const tab = resultTabs.find((t) => t.dbname === dbname);
          const isRunning = running.has(dbname);
          const status = tabStatus(tab, isRunning);
          return (
            <span key={dbname} className="tab-link-wrap">
              <button
                type="button"
                id={`tab-btn-${dbname}`}
                className={`tab-link${activeTab === dbname ? ' active' : ''}`}
                onClick={() => setActiveTab(dbname)}
                title={`${TAB_STATUS_LABEL[status]}${tab?.ranAt && !isRunning ? ` · ${tab.ranAt}` : ''}`}
              >
                <span className={`tab-status tab-status-${status}`} aria-label={TAB_STATUS_LABEL[status]} />
                {dbname}
              </button>
              {!isRunning && (
                <button type="button" className="tab-close" onClick={() => closeResultTab(dbname)} aria-label={`${dbname} 결과 탭 닫기`} title="탭 닫기">
                  ×
                </button>
              )}
            </span>
          );
        })}
        {resultTabs.length > 1 && (
          <button type="button" className="oc-link tab-close-all" onClick={closeAllResultTabs}>
            결과 탭 모두 닫기
          </button>
        )}
      </div>

      <div id="tab1" className={`tab-content${activeTab === 'tab1' ? ' active' : ''}`}>
        <button type="button" className="btn-secondary" onClick={checkAll}>
          전체 선택
        </button>
        <button type="button" className="btn-secondary" onClick={uncheckAll}>
          전체 선택 해제
        </button>
        <button type="button" id="Run-button" onClick={() => runChecked('runButton')} disabled={checkedIds.size === 0}>
          {running.size > 0 ? `RUN (실행 중 ${running.size})` : checkedIds.size > 0 ? `RUN (${checkedIds.size})` : 'RUN'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => runChecked('downloadButton')} disabled={checkedIds.size === 0}>
          Download Report
        </button>
        <button type="button" className="btn-secondary" onClick={handleChooseDownloadFolder}>
          다운로드 위치 설정
        </button>
        <span className="download-folder-label">{downloadFolderLabel}</span>

        {showSchedule && <ScheduleSettings checkedIds={checkedIds} />}

        {dbmsData && <DbmsListTable columns={dbmsData.columns} rows={dbmsData.rows} checkedIds={checkedIds} onToggleRow={toggleRow} />}
      </div>

      {tabNames.map((dbname) => {
        const tab = resultTabs.find((t) => t.dbname === dbname);
        return (
          <div key={dbname} id={dbname} className={`tab-content${activeTab === dbname ? ' active' : ''}`}>
            <div className="mr-tab-head">
              <h3>{dbname}</h3>
              {tab?.ranAt && <span className="oc-subtle">실행 {tab.ranAt}</span>}
            </div>
            {running.has(dbname) ? (
              <p className="mr-running">
                <span className="spinner" aria-hidden="true" /> 점검 실행 중… 스크립트 수와 DB 상태에 따라 수십 초 이상 걸릴 수 있습니다.
              </p>
            ) : tab?.error ? (
              <div className="mr-run-failed">
                <strong>점검을 실행하지 못했습니다.</strong>
                <pre className="issue-error issue-error-full">{tab.error}</pre>
                <p className="issue-modal-hint">
                  대상 DB 접속 실패는 이슈 티켓으로도 기록됩니다.{' '}
                  {tab.dbmsId && canSee(user, 'issues') && (
                    <a className="btn-link" href={`issues.html?dbms=${tab.dbmsId}`}>
                      이 DB의 이슈 보기
                    </a>
                  )}
                </p>
              </div>
            ) : tab ? (
              <MonitoringResultTable results={tab.results} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
