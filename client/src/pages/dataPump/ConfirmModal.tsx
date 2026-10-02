import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Modal } from '../../shared/components/Modal';

interface Props {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  // 지정하면 사용자가 이 문자열(대상 DB명)을 똑같이 입력해야 확인 버튼이 눌린다 — 데이터를 덮어쓰는 작업용.
  requireText?: string | null;
  busy?: boolean;
  onConfirm: (typedText: string) => void;
  onClose: () => void;
}

export function ConfirmModal({ open, title, children, confirmLabel, danger, requireText, busy, onConfirm, onClose }: Props): ReactElement | null {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  if (!open) return null;
  const textOk = !requireText || typed.trim().toUpperCase() === requireText.trim().toUpperCase();

  return (
    <Modal open onClose={onClose} title={title}>
      <div className="modal-body">
        {children}
        {requireText && (
          <>
            <label htmlFor="dp-confirm-text">
              확인을 위해 대상 DB명 <strong>{requireText}</strong>을(를) 입력하세요
            </label>
            <input id="dp-confirm-text" type="text" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
          </>
        )}
        <div className="oc-actions dp-buttons">
          <button type="button" className="btn-secondary" onClick={onClose}>
            취소
          </button>
          <button type="button" className={danger ? 'btn-danger' : undefined} disabled={!textOk || busy} onClick={() => onConfirm(typed)}>
            {busy ? '실행 중...' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
