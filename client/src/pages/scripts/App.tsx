import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { deleteScript, getScriptList } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { ScriptFormPayload, ScriptListResponse } from '../../shared/lib/types';
import { ScriptModal } from './ScriptModal';

// public/monitoringScript.html (Scripts) 포팅.
export function App(): ReactElement {
  const { user } = useCurrentUser();
  const canManage = isDbaOrAbove(user);
  const [data, setData] = useState<ScriptListResponse | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ScriptFormPayload | null>(null);

  const fetchScripts = useCallback(() => {
    getScriptList()
      .then(setData)
      .catch((error) => console.error('Error fetching scripts:', error));
  }, []);

  useEffect(() => {
    fetchScripts();
  }, [fetchScripts]);

  function openAdd(): void {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row: Record<string, unknown>): void {
    setEditing({
      id: row.ID as string | number,
      name: String(row.NAME ?? ''),
      category: row.CATEGORY ? String(row.CATEGORY) : '',
      description: row.DESCRIPTION ? String(row.DESCRIPTION) : '',
      sql_text: '',
      schedule: row.SCHEDULE ? String(row.SCHEDULE) : '',
      is_active: String(row.IS_ACTIVE ?? 'Y'),
    });
    setModalOpen(true);
  }

  async function handleDelete(scriptId: string | number): Promise<void> {
    try {
      await deleteScript(scriptId);
      showToast('스크립트 삭제 완료.');
      fetchScripts();
    } catch (error) {
      console.error('Error:', error);
      showToast('요청 처리 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <>
      <AppHeader active="scripts" />
      <ToastHost />

      <div className="page-header-row">
        <h2 className="page-title">Scripts</h2>
        {canManage && (
          <button type="button" className="btn-secondary" onClick={openAdd}>
            Add Script
          </button>
        )}
      </div>

      <table id="script-list" className="table">
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

      <ScriptModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          fetchScripts();
        }}
      />
    </>
  );
}
