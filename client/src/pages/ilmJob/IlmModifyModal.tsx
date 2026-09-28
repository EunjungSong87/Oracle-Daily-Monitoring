import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { updateIlmRetention } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { IlmRetentionRow } from '../../shared/lib/types';

interface Props {
  // null이면 닫힌 상태.
  row: IlmRetentionRow | null;
  dbmsId: string;
  onClose: () => void;
  onSaved: () => void;
}

interface ModifyForm {
  workGroup: string;
  deleteCycle: string;
  oggSyncYn: string;
  status: string;
  comments: string;
  memo: string;
}

function str(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

// 정책성 컬럼만 수정 대상이다. TABLE_OWNER/TABLE_NAME은 행을 식별하는 키라 읽기 전용으로 보여주고,
// 파티션 구조·잡 실행 결과 컬럼은 이 화면에서 다루지 않는다.
export function IlmModifyModal({ row, dbmsId, onClose, onSaved }: Props): ReactElement {
  const [form, setForm] = useState<ModifyForm>({
    workGroup: '',
    deleteCycle: '',
    oggSyncYn: 'N',
    status: '',
    comments: '',
    memo: '',
  });

  useEffect(() => {
    if (!row) return;
    setForm({
      workGroup: str(row.WORK_GROUP),
      deleteCycle: str(row.DELETE_CYCLE),
      oggSyncYn: str(row.OGG_SYNC_YN, 'N'),
      status: str(row.STATUS),
      comments: str(row.COMMENTS),
      memo: str(row.MEMO),
    });
  }, [row]);

  function set<K extends keyof ModifyForm>(key: K, value: ModifyForm[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!row) return;
    const orNull = (value: string): string | null => value || null;
    try {
      const result = await updateIlmRetention({
        dbmsid: dbmsId,
        tableOwner: row.TABLE_OWNER,
        tableName: row.TABLE_NAME,
        workGroup: orNull(form.workGroup),
        deleteCycle: orNull(form.deleteCycle),
        oggSyncYn: orNull(form.oggSyncYn),
        status: orNull(form.status),
        comments: orNull(form.comments),
        memo: orNull(form.memo),
      });
      if (result.success === false) {
        showToast(result.message || '수정 실패', 'error');
        return;
      }
      showToast('수정되었습니다.');
      onSaved();
    } catch (error) {
      console.error('Error updating ILM partition retention row:', error);
      showToast(error instanceof Error ? error.message : '수정 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <Modal open={!!row} onClose={onClose} title="테이블 수정">
      <form onSubmit={handleSubmit}>
        <label htmlFor="MOD_TABLE_OWNER">TABLE_OWNER:</label>
        <input type="text" id="MOD_TABLE_OWNER" readOnly value={str(row?.TABLE_OWNER)} />

        <label htmlFor="MOD_TABLE_NAME">TABLE_NAME:</label>
        <input type="text" id="MOD_TABLE_NAME" readOnly value={str(row?.TABLE_NAME)} />

        <label htmlFor="MOD_WORK_GROUP">담당 그룹 (WORK_GROUP):</label>
        <input
          type="text"
          id="MOD_WORK_GROUP"
          value={form.workGroup}
          onChange={(e) => set('workGroup', e.target.value)}
        />

        <label htmlFor="MOD_DELETE_CYCLE">보관주기 (DELETE_CYCLE):</label>
        <input
          type="text"
          id="MOD_DELETE_CYCLE"
          value={form.deleteCycle}
          onChange={(e) => set('deleteCycle', e.target.value)}
        />

        <label htmlFor="MOD_OGG_SYNC_YN">OGG 동기화 여부:</label>
        <select id="MOD_OGG_SYNC_YN" value={form.oggSyncYn} onChange={(e) => set('oggSyncYn', e.target.value)}>
          <option value="N">N</option>
          <option value="Y">Y</option>
        </select>

        <label htmlFor="MOD_STATUS">STATUS:</label>
        <input type="text" id="MOD_STATUS" value={form.status} onChange={(e) => set('status', e.target.value)} />

        <label htmlFor="MOD_COMMENTS">COMMENTS:</label>
        <input type="text" id="MOD_COMMENTS" value={form.comments} onChange={(e) => set('comments', e.target.value)} />

        <label htmlFor="MOD_MEMO">MEMO:</label>
        <input type="text" id="MOD_MEMO" value={form.memo} onChange={(e) => set('memo', e.target.value)} />

        <button type="submit">수정 완료</button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          취소
        </button>
      </form>
    </Modal>
  );
}
