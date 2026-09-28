import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { updateUser } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { Role, UserSummary } from '../../shared/lib/types';

interface Props {
  open: boolean;
  user: UserSummary | null;
  onClose: () => void;
  onSaved: () => void;
}

// public/users.html의 #edit-user-modal-overlay/#edit-user-form 포팅.
// 삭제 기능은 원본에 아예 없다(비활성화만 가능) — 추가하지 않는다.
export function UserEditModal({ open, user, onClose, onSaved }: Props): ReactElement {
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');
  const [active, setActive] = useState(true);
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    if (open && user) {
      setDisplayName(user.displayName || '');
      setRole(user.role);
      setActive(user.isActive);
      setNewPassword('');
    }
  }, [open, user]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!user) return;
    try {
      await updateUser({
        id: user.id,
        displayName: displayName.trim() || undefined,
        role,
        isActive: active,
        newPassword: newPassword || undefined,
      });
      showToast('사용자 정보를 수정했습니다.');
      onSaved();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '사용자 수정 실패', 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={user ? `사용자 수정 — ${user.username}` : '사용자 수정'}>
      <form onSubmit={handleSubmit}>
        <label htmlFor="EDIT_DISPLAY_NAME">표시 이름:</label>
        <input
          type="text"
          id="EDIT_DISPLAY_NAME"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />

        <label htmlFor="EDIT_ROLE">권한:</label>
        <select id="EDIT_ROLE" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="VIEWER">Viewer — 조회, 티켓 처리</option>
          <option value="DBA">DBA — Viewer + DB/스크립트/임계치 관리</option>
          <option value="SUPER_ADMIN">Super Admin — DBA + 계정 관리</option>
        </select>

        <label>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> 계정 활성화
        </label>

        <label htmlFor="EDIT_NEW_PASSWORD">새 비밀번호 (변경하지 않으려면 비워두세요):</label>
        <input
          type="password"
          id="EDIT_NEW_PASSWORD"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />

        <div style={{ marginTop: 16 }}>
          <button type="submit">저장</button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            취소
          </button>
        </div>
      </form>
    </Modal>
  );
}
