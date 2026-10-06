import * as screenAccessModel from '../models/screenAccessModel';
import type { UserRole } from '../models/usersModel';
import { logger } from '../utils/logger';

// 화면 표시 권한: 역할(VIEWER < DBA < SUPER_ADMIN)이 기본을 정하고, 계정 관리에서 사용자별로 보이게/숨김 예외를 둔다.
// 숨긴 화면은 메뉴에서 빠지고, 페이지 주소로 들어와도 다른 화면으로 돌려보내고, 그 화면의 API도 403.
// 계정 관리(Users)는 여기 없다 — 최고관리자 전용 고정 (예외로 열면 그 사람이 스스로 권한을 올릴 수 있어서).

export type ScreenKey =
  | 'databases'
  | 'dailyMonitoring'
  | 'scripts'
  | 'thresholds'
  | 'history'
  | 'issues'
  | 'realtime'
  | 'tableSpec'
  | 'statsJob'
  | 'ilmJob'
  | 'dataPump'
  | 'objectCompare'
  | 'parameterCompare';

export interface ScreenDef {
  key: ScreenKey;
  label: string;
  group: string;
  page: string; // public/ 아래 html 파일
  defaultRole: UserRole; // 이 역할 이상이면 기본으로 보임
}

// 메뉴 순서와 같게 둔다 (첫 번째로 보이는 화면이 "갈 곳" 기본값).
const SCREENS: ScreenDef[] = [
  { key: 'databases', label: 'Databases', group: 'Databases', page: 'index.html', defaultRole: 'VIEWER' },
  { key: 'dailyMonitoring', label: 'Daily Monitoring', group: 'Monitoring', page: 'dailyMonitoring.html', defaultRole: 'VIEWER' },
  { key: 'scripts', label: 'Scripts', group: 'Monitoring', page: 'monitoringScript.html', defaultRole: 'VIEWER' },
  { key: 'thresholds', label: 'Thresholds', group: 'Monitoring', page: 'monitoringThresholds.html', defaultRole: 'VIEWER' },
  { key: 'history', label: 'Run History', group: 'Monitoring', page: 'history.html', defaultRole: 'VIEWER' },
  { key: 'issues', label: 'Issues', group: 'Monitoring', page: 'issues.html', defaultRole: 'VIEWER' },
  { key: 'realtime', label: 'Real-Time', group: 'Monitoring', page: 'realtimeMonitoring.html', defaultRole: 'VIEWER' },
  { key: 'tableSpec', label: 'Table Spec', group: 'Maintenance', page: 'tableSpec.html', defaultRole: 'DBA' },
  { key: 'statsJob', label: 'Stats Job Status', group: 'Maintenance', page: 'statsJob.html', defaultRole: 'SUPER_ADMIN' },
  { key: 'ilmJob', label: 'ILM Partition Retention', group: 'Maintenance', page: 'ilmJob.html', defaultRole: 'SUPER_ADMIN' },
  { key: 'dataPump', label: 'Data Pump', group: 'Maintenance', page: 'dataPump.html', defaultRole: 'SUPER_ADMIN' },
  { key: 'objectCompare', label: 'Object Compare', group: 'Compare', page: 'objectCompare.html', defaultRole: 'SUPER_ADMIN' },
  { key: 'parameterCompare', label: 'Parameter Compare', group: 'Compare', page: 'parameterCompare.html', defaultRole: 'SUPER_ADMIN' },
];

const SCREEN_KEYS = new Set<string>(SCREENS.map((screen) => screen.key));
const PAGE_TO_SCREEN = new Map(SCREENS.map((screen) => [`/${screen.page}`, screen.key]));
const ROLE_RANK: Record<UserRole, number> = { VIEWER: 0, DBA: 1, SUPER_ADMIN: 2 };

function isScreenKey(value: unknown): value is ScreenKey {
  return typeof value === 'string' && SCREEN_KEYS.has(value);
}

