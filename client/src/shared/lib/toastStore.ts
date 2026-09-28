// public/common.js의 showToast()가 전역 함수로 어디서든 호출 가능했던 것과 동일하게,
// 컴포넌트 트리와 무관하게 호출할 수 있도록 작은 pub/sub 스토어로 둔다.

export type ToastType = 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<(toasts: Toast[]) => void>();

function emit(): void {
  listeners.forEach((listener) => listener(toasts));
}

export function subscribeToasts(listener: (toasts: Toast[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): Toast[] {
  return toasts;
}

export function showToast(message: string, type: ToastType = 'success'): void {
  const toast: Toast = { id: nextId++, message, type };
  toasts = [...toasts, toast];
  emit();
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}
