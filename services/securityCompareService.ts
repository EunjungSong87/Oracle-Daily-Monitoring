import * as securityCompareModel from '../models/securityCompareModel';
import type { SecurityLists, SecuritySelection, SecuritySnapshot } from '../models/securityCompareModel';
import type { CompareResult, DiffRow } from './objectCompareService';

// 계정·권한 비교: 두 DB에서 같은 이름의 Profile / User / Role을 맞대어 속성과 권한 차이를 찾는다.
// 결과 형식은 오브젝트 비교와 같아서 (항목 + 차이 행) 화면이 같은 표로 보여준다.

export const SECURITY_TYPES = ['PROFILE', 'USER', 'ROLE'] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

export interface SecurityItem {
  type: SecurityType;
  name: string;
  result: CompareResult;
  summary: string;
  diffs: DiffRow[];
  hasSourceDiff: false;
}

export interface SecuritySide {
  dbmsid: number | string;
}

export interface SecurityCompareResponse {
  source: SecuritySide & { dbname: string; schema: string };
  target: SecuritySide & { dbname: string; schema: string };
  types: SecurityType[];
  items: SecurityItem[];
}

export class SecurityCompareValidationError extends Error {}

// 한 번에 고를 수 있는 이름 수 (IN 목록이 Oracle 한도 1000을 넘지 않게).
const MAX_NAMES = 500;
// 딕셔너리 이름 (따옴표 없는 식별자 + 공용 사용자 C## 등). 바인드로만 쓰지만 이상한 입력은 미리 거른다.
const NAME = /^[A-Za-z0-9_$#]{1,128}$/;

function nameList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SecurityCompareValidationError(`${label} 목록 형식이 올바르지 않습니다.`);
  const names = [...new Set(value.map((item) => String(item).trim().toUpperCase()))];
  for (const name of names) {
    if (!NAME.test(name)) throw new SecurityCompareValidationError(`${label} 이름이 올바르지 않습니다: ${name}`);
  }
  if (names.length > MAX_NAMES) throw new SecurityCompareValidationError(`${label}은(는) 한 번에 ${MAX_NAMES}개까지 고를 수 있습니다.`);
  return names;
}

function parseSelection(value: unknown): SecuritySelection {
  const input = (value ?? {}) as Record<string, unknown>;
  const selection = { users: nameList(input.users, '계정'), roles: nameList(input.roles, 'Role'), profiles: nameList(input.profiles, 'Profile') };
  if (selection.users.length + selection.roles.length + selection.profiles.length === 0) {
    throw new SecurityCompareValidationError('비교할 계정 / Role / Profile을 하나 이상 골라주세요.');
  }
  return selection;
}

// ── 비교 (순수 함수) ──

const mark = (has: boolean, detail: string[] = []): string | null => (has ? (detail.length > 0 ? `있음 (${detail.join(', ')})` : '있음') : null);

function quotaText(maxBytes: number | undefined): string | null {
  if (maxBytes === undefined) return null;
  if (maxBytes < 0) return 'UNLIMITED';
  return `${Math.round((maxBytes / 1024 / 1024) * 10) / 10} MB`;
}

// 키 → 값 맵 두 개를 비교해 다른 줄만. info=true면 참고용(다름 판정 제외).
function mapDiffs(item: string, source: Map<string, string | null>, target: Map<string, string | null>, info = false): DiffRow[] {
  const keys = [...new Set([...source.keys(), ...target.keys()])].sort();
  const diffs: DiffRow[] = [];
  for (const key of keys) {
    const left = source.get(key) ?? null;
    const right = target.get(key) ?? null;
    if (left !== right) diffs.push({ item, attribute: key, source: left, target: right, ...(info ? { info: true } : {}) });
  }
  return diffs;
}

