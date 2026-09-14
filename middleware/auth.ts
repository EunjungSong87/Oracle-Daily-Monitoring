import type { Request, Response, NextFunction } from 'express';
import 'express-session';

// req.session에 저장하는 값 — 로그인 시점에 한 번 채우고 로그아웃 시 세션 자체를 파기합니다.
// 세션 저장소는 기본 in-memory MemoryStore를 씁니다: 이 앱은 프로세스 하나짜리
// 내부 도구라 별도 세션 스토어(Redis 등)를 둘 이유가 없지만, 그 대가로 서버 재시작이나
// `npm run dev`(tsx watch)의 자동 재시작 시 모든 세션이 사라집니다 — 알려진 제약입니다.
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    isAdmin?: boolean;
  }
}

// 로그인 없이 접근 가능한 정적 파일. 로그인 페이지 자체와 그 페이지가 필요로 하는
// 공통 자산만 허용합니다 — 그 외 모든 .html/.js는 세션이 있어야 서빙됩니다.
const PUBLIC_STATIC_PATHS = new Set(['/login.html', '/style.css', '/common.js', '/favicon.svg']);

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_STATIC_PATHS.has(req.path)) {
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

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.isAdmin) {
    next();
    return;
  }
  res.status(403).json({ message: '관리자만 접근할 수 있습니다.' });
}

export { requireAuth, requireAdmin };
