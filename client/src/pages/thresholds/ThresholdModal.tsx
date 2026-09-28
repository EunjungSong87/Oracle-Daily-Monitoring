import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { addThreshold, getScriptList, modifyThreshold } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { ThresholdFormPayload } from '../../shared/lib/types';

interface Props {
  open: boolean;
  editing: ThresholdFormPayload | null;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY: ThresholdFormPayload = {
  task_id: '',
  column_name: '',
  condition_type: 'NUMERIC',
  operator: '>',
  threshold: '',
  clevel: 'WARN',
  message: '',
  is_active: 'Y',
};

// public/monitoringThresholds.html의 #threshold-modal-overlay/#threshold-form 포팅.
// TASK_ID 드롭다운은 원본과 동일하게 모달을 열 때마다 다시 불러온다(캐싱하지 않음).
export function ThresholdModal({ open, editing, onClose, onSaved }: Props): ReactElement {
  const isEdit = !!editing;
  const [form, setForm] = useState<ThresholdFormPayload>(EMPTY);
  const [taskOptions, setTaskOptions] = useState<{ id: string | number; label: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    setForm(editing ?? EMPTY);
    getScriptList()
      .then(({ rows }) => {
        setTaskOptions(rows.map((row) => ({ id: row.ID, label: `${row.ID} - ${row.NAME}` })));
      })
      .catch((error) => console.error('Error loading tasks:', error));
  }, [open, editing]);

  function set<K extends keyof ThresholdFormPayload>(key: K, value: ThresholdFormPayload[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      if (isEdit) {
        await modifyThreshold({ ...form, id: editing!.id });
        showToast('임계치 수정 완료.');
      } else {
        await addThreshold(form);
        showToast('임계치 추가 완료.');
      }
      onSaved();
    } catch (error) {
      console.error('Error:', error);
      showToast('요청 처리 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Modify Threshold' : 'Add Threshold'}>
      <form onSubmit={handleSubmit}>
        {isEdit && (
          <div>
            <label htmlFor="THRESHOLD_ID">ID:</label>
            <input type="number" id="THRESHOLD_ID" readOnly value={editing?.id ?? ''} />
          </div>
        )}

        <label htmlFor="TASK_ID">점검 항목 (TASK):</label>
        <select id="TASK_ID" required value={form.task_id} onChange={(e) => set('task_id', e.target.value)}>
          {taskOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>

        <label htmlFor="COLUMN_NAME">컬럼명 (결과 테이블의 컬럼명과 정확히 일치해야 함):</label>
        <input
          type="text"
          id="COLUMN_NAME"
          placeholder="예: USED(%)"
          required
          value={form.column_name}
          onChange={(e) => set('column_name', e.target.value)}
        />

        <label htmlFor="CONDITION_TYPE">조건 유형:</label>
        <select
          id="CONDITION_TYPE"
          required
          value={form.condition_type}
          onChange={(e) => set('condition_type', e.target.value)}
        >
          <option value="NUMERIC">NUMERIC (숫자 비교)</option>
          <option value="STRING">STRING (문자열 일치)</option>
          <option value="PATTERN">PATTERN (문자열 포함)</option>
        </select>

        <label htmlFor="OPERATOR">연산자:</label>
        <select id="OPERATOR" required value={form.operator} onChange={(e) => set('operator', e.target.value)}>
          <option value=">">&gt;</option>
          <option value=">=">&gt;=</option>
          <option value="<">&lt;</option>
          <option value="<=">&lt;=</option>
          <option value="=">=</option>
          <option value="!=">!=</option>
          <option value="LIKE">LIKE (포함)</option>
        </select>

        <label htmlFor="THRESHOLD">기준값:</label>
        <input
          type="text"
          id="THRESHOLD"
          placeholder="예: 90"
          required
          value={form.threshold}
          onChange={(e) => set('threshold', e.target.value)}
        />

        <label htmlFor="CLEVEL">알림 레벨:</label>
        <select id="CLEVEL" required value={form.clevel} onChange={(e) => set('clevel', e.target.value)}>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
          <option value="INFO">INFO</option>
        </select>

        <label htmlFor="MESSAGE">메시지:</label>
        <input
          type="text"
          id="MESSAGE"
          placeholder="예: 테이블스페이스 사용률 90% 초과"
          value={form.message}
          onChange={(e) => set('message', e.target.value)}
        />

        <label htmlFor="IS_ACTIVE">활성화 여부:</label>
        <select id="IS_ACTIVE" required value={form.is_active} onChange={(e) => set('is_active', e.target.value)}>
          <option value="Y">Y</option>
          <option value="N">N</option>
        </select>

        <button type="submit">{isEdit ? '수정 완료' : '임계치 추가'}</button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          취소
        </button>
      </form>
    </Modal>
  );
}
