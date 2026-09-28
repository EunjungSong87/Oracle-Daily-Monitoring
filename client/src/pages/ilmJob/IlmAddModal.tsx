import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { addIlmRetention } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';

interface Props {
  open: boolean;
  dbmsId: string;
  onClose: () => void;
  onSaved: () => void;
}

interface AddForm {
  tableOwner: string;
  tableName: string;
  stdColumn: string;
  rangeType: string;
  partitionYn: string;
  partitionType: string;
  startHighvalue: string;
  endHighvalue: string;
  deleteCycle: string;
  oggSyncYn: string;
  status: string;
  stdDate: string;
  workGroup: string;
  comments: string;
  memo: string;
}

function todayYyyymmdd(): string {
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${today.getFullYear()}${mm}${dd}`;
}

function emptyForm(): AddForm {
  return {
    tableOwner: '',
    tableName: '',
    stdColumn: '',
    rangeType: 'DAY',
    partitionYn: 'Y',
    partitionType: '',
    startHighvalue: '',
    endHighvalue: '',
    deleteCycle: '',
    oggSyncYn: 'N',
    status: 'ACTIVE',
    stdDate: todayYyyymmdd(),
    workGroup: '',
    comments: '',
    memo: '',
  };
}

// 아직 없는 테이블을 새로 등록하는 팝업이라 파티션 구조 정보(STD_COLUMN 등)까지 함께 입력받는다.
// LAST_DEL_JOB_TIME은 잡이 실제로 실행된 뒤 채워지는 결과 컬럼이라 입력 항목에 없다.
export function IlmAddModal({ open, dbmsId, onClose, onSaved }: Props): ReactElement {
  const [form, setForm] = useState<AddForm>(emptyForm);

  useEffect(() => {
    if (open) setForm(emptyForm());
  }, [open]);

  function set<K extends keyof AddForm>(key: K, value: AddForm[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const orNull = (value: string): string | null => value || null;
    try {
      const result = await addIlmRetention({
        dbmsid: dbmsId,
        tableOwner: form.tableOwner,
        tableName: form.tableName,
        stdColumn: orNull(form.stdColumn),
        rangeType: orNull(form.rangeType),
        partitionYn: orNull(form.partitionYn),
        partitionType: orNull(form.partitionType),
        startHighvalue: orNull(form.startHighvalue),
        endHighvalue: orNull(form.endHighvalue),
        deleteCycle: orNull(form.deleteCycle),
        oggSyncYn: orNull(form.oggSyncYn),
        status: orNull(form.status),
        stdDate: orNull(form.stdDate),
        workGroup: orNull(form.workGroup),
        comments: orNull(form.comments),
        memo: orNull(form.memo),
      });
      if (result.success === false) {
        showToast(result.message || '테이블 추가 실패', 'error');
        return;
      }
      showToast('테이블이 추가되었습니다.');
      onSaved();
    } catch (error) {
      console.error('Error adding ILM partition retention row:', error);
      showToast(error instanceof Error ? error.message : '테이블 추가 중 오류가 발생했습니다.', 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="테이블 추가">
      <form onSubmit={handleSubmit}>
        <label htmlFor="ADD_TABLE_OWNER">TABLE_OWNER:</label>
        <input
          type="text"
          id="ADD_TABLE_OWNER"
          required
          value={form.tableOwner}
          onChange={(e) => set('tableOwner', e.target.value)}
        />

        <label htmlFor="ADD_TABLE_NAME">TABLE_NAME:</label>
        <input
          type="text"
          id="ADD_TABLE_NAME"
          required
          value={form.tableName}
          onChange={(e) => set('tableName', e.target.value)}
        />

        <label htmlFor="ADD_STD_COLUMN">기준 컬럼 (STD_COLUMN):</label>
        <input
          type="text"
          id="ADD_STD_COLUMN"
          placeholder="예: ORDER_DATE"
          value={form.stdColumn}
          onChange={(e) => set('stdColumn', e.target.value)}
        />

        <label htmlFor="ADD_RANGE_TYPE">파티션 주기 (RANGE_TYPE):</label>
        <select id="ADD_RANGE_TYPE" value={form.rangeType} onChange={(e) => set('rangeType', e.target.value)}>
          <option value="DAY">DAY</option>
          <option value="MONTH">MONTH</option>
          <option value="YEAR">YEAR</option>
        </select>

        <label htmlFor="ADD_PARTITION_YN">파티션 여부 (PARTITION_YN):</label>
        <select id="ADD_PARTITION_YN" value={form.partitionYn} onChange={(e) => set('partitionYn', e.target.value)}>
          <option value="Y">Y</option>
          <option value="N">N</option>
        </select>

        <label htmlFor="ADD_PARTITION_TYPE">파티션 유형 (PARTITION_TYPE):</label>
        <input
          type="text"
          id="ADD_PARTITION_TYPE"
          placeholder="예: RANGE"
          value={form.partitionType}
          onChange={(e) => set('partitionType', e.target.value)}
        />

        <label htmlFor="ADD_START_HIGHVALUE">START_HIGHVALUE:</label>
        <input
          type="text"
          id="ADD_START_HIGHVALUE"
          value={form.startHighvalue}
          onChange={(e) => set('startHighvalue', e.target.value)}
        />

        <label htmlFor="ADD_END_HIGHVALUE">END_HIGHVALUE:</label>
        <input
          type="text"
          id="ADD_END_HIGHVALUE"
          value={form.endHighvalue}
          onChange={(e) => set('endHighvalue', e.target.value)}
        />

        <label htmlFor="ADD_DELETE_CYCLE">보관주기 (DELETE_CYCLE):</label>
        <input
          type="text"
          id="ADD_DELETE_CYCLE"
          placeholder="예: 6"
          value={form.deleteCycle}
          onChange={(e) => set('deleteCycle', e.target.value)}
        />

        <label htmlFor="ADD_OGG_SYNC_YN">OGG 동기화 여부:</label>
        <select id="ADD_OGG_SYNC_YN" value={form.oggSyncYn} onChange={(e) => set('oggSyncYn', e.target.value)}>
          <option value="N">N</option>
          <option value="Y">Y</option>
        </select>

        <label htmlFor="ADD_STATUS">STATUS:</label>
        <input type="text" id="ADD_STATUS" value={form.status} onChange={(e) => set('status', e.target.value)} />

        <label htmlFor="ADD_STD_DATE">기준일 (STD_DATE):</label>
        <input
          type="text"
          id="ADD_STD_DATE"
          placeholder="YYYYMMDD"
          value={form.stdDate}
          onChange={(e) => set('stdDate', e.target.value)}
        />

        <label htmlFor="ADD_WORK_GROUP">담당 그룹 (WORK_GROUP):</label>
        <input
          type="text"
          id="ADD_WORK_GROUP"
          value={form.workGroup}
          onChange={(e) => set('workGroup', e.target.value)}
        />

        <label htmlFor="ADD_COMMENTS">COMMENTS:</label>
        <input type="text" id="ADD_COMMENTS" value={form.comments} onChange={(e) => set('comments', e.target.value)} />

        <label htmlFor="ADD_MEMO">MEMO:</label>
        <input type="text" id="ADD_MEMO" value={form.memo} onChange={(e) => set('memo', e.target.value)} />

        <button type="submit">등록</button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          취소
        </button>
      </form>
    </Modal>
  );
}
