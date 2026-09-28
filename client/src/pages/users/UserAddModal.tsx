import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { addUser } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { Role } from '../../shared/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

// public/users.html의 #user-modal-overlay/#user-form(Add User) 포팅.
export function UserAddModal({ open, onClose, onSaved }: Props): ReactElement {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');

  useEffect(() => {
    if (open) {
      setUsername('');
      setPassword('');
      setDisplayName('');
      setRole('VIEWER');
    }
  }, [open]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) {
      showToast('아이디와 비밀번호를 입력해주세요.', 'error');
      return;
    }
    try {
      await addUser({ username: trimmedUsername, password, displayName: displayName.trim() || undefined, role });
      showToast('사용자를 등록했습니다.');
      onSaved();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '사용자 등록 실패', 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add User">
      <form onSubmit={handleSubmit}>
        <label htmlFor="USERNAME">아이디:</label>
        <input
          type="text"
          id="USERNAME"
          required
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label htmlFor="PASSWORD">비밀번호:</label>
        <input
          type="password"
          id="PASSWORD"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <label htmlFor="DISPLAY_NAME">표시 이름 (선택):</label>
        <input type="text" id="DISPLAY_NAME" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />

        <label htmlFor="ROLE">권한:</label>
        <select id="ROLE" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="VIEWER">Viewer — 조회, 티켓 처리</option>
          <option value="DBA">DBA — Viewer + DB/스크립트/임계치 관리</option>
          <option value="SUPER_ADMIN">Super Admin — DBA + 계정 관리</option>
        </select>

        <div style={{ marginTop: 16 }}>
          <button type="submit">사용자 추가</button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            취소
          </button>
        </div>
      </form>
    </Modal>
  );
}
