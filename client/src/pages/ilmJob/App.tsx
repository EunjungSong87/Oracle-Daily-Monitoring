import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getDbmsList, getIlmRetentionList } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsRow, IlmRetentionRow } from '../../shared/lib/types';
import { IlmAddModal } from './IlmAddModal';
import { IlmModifyModal } from './IlmModifyModal';

const ILM_COLUMNS = [
  'TABLE_OWNER',
  'TABLE_NAME',
  'STD_COLUMN',
  'DELETE_CYCLE',
  'RANGE_TYPE',
  'PARTITION_YN',
  'PARTITION_TYPE',
  'OGG_SYNC_YN',
  'STATUS',
  'LAST_DEL_JOB_TIME',
  'STD_DATE',
  'WORK_GROUP',
  'COMMENTS',
  'MEMO',
];

// public/ilmJob.html (vanilla) 포팅. 조회/등록/수정 모두 DBA 이상 (routers/ilmJobRouters.ts와 동일 기준).
export function App(): ReactElement {
  const { user, loading: userLoading } = useCurrentUser();
  const canManage = isDbaOrAbove(user);

  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [dbmsId, setDbmsId] = useState('');
  const [rows, setRows] = useState<IlmRetentionRow[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<IlmRetentionRow | null>(null);

  useEffect(() => {
    if (!canManage) return;
    getDbmsList()
      .then(({ rows: dbms }) => {
        setDbmsRows(dbms);
        if (dbms.length > 0) setDbmsId(String(dbms[0].ID));
      })
      .catch((error) => {
        console.error('Error loading dbms list:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, [canManage]);

  const loadList = useCallback(async () => {
    if (!dbmsId) return;
    try {
      setRows(await getIlmRetentionList(dbmsId));
    } catch (error) {
      console.error('Error loading ILM partition retention list:', error);
      showToast('파티션 보관주기 목록 조회 실패', 'error');
    }
  }, [dbmsId]);

  useEffect(() => {
    setRows(null);
    loadList();
  }, [loadList]);

  function openAdd(): void {
    if (!dbmsId) {
      showToast('DBMS를 먼저 선택하세요.', 'error');
      return;
    }
    setAddOpen(true);
  }

  const colSpan = ILM_COLUMNS.length + 1;

  return (
    <>
      <AppHeader active="ilmJob" />
      <ToastHost />

      <div className="page-header-row">
        <h2 className="page-title">ILM Partition Retention (파티션 보관주기 관리)</h2>
        {canManage && (
          <button type="button" className="btn-secondary" onClick={openAdd}>
            테이블 추가
          </button>
        )}
      </div>

      {!userLoading && !canManage && <p className="issues-empty">이 기능은 DBA 이상만 사용할 수 있습니다.</p>}

      {canManage && (
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

            <div style={{ marginTop: 16 }}>
              <button type="button" className="btn-secondary" onClick={() => loadList()}>
                재조회
              </button>
            </div>
          </form>

          <div style={{ marginTop: 24 }}>
            <label style={{ marginBottom: 0 }}>파티션 테이블 보관주기 목록</label>
            <p className="issues-subtitle">PGDBA.DEL_JOB_TABLE_LIST에 등록된 관리 대상 테이블입니다.</p>
            <table className="table">
              <thead>
                <tr>
                  {ILM_COLUMNS.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                  <th>ACTIONS</th>
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
                {rows?.map((row) => (
                  <tr key={`${row.TABLE_OWNER}.${row.TABLE_NAME}`}>
                    {ILM_COLUMNS.map((column) => (
                      <td key={column}>{String(row[column] ?? '')}</td>
                    ))}
                    <td>
                      <button type="button" className="btn-secondary" onClick={() => setEditing(row)}>
                        Modify
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <IlmAddModal
        open={addOpen}
        dbmsId={dbmsId}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          setAddOpen(false);
          loadList();
        }}
      />
      <IlmModifyModal
        row={editing}
        dbmsId={dbmsId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          loadList();
        }}
      />
    </>
  );
}
