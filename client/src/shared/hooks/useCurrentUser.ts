import { useEffect, useState } from 'react';
import { getCurrentUser } from '../lib/api';
import type { CurrentUser } from '../lib/types';

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
