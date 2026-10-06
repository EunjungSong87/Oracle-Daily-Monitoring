import type { Request, Response } from 'express';
import * as screenAccessService from '../services/screenAccessService';
import * as usersService from '../services/usersService';
import type { UserRole } from '../models/usersModel';
import { logger } from '../utils/logger';

const VALID_ROLES: UserRole[] = ['VIEWER', 'DBA', 'SUPER_ADMIN'];

async function listUsers(req: Request, res: Response): Promise<void> {
  try {
    const users = await usersService.listUsers();
    res.json(users);
  } catch (error) {
    logger.error('Users', '사용자 목록 조회 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function listBasic(req: Request, res: Response): Promise<void> {
  try {
    const users = await usersService.listBasic();
    res.json(users);
  } catch (error) {
    logger.error('Users', '사용자 목록 조회 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function createUser(req: Request, res: Response): Promise<Response | void> {
  try {
    const { username, password, displayName, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: '아이디와 비밀번호가 필요합니다.' });
    }
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: '올바르지 않은 권한입니다.' });
    }
    await usersService.createUser({ username, password, displayName, role: role || 'VIEWER' });
    res.json({ message: '사용자를 등록했습니다.' });
  } catch (error) {
    logger.error('Users', '사용자 등록 오류', error);
    res.status(500).json({ message: '서버 오류 발생 (아이디가 이미 존재할 수 있습니다)' });
  }
}

// 비활성화/권한 변경/비밀번호 재설정을 각각 따로 팝업으로 두지 않고, 수정 팝업 하나로 합쳐서 저장합니다.
// newPassword는 비워두면(변경하지 않으려면 비워두는 UX) 비밀번호를 그대로 둡니다.
async function updateUser(req: Request, res: Response): Promise<Response | void> {
  try {
    const { id, displayName, role, isActive, newPassword } = req.body;
    if (!id || !VALID_ROLES.includes(role) || typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'id, role, isActive 정보가 필요합니다.' });
    }
    await usersService.updateUser({ id, displayName, role, isActive, newPassword: newPassword || undefined });
    res.json({ message: '사용자 정보를 수정했습니다.' });
  } catch (error) {
    logger.error('Users', '사용자 정보 수정 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

// 화면 권한: 역할 기본값 + 사용자별 예외. 역할은 목록에서 찾는다 (계정 수가 적은 내부 도구).
async function findUser(id: unknown): Promise<{ id: number; username: string; role: UserRole } | null> {
  const userId = Number(id);
  if (!Number.isInteger(userId)) return null;
  return (await usersService.listUsers()).find((user) => user.id === userId) ?? null;
}

async function getScreenAccess(req: Request, res: Response): Promise<Response | void> {
  try {
    const user = await findUser(req.body.id);
    if (!user) return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
    res.json(await screenAccessService.getUserSettings(user.id, user.role));
  } catch (error) {
    logger.error('Users', '화면 권한 조회 오류', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

// screens: { 화면키: true(보이게) | false(숨김) | null(역할 기본값) }
async function saveScreenAccess(req: Request, res: Response): Promise<Response | void> {
  try {
    const { screens } = req.body;
    if (!screens || typeof screens !== 'object' || Array.isArray(screens)) {
      return res.status(400).json({ message: 'screens 정보가 필요합니다.' });
    }
    for (const [key, value] of Object.entries(screens)) {
      if (!screenAccessService.isScreenKey(key) || !(value === null || typeof value === 'boolean')) {
        return res.status(400).json({ message: `올바르지 않은 화면 설정: ${key}` });
      }
    }
    const user = await findUser(req.body.id);
    if (!user) return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
    await screenAccessService.saveUserSettings(user.id, user.role, screens, req.session.username ?? null);
    logger.info('Users', `화면 권한 변경: ${user.username} (by ${req.session.username})`);
    res.json({ message: '화면 권한을 저장했습니다.' });
  } catch (error) {
    logger.error('Users', '화면 권한 저장 오류', error);
    res.status(500).json({ message: error instanceof Error ? error.message : '서버 오류 발생' });
  }
}

export { listUsers, listBasic, createUser, updateUser, getScreenAccess, saveScreenAccess };
