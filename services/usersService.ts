import * as usersModel from '../models/usersModel';
import type { UserSummary, UserBasic, CreateUserInput } from '../models/usersModel';
import { verifyPassword } from '../models/passwordUtils';

async function listUsers(): Promise<UserSummary[]> {
  try {
    return await usersModel.listUsers();
  } catch (error) {
    console.error('Service : 사용자 목록 조회 실패:', error);
    throw new Error('사용자 목록 조회 실패', { cause: error });
  }
}

async function listBasic(): Promise<UserBasic[]> {
  try {
    return await usersModel.listBasic();
  } catch (error) {
    console.error('Service : 사용자 목록 조회 실패:', error);
    throw new Error('사용자 목록 조회 실패', { cause: error });
  }
}

async function findBasicByUsername(username: string): Promise<UserBasic | null> {
  try {
    return await usersModel.findBasicByUsername(username);
  } catch (error) {
    console.error('Service : 사용자 조회 실패:', error);
    throw new Error('사용자 조회 실패', { cause: error });
  }
}

async function createUser(input: CreateUserInput): Promise<number> {
  try {
    return await usersModel.createUser(input);
  } catch (error) {
    console.error('Service : 사용자 등록 실패:', error);
    throw new Error('사용자 등록 실패', { cause: error });
  }
}

async function setActive(id: number | string, isActive: boolean): Promise<void> {
  try {
    await usersModel.setActive(id, isActive);
  } catch (error) {
    console.error('Service : 사용자 활성 상태 변경 실패:', error);
    throw new Error('사용자 활성 상태 변경 실패', { cause: error });
  }
}

async function resetPassword(id: number | string, newPassword: string): Promise<void> {
  try {
    await usersModel.resetPassword(id, newPassword);
  } catch (error) {
    console.error('Service : 비밀번호 재설정 실패:', error);
    throw new Error('비밀번호 재설정 실패', { cause: error });
  }
}

// 로그인 자격 증명 검증 — 계정 존재 여부와 비밀번호 일치 여부를 구분하지 않고
// 하나의 boolean으로만 반환합니다 (계정 존재 여부 노출 방지는 컨트롤러 응답에서).
async function verifyCredentials(username: string, password: string): Promise<{ userId: number; isAdmin: boolean } | null> {
  try {
    const user = await usersModel.findByUsername(username);
    if (!user || !user.isActive) return null;
    if (!verifyPassword(password, user.passwordHash)) return null;
    return { userId: user.id, isAdmin: user.isAdmin };
  } catch (error) {
    console.error('Service : 로그인 검증 실패:', error);
    throw new Error('로그인 검증 실패', { cause: error });
  }
}

async function touchLastLogin(username: string): Promise<void> {
  try {
    await usersModel.touchLastLogin(username);
  } catch (error) {
    console.error('Service : 마지막 로그인 시각 갱신 실패:', error);
    // 로그인 자체를 막을 이유는 아니므로 호출하는 쪽에서 흡수합니다.
    throw new Error('마지막 로그인 시각 갱신 실패', { cause: error });
  }
}

export { listUsers, listBasic, findBasicByUsername, createUser, setActive, resetPassword, verifyCredentials, touchLastLogin };
