import type { Request, Response } from 'express';
import * as usersService from '../services/usersService';

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
    req.session.isAdmin = result.isAdmin;

    try {
      await usersService.touchLastLogin(username);
    } catch (error) {
      console.error('Controller : 마지막 로그인 시각 갱신 실패 (로그인은 정상 처리):', error);
    }

    res.json({ username, isAdmin: result.isAdmin });
  } catch (error) {
    console.error('Controller : 로그인 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

function logout(req: Request, res: Response): void {
  req.session.destroy((error) => {
    if (error) {
      console.error('Controller : 로그아웃 오류:', error);
      res.status(500).json({ message: '서버 오류 발생' });
      return;
    }
    res.json({ message: '로그아웃 되었습니다.' });
  });
}

function me(req: Request, res: Response): Response | void {
  if (!req.session?.userId) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  res.json({ username: req.session.username, isAdmin: !!req.session.isAdmin });
}

export { login, logout, me };
