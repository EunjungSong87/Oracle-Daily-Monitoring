import type { Request, Response, NextFunction } from 'express';
import 'express-session';
import type { UserRole } from '../models/usersModel';

// req.session에 저장하는 값 — 로그인 시점에 한 번 채우고 로그아웃 시 세션 자체를 파기합니다.
// 세션 저장소는 기본 in-memory MemoryStore를 씁니다: 이 앱은 프로세스 하나짜리
// 내부 도구라 별도 세션 스토어(Redis 등)를 둘 이유가 없지만, 그 대가로 서버 재시작이나
// `npm run dev`(tsx watch)의 자동 재시작 시 모든 세션이 사라집니다 — 알려진 제약입니다.
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: UserRole;
  }
}

// 로그인 없이 접근 가능한 정적 파일. 로그인 페이지 자체와 그 페이지가 필요로 하는
// 공통 자산만 허용합니다 — 그 외 모든 .html/.js는 세션이 있어야 서빙됩니다.
// /assets/pages/login.js와 /assets/chunks/{vendor,shared}.js는 React로 이관된 로그인
// 페이지(client/) 자신의 번들 + 공유 청크(vendor.js=react/react-dom, shared.js=공용 컴포넌트/
// 훅/유틸, 파일명은 client/vite.config.ts의 manualChunks에서 고정)입니다 — 허용하지 않으면
// 미인증 사용자가 /login.html로 리다이렉트돼도 그 페이지의 JS 번들 자체가 다시 막혀 로그인
// 폼이 뜨지 않습니다. (다른 인증된 페이지와도 공유되지만 라이브러리/공용 코드일 뿐이라
// 공개돼도 무해합니다.)
const PUBLIC_STATIC_PATHS = new Set([
  '/login.html',
  '/style.css',
  '/common.js',
  '/favicon.svg',
  '/assets/pages/login.js',
  '/assets/chunks/vendor.js',
  '/assets/chunks/shared.js',
]);

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // 로그인 페이지가 쓰는 style.css가 참조하는 웹폰트(@font-face) — 순수 서체 데이터라
  // 앱 정보를 노출하지 않으므로 통째로 허용한다 (파일이 늘어나도 목록을 계속 안 늘려도 됨).
  if (PUBLIC_STATIC_PATHS.has(req.path) || req.path.startsWith('/fonts/')) {
    next();
    return;
  }
  if (req.session?.userId) {
    next();
    return;
  }
  if (req.path.startsWith('/api') || req.path.startsWith('/main')) {
    res.status(401).json({ message: '로그인이 필요합니다.' });
    return;
  }
  res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
}

// 3단계 권한: VIEWER(로그인만) < DBA(운영 설정 변경) < SUPER_ADMIN(계정 관리 + 향후 최고관리자 전용 화면).
function requireDba(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.role === 'DBA' || req.session?.role === 'SUPER_ADMIN') {
    next();
    return;
  }
  res.status(403).json({ message: 'DBA 이상만 접근할 수 있습니다.' });
}

function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.role === 'SUPER_ADMIN') {
    next();
    return;
  }
  res.status(403).json({ message: '최고관리자만 접근할 수 있습니다.' });
}

export { requireAuth, requireDba, requireSuperAdmin };
