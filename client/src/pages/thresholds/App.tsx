import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { ListToolbar, SortableTh, useListView } from '../../shared/components/ListView';
import { ToastHost } from '../../shared/components/ToastHost';
import { isDbaOrAbove, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { deleteThreshold, getThresholdList } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { ThresholdFormPayload, ThresholdListResponse } from '../../shared/lib/types';
import { ThresholdModal } from './ThresholdModal';

// public/monitoringThresholds.html (Thresholds) 포팅.
export function App(): ReactElement {
  const { user } = useCurrentUser();
  const canManage = isDbaOrAbove(user);
  const [data, setData] = useState<ThresholdListResponse | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ThresholdFormPayload | null>(null);

  const columns = useMemo(() => data?.columns ?? [], [data]);
  const view = useListView(data?.rows, columns);

  const fetchThresholds = useCallback(() => {
    getThresholdList()
      .then(setData)
      .catch((error) => console.error('Error fetching thresholds:', error));
  }, []);

  useEffect(() => {
    fetchThresholds();
  }, [fetchThresholds]);

  function openAdd(): void {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(row: Record<string, unknown>): void {
    setEditing({
      id: row.ID as string | number,
      task_id: row.TASK_ID as string | number,
      column_name: String(row.COLUMN_NAME ?? ''),
      condition_type: String(row.CONDITION_TYPE ?? ''),
      operator: String(row.OPERATOR ?? ''),
      threshold: String(row.THRESHOLD ?? ''),
      clevel: String(row.CLEVEL ?? ''),
      message: row.MESSAGE ? String(row.MESSAGE) : '',
      is_active: String(row.IS_ACTIVE ?? 'Y'),
    });
    setModalOpen(true);
  }

  async function handleDelete(thresholdId: string | number): Promise<void> {
    if (!window.confirm('이 임계치 규칙 항목을 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      await deleteThreshold(thresholdId);
      showToast('임계치 삭제 완료.');
      fetchThresholds();
    } catch (error) {
      console.error('Error:', error);
      showToast('요청 처리 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <>
      <AppHeader active="thresholds" />
      <ToastHost />

      <PageHeader
        section="모니터링 · 일일 점검"
        title="임계치 규칙"
        description="점검 결과 컬럼별 경고 조건과 알림 레벨(INFO · WARN · ERROR · CRITICAL)을 정의합니다."
        actions={canManage ? (<button type="button" className="btn-secondary" onClick={openAdd}>+ 규칙 추가</button>) : undefined}
      />

      <ListToolbar view={view} placeholder="스크립트, 컬럼, 레벨, 메시지 검색" exportName="thresholds" exportColumns={columns} />

      <table id="threshold-list" className="table">
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
                <td key={column}>
                  {column === 'CLEVEL' && row.CLEVEL ? (
                    <span className={`issue-badge issue-badge-${String(row.CLEVEL).toLowerCase()}`}>{String(row.CLEVEL)}</span>
                  ) : (
                    String(row[column] ?? '')
                  )}
                </td>
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
                {view.total === 0 ? '등록된 임계치 규칙이 없습니다.' : '검색 조건에 맞는 항목이 없습니다.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <ThresholdModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          fetchThresholds();
        }}
      />
    </>
  );
}
