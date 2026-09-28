import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { AppHeader } from '../../shared/components/AppHeader';
import { MonitoringResultTable } from '../../shared/components/MonitoringResultTable';
import { ToastHost } from '../../shared/components/ToastHost';
import { isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getDbmsList, runMonResult } from '../../shared/lib/api';
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
}

function loadStoredResultTabs(): ResultTabEntry[] {
  try {
    return JSON.parse(sessionStorage.getItem(RESULT_TABS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveStoredResultTabs(tabs: ResultTabEntry[]): void {
  sessionStorage.setItem(RESULT_TABS_KEY, JSON.stringify(tabs));
}

export function App(): ReactElement {
  const { user } = useCurrentUser();
  const [dbmsData, setDbmsData] = useState<DbmsListResponse | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState('tab1');
  const [resultTabs, setResultTabs] = useState<ResultTabEntry[]>(() => loadStoredResultTabs());
  const [downloadFolderLabel, setDownloadFolderLabel] = useState('');

  useEffect(() => {
    getDbmsList()
      .then((data) => {
        setDbmsData(data);
        const defaultChecked = new Set(
          data.rows.filter((row) => row.AUTO_SCHEDULE === 'Y').map((row) => String(row.ID))
        );
        setCheckedIds(defaultChecked);
      })
      .catch((error) => console.log('Error fetching dbms list:', error));
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
  function upsertResultTab(dbname: string, results: MonitoringTaskResult[]): void {
    setResultTabs((current) => {
      const idx = current.findIndex((t) => t.dbname === dbname);
      const next = idx >= 0 ? [...current] : [...current, { dbname, results }];
      if (idx >= 0) next[idx] = { dbname, results };
      saveStoredResultTabs(next);
      return next;
    });
  }

  async function runOne(dbConfig: DbConfig, buttonName: string): Promise<void> {
    showToast(`${dbConfig.dbname} 점검 실행 중...`);

    let results: MonitoringTaskResult[];
    try {
      results = await runMonResult(dbConfig.id);
    } catch (error) {
      console.error('DBMS 조회 중 오류:', error);
      showToast(`${dbConfig.dbname} 점검 실행 실패`, 'error');
      return;
    }

    const failedCount = results.filter((r) => !r.success).length;
    if (failedCount > 0) {
      showToast(`${dbConfig.dbname} 점검 완료 (${failedCount}건 실패)`, 'error');
    } else {
      showToast(`${dbConfig.dbname} 점검 완료`);
    }

    upsertResultTab(dbConfig.dbname, results);

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
    dbmsData.rows.forEach((row) => {
      const id = String(row.ID);
      if (!checkedIds.has(id)) return;
      const dbConfig: DbConfig = {
        id,
        dbname: String(row.DBNAME),
        sid: String(row.SID),
        ip: String(row.IP),
        memo: String(row.MEMO ?? ''),
      };
      // vanilla 버전과 동일하게 await 없이 병렬로 실행한다.
      runOne(dbConfig, buttonName);
    });
  }

  const showSchedule = useMemo(() => isDbaOrAbove(user), [user]);

  return (
    <>
      <AppHeader active="dailyMonitoring" />
      <ToastHost />

      <h2 className="page-title">Daily Monitoring</h2>

      <div id="tab-list" className="tab">
        <button
          type="button"
          className={`tab-link${activeTab === 'tab1' ? ' active' : ''}`}
          onClick={() => setActiveTab('tab1')}
        >
          DBMS LIST
        </button>
        {resultTabs.map((tab) => (
          <button
            key={tab.dbname}
            type="button"
            id={`tab-btn-${tab.dbname}`}
            className={`tab-link${activeTab === tab.dbname ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.dbname)}
          >
            {tab.dbname}
          </button>
        ))}
      </div>

      <div id="tab1" className={`tab-content${activeTab === 'tab1' ? ' active' : ''}`}>
        <button type="button" className="btn-secondary" onClick={checkAll}>
          전체 선택
        </button>
        <button type="button" className="btn-secondary" onClick={uncheckAll}>
          전체 선택 해제
        </button>
        <button type="button" id="Run-button" onClick={() => runChecked('runButton')}>
          RUN
        </button>
        <button type="button" className="btn-secondary" onClick={() => runChecked('downloadButton')}>
          Download Report
        </button>
        <button type="button" className="btn-secondary" onClick={handleChooseDownloadFolder}>
          다운로드 위치 설정
        </button>
        <span className="download-folder-label">{downloadFolderLabel}</span>

        {showSchedule && <ScheduleSettings checkedIds={checkedIds} />}

        {dbmsData && (
          <DbmsListTable
            columns={dbmsData.columns}
            rows={dbmsData.rows}
            checkedIds={checkedIds}
            onToggleRow={toggleRow}
          />
        )}
      </div>

      {resultTabs.map((tab) => (
        <div key={tab.dbname} id={tab.dbname} className={`tab-content${activeTab === tab.dbname ? ' active' : ''}`}>
          <h3>{tab.dbname}</h3>
          <MonitoringResultTable results={tab.results} />
        </div>
      ))}
    </>
  );
}
