import { useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { isSuperAdmin, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getDataPumpMeta, getDbmsList } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DataPumpMeta, DbmsRow } from '../../shared/lib/types';
import { ExportTab } from './ExportTab';
import { ImportTab } from './ImportTab';
import { JobsTab } from './JobsTab';

type Tab = 'EXPORT' | 'IMPORT' | 'JOBS';

// EXPDP/IMPDP를 DBMS_DATAPUMP로 DB 서버에서 실행하거나, 같은 설정의 parfile/명령어를 만든다. 최고관리자 전용.
export function App(): ReactElement {
  const { user, loading: userLoading } = useCurrentUser();
  const canUse = isSuperAdmin(user);

  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [dbmsId, setDbmsId] = useState('');
  const [meta, setMeta] = useState<DataPumpMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('EXPORT');

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

  useEffect(() => {
    if (!dbmsId) return;
    let cancelled = false;
    setMeta(null);
    setMetaError(null);
    getDataPumpMeta(dbmsId)
      .then((result) => {
        if (!cancelled) setMeta(result);
      })
      .catch((error) => {
        if (!cancelled) setMetaError(error instanceof Error ? error.message : 'DB 정보를 읽지 못했습니다.');
      });
    return () => {
      cancelled = true;
    };
  }, [dbmsId]);

  return (
    <>
      <AppHeader active="dataPump" />
      <ToastHost />

      <h2 className="page-title">Data Pump (EXPDP / IMPDP)</h2>

      {!userLoading && !canUse && <p className="issues-empty">이 기능은 최고관리자만 사용할 수 있습니다.</p>}

      {canUse && (
        <>
          <div className="rt-panel">
            <div className="rt-toolbar">
              <label htmlFor="dp-dbms" style={{ margin: 0 }}>
                DBMS:
              </label>
              <select id="dp-dbms" value={dbmsId} onChange={(e) => setDbmsId(e.target.value)}>
                {dbmsRows.map((row) => (
                  <option key={String(row.ID)} value={String(row.ID)}>
                    {String(row.ID)} - {row.DBNAME}
                  </option>
                ))}
              </select>
              <div className="status-tabs">
                {(
                  [
                    ['EXPORT', 'Export'],
                    ['IMPORT', 'Import'],
                    ['JOBS', '작업 현황'],
                  ] as const
                ).map(([key, label]) => (
                  <button key={key} type="button" className={`status-tab${tab === key ? ' status-tab-active' : ''}`} onClick={() => setTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="oc-hint">
              작업은 DB 서버 안에서 DBMS_DATAPUMP로 돌고, 덤프/로그 파일은 DB 서버의 DIRECTORY 경로에 생깁니다. 접속 계정에
              DATAPUMP_EXP_FULL_DATABASE / DATAPUMP_IMP_FULL_DATABASE 롤과 DIRECTORY 읽기·쓰기 권한이 필요합니다.
            </p>
          </div>

          {metaError && <p className="pc-warning">{metaError}</p>}
          {!meta && !metaError && dbmsId && <p className="issues-empty">DB 정보를 읽는 중...</p>}

          {/* DBMS를 바꾸면 탭 상태(선택/계획)가 이전 DB 기준으로 남지 않게 key로 새로 만든다. */}
          {meta && tab === 'EXPORT' && <ExportTab key={dbmsId} dbmsId={dbmsId} meta={meta} />}
          {meta && tab === 'IMPORT' && <ImportTab key={dbmsId} dbmsId={dbmsId} meta={meta} />}
          {meta && tab === 'JOBS' && <JobsTab key={dbmsId} dbmsId={dbmsId} />}
        </>
      )}
    </>
  );
}
