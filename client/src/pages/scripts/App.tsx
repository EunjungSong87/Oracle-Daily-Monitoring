import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { ListToolbar, SortableTh, useListView } from '../../shared/components/ListView';
import { ToastHost } from '../../shared/components/ToastHost';
import { isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { deleteScript, getScriptList } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import { urlParam } from '../../shared/lib/urlParams';
import type { ScriptFormPayload, ScriptListResponse } from '../../shared/lib/types';
import { ScriptModal } from './ScriptModal';

// public/monitoringScript.html (Scripts) 포팅.
export function App(): ReactElement {
  const { user } = useCurrentUser();
  const canManage = isDbaOrAbove(user);
  const [data, setData] = useState<ScriptListResponse | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ScriptFormPayload | null>(null);

  const columns = useMemo(() => data?.columns ?? [], [data]);
  const view = useListView(data?.rows, columns);

  const fetchScripts = useCallback(() => {
    getScriptList()
      .then(setData)
      .catch((error) => console.error('Error fetching scripts:', error));
  }, []);

  useEffect(() => {
    fetchScripts();
  }, [fetchScripts]);

  // ?task=<ID>로 넘어오면(이슈 티켓의 "스크립트 SQL 열기") 그 스크립트 편집 창을 한 번 연다
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || !data || !user) return;
    deepLinkDone.current = true;
    const wanted = urlParam('task');
    if (!wanted || !canManage) return;
    const row = data.rows.find((r) => String(r.ID) === wanted);
    if (row) openEdit(row);
    else showToast(`스크립트 #${wanted}를 찾을 수 없습니다.`, 'error');
  }, [data, user, canManage]);

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
    if (!window.confirm('이 점검 스크립트 항목을 삭제할까요? 되돌릴 수 없습니다.')) return;
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

      <PageHeader
        section="모니터링 · 일일 점검"
        title="점검 스크립트"
        description="일일 점검에서 실행할 SQL 점검 항목을 관리합니다."
        actions={canManage ? (<button type="button" className="btn-secondary" onClick={openAdd}>+ 스크립트 추가</button>) : undefined}
      />

      <ListToolbar view={view} placeholder="스크립트 이름, 내용 검색" exportName="scripts" exportColumns={columns} />

      <table id="script-list" className="table">
        <thead>
          <tr>
            {columns.map((column) => <SortableTh key={column} column={column} view={view} />)}
            {canManage && <th>관리</th>}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={String(row.ID)}>
              {columns.map((column) => (
                <td key={column}>{String(row[column] ?? '')}</td>
              ))}
              {canManage && (
                <td>
                  <button type="button" className="btn-secondary" onClick={() => openEdit(row)}>
                    수정
                  </button>
                  <button type="button" className="btn-danger" onClick={() => handleDelete(row.ID as string | number)}>
                    삭제
                  </button>
                </td>
              )}
            </tr>
          ))}
          {data && view.rows.length === 0 && (
            <tr>
              <td className="table-empty" colSpan={columns.length + (canManage ? 1 : 0)}>
                {view.total === 0 ? '등록된 점검 스크립트가 없습니다.' : '검색 조건에 맞는 항목이 없습니다.'}
              </td>
            </tr>
          )}
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
