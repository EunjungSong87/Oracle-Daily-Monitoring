import { useEffect, useState, type ReactElement } from 'react';
import { dismissToast, subscribeToasts, type Toast } from '../lib/toastStore';

// public/common.js의 showToast()와 동일한 타이밍(2.6초 표시 + 0.3초 페이드)/클래스명을 재현.
function ToastItem({ toast }: { toast: Toast }): ReactElement {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    const hideTimer = setTimeout(() => setVisible(false), 2600);
    const removeTimer = setTimeout(() => dismissToast(toast.id), 2900);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hideTimer);
      clearTimeout(removeTimer);
    };
  }, [toast.id]);

  return (
    <div className={`toast toast-${toast.type}${visible ? ' toast-visible' : ''}`}>{toast.message}</div>
  );
}

export function ToastHost(): ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </>
  );
}