// User/Role 공통: 시스템 권한, 받은 Role(Role 안의 Role 포함), 오브젝트 권한, 컬럼 권한. 직접 부여된 것만 비교한다
// (Role을 통해 받은 권한은 "받은 Role"로 나오고, 그 Role을 같이 골라 비교하면 안의 권한 차이가 보인다).
function grantDiffs(grantee: string, source: SecuritySnapshot, target: SecuritySnapshot): DiffRow[] {
  const sys = (snapshot: SecuritySnapshot) =>
    new Map(snapshot.sysPrivs.filter((row) => row.grantee === grantee).map((row) => [row.privilege, mark(true, row.adminOption === 'YES' ? ['ADMIN'] : [])]));
  const roles = (snapshot: SecuritySnapshot) =>
    new Map(
      snapshot.rolePrivs
        .filter((row) => row.grantee === grantee)
        .map((row) => [row.role, mark(true, [...(row.adminOption === 'YES' ? ['ADMIN'] : []), ...(row.defaultRole === 'NO' ? ['기본 아님'] : [])])])
    );
  const objects = (snapshot: SecuritySnapshot) =>
    new Map(
      snapshot.tabPrivs
        .filter((row) => row.grantee === grantee)
        .map((row) => [`${row.owner}.${row.objectName} ${row.privilege}`, mark(true, row.grantable === 'YES' ? ['GRANT OPTION'] : [])])
    );
  const columns = (snapshot: SecuritySnapshot) =>
    new Map(
      snapshot.colPrivs
        .filter((row) => row.grantee === grantee)
        .map((row) => [`${row.owner}.${row.objectName}.${row.column} ${row.privilege}`, mark(true, row.grantable === 'YES' ? ['GRANT OPTION'] : [])])
    );
  return [
    ...mapDiffs('시스템 권한', sys(source), sys(target)),
    ...mapDiffs('받은 Role', roles(source), roles(target)),
    ...mapDiffs('오브젝트 권한', objects(source), objects(target)),
    ...mapDiffs('컬럼 권한', columns(source), columns(target)),
  ];
}

function attributeDiffs(pairs: [string, string | null, string | null][]): DiffRow[] {
  return pairs.filter(([, left, right]) => left !== right).map(([attribute, left, right]) => ({ item: '(속성)', attribute, source: left, target: right }));
}

function summarize(diffs: DiffRow[]): string {
  const counts = new Map<string, number>();
  for (const diff of diffs) if (!diff.info) counts.set(diff.item, (counts.get(diff.item) ?? 0) + 1);
  return [...counts].map(([item, count]) => `${item} ${count}`).join(', ');
}

function item(type: SecurityType, name: string, inSource: boolean, inTarget: boolean, diffs: DiffRow[]): SecurityItem {
  const real = diffs.filter((diff) => !diff.info);
  const result: CompareResult = !inTarget ? 'ONLY_SOURCE' : !inSource ? 'ONLY_TARGET' : real.length > 0 ? 'DIFF' : 'SAME';
  const summary = !inTarget ? '대상 DB에 없음' : !inSource ? '기준 DB에 없음' : real.length > 0 ? `차이: ${summarize(diffs)}` : '';
  return { type, name, result, summary, diffs: inSource && inTarget ? diffs : [], hasSourceDiff: false };
}

function compareSecuritySnapshots(selection: SecuritySelection, source: SecuritySnapshot, target: SecuritySnapshot): SecurityItem[] {
  const items: SecurityItem[] = [];

  for (const name of selection.profiles) {
    const limits = (snapshot: SecuritySnapshot) =>
      new Map(snapshot.profiles.filter((row) => row.profile === name).map((row) => [`${row.resource} (${row.resourceType})`, row.limit]));
    const left = limits(source);
    const right = limits(target);
    if (left.size === 0 && right.size === 0) continue; // 양쪽 다 없음
    items.push(item('PROFILE', name, left.size > 0, right.size > 0, mapDiffs('제한값', left, right)));
  }

  for (const name of selection.users) {
    const left = source.users.find((user) => user.name === name);
    const right = target.users.find((user) => user.name === name);
    if (!left && !right) continue;
    const quotas = (snapshot: SecuritySnapshot) =>
      new Map(snapshot.quotas.filter((row) => row.user === name).map((row) => [row.tablespace, quotaText(row.maxBytes)]));
    const diffs =
      left && right
        ? [
            ...attributeDiffs([
              ['계정 상태', left.accountStatus, right.accountStatus],
              ['Profile', left.profile, right.profile],
              ['기본 테이블스페이스', left.defaultTablespace, right.defaultTablespace],
              ['임시 테이블스페이스', left.temporaryTablespace, right.temporaryTablespace],
              ['인증 방식', left.authenticationType, right.authenticationType],
            ]),
            ...mapDiffs('할당량', quotas(source), quotas(target)),
            ...grantDiffs(name, source, target),
          ]
        : [];
    items.push(item('USER', name, !!left, !!right, diffs));
  }

  for (const name of selection.roles) {
    const left = source.roles.find((role) => role.name === name);
    const right = target.roles.find((role) => role.name === name);
    if (!left && !right) continue;
    // 이 Role을 받은 계정은 환경마다 다른 게 보통이라 참고용으로만 보여준다.
    const holders = (snapshot: SecuritySnapshot) =>
      new Map(snapshot.roleGrantees.filter((row) => row.role === name).map((row) => [row.grantee, mark(true, row.adminOption === 'YES' ? ['ADMIN'] : [])]));
    const diffs =
      left && right
        ? [
            ...attributeDiffs([['인증 방식', left.authenticationType, right.authenticationType]]),
            ...grantDiffs(name, source, target),
            ...mapDiffs('이 Role을 받은 계정 (참고)', holders(source), holders(target), true),
          ]
        : [];
    items.push(item('ROLE', name, !!left, !!right, diffs));
  }

  return items;
}

