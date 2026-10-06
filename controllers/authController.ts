import type { Request, Response } from 'express';
import * as screenAccessService from '../services/screenAccessService';
import * as usersService from '../services/usersService';
import { logger } from '../utils/logger';

async function login(req: Request, res: Response): Promise<Response | void> {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: '아이디와 비밀번호를 입력해주세요.' });
    }

    const result = await usersService.verifyCredentials(username, password);
    if (!result) {
      // 계정이 없는 것과 비밀번호가 틀린 것을 구분해서 알려주지 않습니다 (계정 존재 여부 노출 방지).
      return res.status(401).json({ message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    req.session.userId = result.userId;
    req.session.username = username;
    req.session.role = result.role;

    try {
      await usersService.touchLastLogin(username);
    } catch (error) {
      logger.warn('Auth', `마지막 로그인 시각 갱신 실패 (로그인은 정상 처리): ${username}`, error);
    }

    res.json({ username, role: result.role });
  } catch (error) {
    logger.error('Auth', '로그인 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

function logout(req: Request, res: Response): void {
  req.session.destroy((error) => {
    if (error) {
      logger.error('Auth', '로그아웃 오류', error);
      res.status(500).json({ message: '서버 오류 발생' });
      return;
    }
    res.json({ message: '로그아웃 되었습니다.' });
  });
}

// screens: 이 사용자에게 보이는 화면 (메뉴를 그릴 때 씀 — 역할 기본 + 사용자별 예외).
async function me(req: Request, res: Response): Promise<Response | void> {
  const { userId, username, role } = req.session ?? {};
  if (!userId) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  try {
    res.json({ username, role, screens: await screenAccessService.visibleScreens(userId, role) });
  } catch (error) {
    logger.error('Auth', '화면 권한 조회 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

export { login, logout, me };
