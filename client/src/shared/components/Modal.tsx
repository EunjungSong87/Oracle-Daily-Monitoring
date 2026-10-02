import { useEffect, type ReactElement, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  // true면 넓게(880px), 'xl'이면 더 넓게(1100px) — SQL 전문처럼 가로로 긴 내용을 보여줄 때.
  wide?: boolean | 'xl';
  children: ReactNode;
}

// public/common.js의 openModal/closeModal/setupModalDismiss(hidden 클래스 토글 + 배경 클릭/Esc 처리)를
// React로 일반화. DBMS/Scripts/Thresholds/Users add·edit, Issue 상세까지 여러 페이지가 동일한 구조로
// 쓰므로 컴포넌트 하나로 뽑는다 — 닫혀 있을 땐 아예 렌더링하지 않는다(hidden 클래스 대신 마운트/언마운트).
export function Modal({ open, onClose, title, wide, children }: Props): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' modal-wide' : ''}${wide === 'xl' ? ' modal-xl' : ''}`}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