// ── DB를 거치는 기능 ──

// 두 DB의 목록을 합쳐서 돌려준다 (이름마다 어느 쪽에 있는지 + 오라클 기본 여부).
export interface SecurityListResponse {
  users: { name: string; oracleMaintained: boolean; inSource: boolean; inTarget: boolean }[];
  roles: { name: string; oracleMaintained: boolean; inSource: boolean; inTarget: boolean }[];
  profiles: { name: string; inSource: boolean; inTarget: boolean }[];
}

function mergeLists(source: SecurityLists, target: SecurityLists): SecurityListResponse {
  const merge = (left: { name: string; oracleMaintained: boolean }[], right: { name: string; oracleMaintained: boolean }[]) => {
    const names = [...new Set([...left.map((row) => row.name), ...right.map((row) => row.name)])].sort();
    return names.map((name) => {
      const l = left.find((row) => row.name === name);
      const r = right.find((row) => row.name === name);
      return { name, oracleMaintained: !!(l?.oracleMaintained || r?.oracleMaintained), inSource: !!l, inTarget: !!r };
    });
  };
  const profiles = [...new Set([...source.profiles, ...target.profiles])].sort();
  return {
    users: merge(source.users, target.users),
    roles: merge(source.roles, target.roles),
    profiles: profiles.map((name) => ({ name, inSource: source.profiles.includes(name), inTarget: target.profiles.includes(name) })),
  };
}

async function getLists(source: SecuritySide, target: SecuritySide): Promise<SecurityListResponse> {
  try {
    const [left, right] = await Promise.all([
      securityCompareModel.getLists({ dbmsid: source.dbmsid }),
      securityCompareModel.getLists({ dbmsid: target.dbmsid }),
    ]);
    return mergeLists(left, right);
  } catch (error) {
    throw new Error('계정/Role/Profile 목록 조회 실패', { cause: error });
  }
}

async function compare(source: SecuritySide, target: SecuritySide, selectionInput: unknown): Promise<SecurityCompareResponse> {
  const selection = parseSelection(selectionInput);
  let left: SecuritySnapshot;
  let right: SecuritySnapshot;
  try {
    [left, right] = await Promise.all([
      securityCompareModel.getSnapshot({ dbmsid: source.dbmsid }, selection),
      securityCompareModel.getSnapshot({ dbmsid: target.dbmsid }, selection),
    ]);
  } catch (error) {
    throw new Error('계정/권한 정보 조회 실패', { cause: error });
  }
  const types = SECURITY_TYPES.filter((type) =>
    type === 'PROFILE' ? selection.profiles.length > 0 : type === 'USER' ? selection.users.length > 0 : selection.roles.length > 0
  );
  return {
    source: { ...source, dbname: left.dbname, schema: '' },
    target: { ...target, dbname: right.dbname, schema: '' },
    types,
    items: compareSecuritySnapshots(selection, left, right),
  };
}

export { getLists, compare, compareSecuritySnapshots, mergeLists, parseSelection };
