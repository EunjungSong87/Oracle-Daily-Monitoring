import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { addScript, getSqlText, modifyScript } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { ScriptFormPayload } from '../../shared/lib/types';

interface Props {
  open: boolean;
  editing: ScriptFormPayload | null;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY: ScriptFormPayload = { id: '', name: '', category: '', description: '', sql_text: '', schedule: '', is_active: 'Y' };

// public/monitoringScript.html의 #script-modal-overlay/#script-form 포팅.
export function ScriptModal({ open, editing, onClose, onSaved }: Props): ReactElement {
  const isEdit = !!editing;
  const [form, setForm] = useState<ScriptFormPayload>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!editing) {
      setForm(EMPTY);
      return;
    }
    // 원본처럼 SQL 본문을 먼저 조회한 뒤 폼을 채운다 (로딩 인디케이터 없이 await — 패리티 유지).
    setLoading(true);
    getSqlText(editing.id, editing.name)
      .then((sqlText) => setForm({ ...editing, sql_text: sqlText || '' }))
      .finally(() => setLoading(false));
  }, [open, editing]);

  function set<K extends keyof ScriptFormPayload>(key: K, value: ScriptFormPayload[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!form.id || !form.name || !form.sql_text || !form.is_active) {
      showToast('필수 항목을 입력해주세요.', 'error');
      return;
    }
    try {
      if (isEdit) {
        await modifyScript(form);
        showToast('Script 수정 완료.');
      } else {
        await addScript(form);
        showToast('Script 추가 완료.');
      }
      onSaved();
    } catch (error) {
      console.error('Error:', error);
      showToast('요청 처리 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Modify Script' : 'Add Script'}>
      <form onSubmit={handleSubmit}>
        <label htmlFor="ID">ID:</label>
        <input
          type="number"
          id="ID"
          required
          readOnly={isEdit}
          value={form.id}
          onChange={(e) => set('id', e.target.value)}
        />

        <label htmlFor="NAME">NAME:</label>
        <input type="text" id="NAME" required value={form.name} onChange={(e) => set('name', e.target.value)} />

        <label htmlFor="CATEGORY">CATEGORY:</label>
        <input
          type="text"
          id="CATEGORY"
          required
          value={form.category}
          onChange={(e) => set('category', e.target.value)}
        />

        <label htmlFor="DESCRIPTION">DESCRIPTION:</label>
        <input
          type="text"
          id="DESCRIPTION"
          required
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />

        <label htmlFor="SQL_TEXT">SQL_TEXT:</label>
        <textarea
          id="SQL_TEXT"
          required
          value={loading ? '불러오는 중...' : form.sql_text}
          disabled={loading}
          onChange={(e) => set('sql_text', e.target.value)}
        />

        <label htmlFor="SCHEDULE">SCHEDULE:</label>
        <input
          type="text"
          id="SCHEDULE"
          required
          value={form.schedule}
          onChange={(e) => set('schedule', e.target.value)}
        />

        <label htmlFor="IS_ACTIVE">IS_ACTIVE:</label>
        <select id="IS_ACTIVE" required value={form.is_active} onChange={(e) => set('is_active', e.target.value)}>
          <option value="Y">Y</option>
          <option value="N">N</option>
        </select>

        <button type="submit">{isEdit ? '수정 완료' : 'Script 추가'}</button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          취소
        </button>
      </form>
    </Modal>
  );
}
