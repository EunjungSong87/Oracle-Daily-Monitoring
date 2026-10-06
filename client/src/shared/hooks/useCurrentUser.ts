import { useEffect, useState } from 'react';
import { getCurrentUser } from '../lib/api';
import type { CurrentUser, ScreenKey } from '../lib/types';

export function useCurrentUser(): { user: CurrentUser | null; loading: boolean } {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser().then((me) => {
      if (!cancelled) {
        setUser(me);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { user, loading };
}

export function isDbaOrAbove(user: CurrentUser | null): boolean {
  return !!user && (user.role === 'DBA' || user.role === 'SUPER_ADMIN');
}

export function isSuperAdmin(user: CurrentUser | null): boolean {
  return !!user && user.role === 'SUPER_ADMIN';
}

// 이 사용자에게 보이는 화면인지 (역할 기본 + 계정 관리의 사용자별 예외 — 서버가 /auth/me로 내려줌).
export function canSee(user: CurrentUser | null, screen: ScreenKey): boolean {
  return !!user && (user.screens ?? []).includes(screen);
}
