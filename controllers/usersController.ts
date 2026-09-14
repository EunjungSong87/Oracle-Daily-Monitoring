import type { Request, Response } from 'express';
import * as usersService from '../services/usersService';

async function listUsers(req: Request, res: Response): Promise<void> {
  try {
    const users = await usersService.listUsers();
    res.json(users);
  } catch (error) {
    console.error('Controller : 사용자 목록 조회 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function listBasic(req: Request, res: Response): Promise<void> {
  try {
    const users = await usersService.listBasic();
    res.json(users);
  } catch (error) {
    console.error('Controller : 사용자 목록 조회 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function createUser(req: Request, res: Response): Promise<Response | void> {
  try {
    const { username, password, displayName, isAdmin } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: '아이디와 비밀번호가 필요합니다.' });
    }
    await usersService.createUser({ username, password, displayName, isAdmin: !!isAdmin });
    res.json({ message: '사용자를 등록했습니다.' });
  } catch (error) {
    console.error('Controller : 사용자 등록 오류:', error);
    res.status(500).json({ message: '서버 오류 발생 (아이디가 이미 존재할 수 있습니다)' });
  }
}

async function setActive(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, isActive } = req.body;
    if (!id || typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'id, isActive 정보가 필요합니다.' });
    }
    await usersService.setActive(id, isActive);
    res.json({ message: isActive ? '계정을 활성화했습니다.' : '계정을 비활성화했습니다.' });
  } catch (error) {
    console.error('Controller : 계정 활성 상태 변경 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function resetPassword(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, newPassword } = req.body;
    if (!id || !newPassword) {
      return res.status(400).json({ message: 'id, newPassword 정보가 필요합니다.' });
    }
    await usersService.resetPassword(id, newPassword);
    res.json({ message: '비밀번호를 재설정했습니다.' });
  } catch (error) {
    console.error('Controller : 비밀번호 재설정 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

export { listUsers, listBasic, createUser, setActive, resetPassword };
