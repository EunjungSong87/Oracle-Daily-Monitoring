import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { ListToolbar, SortableTh, useListView } from '../../shared/components/ListView';
import { ToastHost } from '../../shared/components/ToastHost';
import { listUsers } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { Role, UserSummary } from '../../shared/lib/types';
import { UserAddModal } from './UserAddModal';
import { UserEditModal } from './UserEditModal';
import { UserScreensModal } from './UserScreensModal';

const ROLE_LABELS: Record<Role, string> = { VIEWER: 'Viewer', DBA: 'DBA', SUPER_ADMIN: 'Super Admin' };

// 목록 열: [키, 머리글]. 키는 검색·정렬·CSV에 쓰는 표시용 값
const USER_COLUMNS: [string, string][] = [
  ['ID', 'ID'],
  ['아이디', '아이디'],
  ['이름', '이름'],
  ['역할', '역할'],
  ['활성', '활성'],
  ['생성일', '생성일'],
  ['최근 로그인', '최근 로그인'],
];
const USER_COLUMN_KEYS = USER_COLUMNS.map(([key]) => key);

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

  const userRows = useMemo(
    () =>
      (users ?? []).map((user) => ({
        ID: user.id,
        아이디: user.username,
        이름: user.displayName || '-',
        역할: ROLE_LABELS[user.role] || user.role,
        활성: user.isActive ? 'Y' : 'N',
        생성일: formatDate(user.createdAt),
        '최근 로그인': formatDate(user.lastLoginAt),
        user,
      })),
    [users]
  );
  const view = useListView(userRows, USER_COLUMN_KEYS);

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

      <PageHeader
        section="계정"
        title="사용자 관리"
        description="로그인 계정과 역할, 화면별 접근 권한을 관리합니다."
        actions={<button type="button" className="btn-secondary" onClick={() => setAddOpen(true)}>+ 사용자 추가</button>}
      />

      <ListToolbar view={view} placeholder="아이디, 이름, 역할 검색" exportName="users" exportColumns={USER_COLUMN_KEYS} />

      <table id="users-list" className="table">
        <thead>
          <tr>
            {USER_COLUMNS.map(([key, label]) => (
              <SortableTh key={key} column={key} label={label} view={view} />
            ))}
            <th>관리</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.ID}>
              {USER_COLUMN_KEYS.map((key) => (
                <td key={key}>{String(row[key as keyof typeof row] ?? '')}</td>
              ))}
              <td>
                <button type="button" className="btn-secondary" onClick={() => setEditing(row.user)}>
                  수정
                </button>{' '}
                <button type="button" className="btn-secondary" onClick={() => setScreensUser(row.user)}>
                  화면 권한
                </button>
              </td>
            </tr>
          ))}
          {users && view.rows.length === 0 && (
            <tr>
              <td className="table-empty" colSpan={USER_COLUMNS.length + 1}>
                {view.total === 0 ? '등록된 사용자가 없습니다.' : '검색 조건에 맞는 사용자가 없습니다.'}
              </td>
            </tr>
          )}
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
