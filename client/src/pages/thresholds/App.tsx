import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
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
        section="Monitoring · Daily Monitoring"
        title="임계치 규칙"
        description="점검 결과 컬럼별 경고 조건과 알림 레벨(INFO · WARN · ERROR · CRITICAL)을 정의합니다."
        actions={canManage ? (<button type="button" className="btn-secondary" onClick={openAdd}>+ 규칙 추가</button>) : undefined}
      />

      <table id="threshold-list" className="table">
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
