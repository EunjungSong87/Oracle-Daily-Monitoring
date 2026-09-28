import { useState, type FormEvent, type ReactElement } from 'react';
import { ToastHost } from '../../shared/components/ToastHost';
import { useTheme } from '../../shared/hooks/useTheme';
import { login } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';

// public/login.html 포팅. 이 페이지만 유일하게 <AppHeader/>가 없고(원본도 nav 자체가 없음)
// useCurrentUser도 호출하지 않는다(로그인 전이라 확인할 세션이 없음) — 로그인 상태와 무관하게
// 항상 렌더링되는, 이 앱에서 유일한 "인증 게이트 밖" 화면이라는 특징을 그대로 반영한다.
function getNextUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  return next && next.startsWith('/') ? next : 'index.html';
}

export function App(): ReactElement {
  useTheme(); // 토글 버튼은 없지만, 저장된/OS 테마를 <html data-theme>에 반영은 해야 한다.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) {
      showToast('아이디와 비밀번호를 입력해주세요.', 'error');
      return;
    }

    setSubmitting(true);
    try {
      await login(trimmedUsername, password);
      window.location.href = getNextUrl();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '로그인 실패', 'error');
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <ToastHost />
      <div className="login-brand">
        <span className="brand-mark">
          <svg className="brand-icon" viewBox="0 0 32 32" aria-hidden="true">
            <ellipse cx={16} cy={11} rx={8.5} ry={3.2} fill="#fff" />
            <path
              d="M8 11v11.5c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V11"
              stroke="#fff"
              strokeWidth={2.3}
              opacity={0.6}
              fill="none"
            />
            <path
              d="M7 19.6h4.6l1.8-3.6 2.3 6 1.8-2.4h5.7"
              stroke="#fff"
              strokeWidth={2.3}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </span>
        <span className="login-brand-name">DB Cockpit</span>
      </div>

      <form id="login-form" onSubmit={handleSubmit}>
        <label htmlFor="username">아이디</label>
        <input
          type="text"
          id="username"
          required
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <label htmlFor="password">비밀번호</label>
        <input
          type="password"
          id="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button type="submit" id="login-submit-btn" disabled={submitting}>
          로그인
        </button>
      </form>
    </div>
  );
}
