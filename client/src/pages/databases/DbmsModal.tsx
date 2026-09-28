import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { addDbms, modifyDbms, testDbmsConnection } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsFormPayload } from '../../shared/lib/types';

interface Props {
  open: boolean;
  editing: DbmsFormPayload | null;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY: DbmsFormPayload = { dbname: '', username: '', password: '', sid: '', ip: '', port: '', memo: '' };

// public/index.html의 #dbms-modal-overlay/#dbms-form 포팅 (openDbmsModal/testDbmsConnection/submitDbmsForm).
export function DbmsModal({ open, editing, onClose, onSaved }: Props): ReactElement {
  const isEdit = !!editing;
  const [form, setForm] = useState<DbmsFormPayload>(EMPTY);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (open) setForm(editing ?? EMPTY);
  }, [open, editing]);

  function set<K extends keyof DbmsFormPayload>(key: K, value: DbmsFormPayload[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleTest(): Promise<void> {
    if (!form.username || !form.sid || !form.ip || !form.port) {
      showToast('아이디/SID/IP/PORT를 입력해주세요.', 'error');
      return;
    }
    setTesting(true);
    try {
      const result = await testDbmsConnection({
        username: form.username,
        password: form.password,
        sid: form.sid,
        ip: form.ip,
        port: form.port,
        id: isEdit ? editing!.id : undefined,
      });
      showToast(result.message, result.success ? 'success' : 'error');
    } catch (error) {
      console.error('Error:', error);
      showToast('접속 테스트 처리 중 오류가 발생했습니다.', 'error');
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!form.dbname || !form.username || !form.sid || !form.ip || !form.port || (!isEdit && !form.password)) {
      showToast('필수 항목을 입력해주세요.', 'error');
      return;
    }
    try {
      if (isEdit) {
        await modifyDbms({ ...form, id: editing!.id });
        showToast('DBMS 수정 완료.');
      } else {
        await addDbms(form);
        showToast('DBMS 추가 완료.');
      }
      onSaved();
    } catch (error) {
      console.error('Error:', error);
      showToast('요청 처리 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Modify DBMS Info' : 'Add DBMS'}>
      <form onSubmit={handleSubmit}>
        {isEdit && (
          <div>
            <label htmlFor="DBMS_ID">ID:</label>
            <input type="number" id="DBMS_ID" readOnly value={editing?.id ?? ''} />
          </div>
        )}

        <label htmlFor="DBMS">DBMS:</label>
        <input type="text" id="DBMS" required value={form.dbname} onChange={(e) => set('dbname', e.target.value)} />

        <label htmlFor="USERNAME">USERNAME:</label>
        <input
          type="text"
          id="USERNAME"
          required
          value={form.username}
          onChange={(e) => set('username', e.target.value)}
        />

        <label htmlFor="PASSWORD">{isEdit ? 'PASSWORD (변경하지 않으려면 비워두세요):' : 'PASSWORD:'}</label>
        <input
          type="text"
          id="PASSWORD"
          required={!isEdit}
          placeholder={isEdit ? '변경하지 않으려면 비워두세요' : ''}
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
        />

        <label htmlFor="SID">SID:</label>
        <input type="text" id="SID" required value={form.sid} onChange={(e) => set('sid', e.target.value)} />

        <label htmlFor="IP">IP:</label>
        <input type="text" id="IP" required value={form.ip} onChange={(e) => set('ip', e.target.value)} />

        <label htmlFor="PORT">PORT:</label>
        <input type="text" id="PORT" required value={form.port} onChange={(e) => set('port', e.target.value)} />

        <label htmlFor="MEMO">MEMO:</label>
        <textarea id="MEMO" value={form.memo} onChange={(e) => set('memo', e.target.value)} />

        <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing}>
          {testing ? '접속 확인 중...' : '접속 테스트'}
        </button>
        <button type="submit">{isEdit ? '수정 완료' : 'DBMS 추가'}</button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          취소
        </button>
      </form>
    </Modal>
  );
}
