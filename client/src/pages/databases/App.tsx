import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { ListToolbar, SortableTh, useListView } from '../../shared/components/ListView';
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

  const columns = useMemo(() => data?.columns ?? [], [data]);
  const view = useListView(data?.rows, columns);

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
    if (!window.confirm('이 DB 항목을 삭제할까요? 되돌릴 수 없습니다.')) return;
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

      <PageHeader
        section="대상 DB"
        title="대상 DB 관리"
        description="모니터링할 DB의 접속 정보와 예약 점검 여부를 등록·관리합니다."
        actions={canManage ? (<button type="button" className="btn-secondary" onClick={openAdd}>+ DB 등록</button>) : undefined}
      />

      <ListToolbar view={view} placeholder="DB 이름, IP, SID, 메모 검색" exportName="databases" exportColumns={columns} />

      <table id="dbmses-list" className="table">
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
                {view.total === 0 ? '등록된 DB가 없습니다.' : '검색 조건에 맞는 항목이 없습니다.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <DbmsModal open={modalOpen} editing={editing} onClose={() => setModalOpen(false)} onSaved={() => { setModalOpen(false); fetchDbmses(); }} />
    </>
  );
}
