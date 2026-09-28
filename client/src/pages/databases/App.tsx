import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { deleteDbms, getDbmsList } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsFormPayload, DbmsListResponse } from '../../shared/lib/types';
import { DbmsModal } from './DbmsModal';

// public/index.html (Databases) 포팅.
export function App(): ReactElement {
  const { user } = useCurrentUser();
  const canManage = isDbaOrAbove(user);
  const [data, setData] = useState<DbmsListResponse | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DbmsFormPayload | null>(null);

  const fetchDbmses = useCallback(() => {
    getDbmsList()
      .then(setData)
      .catch(() => {
        /* vanilla 버전과 동일하게 조용히 무시 */
      });
  }, []);

  useEffect(() => {
    fetchDbmses();
  }, [fetchDbmses]);

  function openAdd(): void {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row: Record<string, unknown>): void {
    setEditing({
      id: row.ID as string | number,
      dbname: String(row.DBNAME ?? ''),
      username: String(row.USERNAME ?? ''),
      password: '',
      sid: String(row.SID ?? ''),
      ip: String(row.IP ?? ''),
      port: String(row.PORT ?? ''),
      memo: row.MEMO ? String(row.MEMO) : '',
    });
    setModalOpen(true);
  }

  async function handleDelete(dbmsId: string | number): Promise<void> {
    try {
      await deleteDbms(dbmsId);
      showToast('DBMS 삭제 완료.');
      fetchDbmses();
    } catch (error) {
      console.error('Error:', error);
      showToast('요청 처리 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <>
      <AppHeader active="databases" />
      <ToastHost />

      <div className="page-header-row">
        <h2 className="page-title">Databases</h2>
        {canManage && (
          <button type="button" className="btn-secondary" onClick={openAdd}>
            Add DBMS
          </button>
        )}
      </div>

      <table id="dbmses-list" className="table">
        <thead>
          <tr>
            {data?.columns.map((column) => <th key={column}>{column}</th>)}
            {canManage && <th>ACTIONS</th>}
          </tr>
        </thead>
        <tbody>
          {data?.rows.map((row) => (
            <tr key={String(row.ID)}>
              {data.columns.map((column) => (
                <td key={column}>{String(row[column] ?? '')}</td>
              ))}
              {canManage && (
                <td>
                  <button type="button" className="btn-secondary" onClick={() => openEdit(row)}>
                    Modify
                  </button>
                  <button type="button" className="btn-danger" onClick={() => handleDelete(row.ID as string | number)}>
                    Delete
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <DbmsModal open={modalOpen} editing={editing} onClose={() => setModalOpen(false)} onSaved={() => { setModalOpen(false); fetchDbmses(); }} />
    </>
  );
}
