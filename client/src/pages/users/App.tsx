import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { listUsers } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { Role, UserSummary } from '../../shared/lib/types';
import { UserAddModal } from './UserAddModal';
import { UserEditModal } from './UserEditModal';
import { UserScreensModal } from './UserScreensModal';

const ROLE_LABELS: Record<Role, string> = { VIEWER: 'Viewer', DBA: 'DBA', SUPER_ADMIN: 'Super Admin' };

function formatDate(s: string | null): string {
  if (!s || s.length < 14) return s || '-';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

// public/users.html 포팅. 원본은 role 게이팅을 전혀 하지 않는다(서버가 requireSuperAdmin으로만
// 막고, nav의 "Users" 링크 자체가 SUPER_ADMIN에게만 보이는 것으로 사실상 충분하다는 판단) —
// React 버전도 그대로: 페이지는 무조건 렌더링하고, API 401/403은 토스트로만 보여준다.
export function App(): ReactElement {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [screensUser, setScreensUser] = useState<UserSummary | null>(null);

  const fetchUsers = useCallback(() => {
    listUsers()
      .then(setUsers)
      .catch((error) => {
        console.error('Error loading users:', error);
        showToast('사용자 목록 조회 실패', 'error');
      });
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  return (
    <>
      <AppHeader active="users" />
      <ToastHost />

      <div className="page-header-row">
        <h2 className="page-title">Users</h2>
        <button type="button" className="btn-secondary" onClick={() => setAddOpen(true)}>
          Add User
        </button>
      </div>

      <table id="users-list" className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>USERNAME</th>
            <th>DISPLAY NAME</th>
            <th>ROLE</th>
            <th>ACTIVE</th>
            <th>CREATED</th>
            <th>LAST LOGIN</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {users?.map((user) => (
            <tr key={user.id}>
              <td>{user.id}</td>
              <td>{user.username}</td>
              <td>{user.displayName || '-'}</td>
              <td>{ROLE_LABELS[user.role] || user.role}</td>
              <td>{user.isActive ? 'Y' : 'N'}</td>
              <td>{formatDate(user.createdAt)}</td>
              <td>{formatDate(user.lastLoginAt)}</td>
              <td>
                <button type="button" className="btn-secondary" onClick={() => setEditing(user)}>
                  수정
                </button>{" "}
                <button type="button" className="btn-secondary" onClick={() => setScreensUser(user)}>
                  화면 권한
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <UserAddModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          setAddOpen(false);
          fetchUsers();
        }}
      />

      <UserEditModal
        open={!!editing}
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          fetchUsers();
        }}
      />

      <UserScreensModal user={screensUser} onClose={() => setScreensUser(null)} />
    </>
  );
}