function roleDefault(screen: ScreenDef, role: UserRole | undefined): boolean {
  return role !== undefined && ROLE_RANK[role] !== undefined && ROLE_RANK[role] >= ROLE_RANK[screen.defaultRole];
}

// 역할 기본 + 사용자 예외 → 보이는 화면 목록 (메뉴 순서). DB 접근 없는 순수 함수.
function resolveVisible(role: UserRole | undefined, overrides: Map<string, boolean>): ScreenKey[] {
  return SCREENS.filter((screen) => overrides.get(screen.key) ?? roleDefault(screen, role)).map((screen) => screen.key);
}

// 요청마다 DB를 읽지 않게 사용자별 예외를 메모리에 둔다 (프로세스 하나짜리 앱). 저장하면 그 사용자 것만 비운다 —
// 역할 변경과 달리 다시 로그인하지 않아도 바로 반영된다.
const cache = new Map<number, Map<string, boolean>>();
let tableMissing = false;

function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && /ORA-00942/.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function getOverrides(userId: number): Promise<Map<string, boolean>> {
  if (tableMissing) return new Map();
  const cached = cache.get(userId);
  if (cached) return cached;
  try {
    const overrides = await screenAccessModel.listForUser(userId);
    cache.set(userId, overrides);
    return overrides;
  } catch (error) {
    if (isMissingTable(error)) {
      // 테이블이 아직 없는 환경: 역할 기본값만으로 동작 (경고는 한 번만).
      logger.warn('ScreenAccess', '화면 권한 테이블이 없어 역할 기본값만 씁니다 (scripts/add_user_screen_access.sql 실행 필요)');
      tableMissing = true;
      return new Map();
    }
    throw new Error('화면 권한 조회 실패', { cause: error });
  }
}

async function visibleScreens(userId: number, role: UserRole | undefined): Promise<ScreenKey[]> {
  return resolveVisible(role, await getOverrides(userId));
}

async function canSee(userId: number, role: UserRole | undefined, keys: ScreenKey[]): Promise<boolean> {
  const visible = await visibleScreens(userId, role);
  return keys.some((key) => visible.includes(key));
}

function screenForPage(path: string): ScreenKey | null {
  return PAGE_TO_SCREEN.get(path === '/' ? '/index.html' : path) ?? null;
}

function pageOf(key: ScreenKey): string {
  return SCREENS.find((screen) => screen.key === key)!.page;
}

// 계정 관리 화면용: 화면마다 역할 기본값과 현재 예외.
export interface UserScreenSetting extends ScreenDef {
  roleDefault: boolean;
  override: boolean | null; // null = 역할 기본값 그대로
}

async function getUserSettings(userId: number, role: UserRole): Promise<{ available: boolean; screens: UserScreenSetting[] }> {
  const overrides = await getOverrides(userId);
  return {
    available: !tableMissing,
    screens: SCREENS.map((screen) => ({ ...screen, roleDefault: roleDefault(screen, role), override: overrides.get(screen.key) ?? null })),
  };
}

// 넘어온 예외 중 역할 기본값과 같은 것은 저장하지 않는다 (나중에 역할을 바꿔도 의도대로 따라가게).
async function saveUserSettings(
  userId: number,
  role: UserRole,
  requested: Partial<Record<ScreenKey, boolean | null>>,
  updatedBy: string | null
): Promise<void> {
  if (tableMissing) throw new Error('화면 권한 테이블이 없습니다 (scripts/add_user_screen_access.sql 실행 필요)');
  const overrides = new Map<string, boolean>();
  for (const screen of SCREENS) {
    const value = requested[screen.key];
    if (typeof value === 'boolean' && value !== roleDefault(screen, role)) overrides.set(screen.key, value);
  }
  try {
    await screenAccessModel.replaceForUser(userId, overrides, updatedBy);
  } catch (error) {
    throw new Error('화면 권한 저장 실패', { cause: error });
  } finally {
    cache.delete(userId);
  }
}

export { SCREENS, isScreenKey, resolveVisible, visibleScreens, canSee, screenForPage, pageOf, getUserSettings, saveUserSettings };
