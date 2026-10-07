import { describe, expect, it } from 'vitest';
import { compareSecuritySnapshots, mergeLists, parseSelection, SecurityCompareValidationError } from './securityCompareService';
import type { SecuritySnapshot } from '../models/securityCompareModel';

function snapshot(overrides: Partial<SecuritySnapshot> = {}): SecuritySnapshot {
  return {
    dbname: 'DB',
    users: [],
    roles: [],
    profiles: [],
    quotas: [],
    sysPrivs: [],
    rolePrivs: [],
    tabPrivs: [],
    colPrivs: [],
    roleGrantees: [],
    ...overrides,
  };
}

const HR = { name: 'HR', accountStatus: 'OPEN', profile: 'DEFAULT', defaultTablespace: 'USERS', temporaryTablespace: 'TEMP', authenticationType: 'PASSWORD' };

describe('compareSecuritySnapshots — User', () => {
  it('속성, 할당량, 시스템 권한, Role, 오브젝트 권한 차이를 찾는다', () => {
    const source = snapshot({
      users: [HR],
      quotas: [{ user: 'HR', tablespace: 'USERS', maxBytes: -1 }],
      sysPrivs: [
        { grantee: 'HR', privilege: 'CREATE SESSION', adminOption: 'NO' },
        { grantee: 'HR', privilege: 'CREATE VIEW', adminOption: 'NO' },
      ],
      rolePrivs: [{ grantee: 'HR', role: 'APP_ROLE', adminOption: 'NO', defaultRole: 'YES' }],
      tabPrivs: [{ grantee: 'HR', owner: 'SALES', objectName: 'ORDERS', privilege: 'SELECT', grantable: 'NO' }],
    });
    const target = snapshot({
      users: [{ ...HR, accountStatus: 'LOCKED', profile: 'APP_PROFILE' }],
      quotas: [{ user: 'HR', tablespace: 'USERS', maxBytes: 100 * 1024 * 1024 }],
      sysPrivs: [{ grantee: 'HR', privilege: 'CREATE SESSION', adminOption: 'YES' }],
      rolePrivs: [{ grantee: 'HR', role: 'APP_ROLE', adminOption: 'NO', defaultRole: 'YES' }],
      tabPrivs: [{ grantee: 'HR', owner: 'SALES', objectName: 'ORDERS', privilege: 'SELECT', grantable: 'YES' }],
    });
    const [item] = compareSecuritySnapshots({ users: ['HR'], roles: [], profiles: [] }, source, target);
    expect(item.result).toBe('DIFF');
    expect(item.diffs.map((d) => [d.item, d.attribute, d.source, d.target])).toEqual([
      ['(속성)', '계정 상태', 'OPEN', 'LOCKED'],
      ['(속성)', 'Profile', 'DEFAULT', 'APP_PROFILE'],
      ['할당량', 'USERS', 'UNLIMITED', '100 MB'],
      ['시스템 권한', 'CREATE SESSION', '있음', '있음 (ADMIN)'],
      ['시스템 권한', 'CREATE VIEW', '있음', null],
      ['오브젝트 권한', 'SALES.ORDERS SELECT', '있음', '있음 (GRANT OPTION)'],
    ]);
    expect(item.summary).toBe('차이: (속성) 2, 할당량 1, 시스템 권한 2, 오브젝트 권한 1');
  });

  it('한쪽에만 있는 계정, 양쪽 다 없는 계정은 빼고 같은 계정은 SAME', () => {
    const items = compareSecuritySnapshots(
      { users: ['HR', 'ONLY_SRC', 'NOWHERE'], roles: [], profiles: [] },
      snapshot({ users: [HR, { ...HR, name: 'ONLY_SRC' }] }),
      snapshot({ users: [HR] })
    );
    expect(items.map((i) => [i.name, i.result])).toEqual([
      ['HR', 'SAME'],
      ['ONLY_SRC', 'ONLY_SOURCE'],
    ]);
  });
});

describe('compareSecuritySnapshots — Role / Profile', () => {
  it('Role의 권한 차이는 다름, 그 Role을 받은 계정 차이는 참고용(판정 제외)', () => {
    const role = { name: 'APP_ROLE', authenticationType: 'NONE' };
    const items = compareSecuritySnapshots(
      { users: [], roles: ['APP_ROLE'], profiles: [] },
      snapshot({ roles: [role], roleGrantees: [{ grantee: 'HR', role: 'APP_ROLE', adminOption: 'NO', defaultRole: 'YES' }] }),
      snapshot({ roles: [role], roleGrantees: [{ grantee: 'SCOTT', role: 'APP_ROLE', adminOption: 'NO', defaultRole: 'YES' }] })
    );
    expect(items[0].result).toBe('SAME');
    expect(items[0].diffs.every((d) => d.info)).toBe(true);
    expect(items[0].diffs.map((d) => d.attribute)).toEqual(['HR', 'SCOTT']);

    const withPriv = compareSecuritySnapshots(
      { users: [], roles: ['APP_ROLE'], profiles: [] },
      snapshot({ roles: [role], tabPrivs: [{ grantee: 'APP_ROLE', owner: 'SALES', objectName: 'ORDERS', privilege: 'INSERT', grantable: 'NO' }] }),
      snapshot({ roles: [role] })
    );
    expect(withPriv[0]).toMatchObject({ result: 'DIFF', summary: '차이: 오브젝트 권한 1' });
  });

  it('Profile은 제한값을 항목별로 비교', () => {
    const limit = (resource: string, value: string) => ({ profile: 'APP', resource, resourceType: 'PASSWORD', limit: value });
    const [item] = compareSecuritySnapshots(
      { users: [], roles: [], profiles: ['APP'] },
      snapshot({ profiles: [limit('FAILED_LOGIN_ATTEMPTS', '5'), limit('PASSWORD_LIFE_TIME', '90')] }),
      snapshot({ profiles: [limit('FAILED_LOGIN_ATTEMPTS', '10'), limit('PASSWORD_LIFE_TIME', '90')] })
    );
    expect(item.diffs.map((d) => [d.attribute, d.source, d.target])).toEqual([['FAILED_LOGIN_ATTEMPTS (PASSWORD)', '5', '10']]);
  });
});

describe('parseSelection / mergeLists', () => {
  it('대문자로 정리하고 이상한 이름·빈 선택은 거부', () => {
    expect(parseSelection({ users: ['hr', 'HR'], roles: ['app_role'] })).toEqual({ users: ['HR'], roles: ['APP_ROLE'], profiles: [] });
    expect(() => parseSelection({ users: ["HR' OR 1=1"] })).toThrow(SecurityCompareValidationError);
    expect(() => parseSelection({})).toThrow(/하나 이상/);
  });

  it('두 DB 목록을 합치고 어느 쪽에 있는지 표시', () => {
    const merged = mergeLists(
      { users: [{ name: 'HR', oracleMaintained: false }], roles: [{ name: 'DBA', oracleMaintained: true }], profiles: ['DEFAULT'] },
      { users: [{ name: 'HR', oracleMaintained: false }, { name: 'SCOTT', oracleMaintained: false }], roles: [], profiles: ['DEFAULT', 'APP'] }
    );
    expect(merged.users).toEqual([
      { name: 'HR', oracleMaintained: false, inSource: true, inTarget: true },
      { name: 'SCOTT', oracleMaintained: false, inSource: false, inTarget: true },
    ]);
    expect(merged.roles).toEqual([{ name: 'DBA', oracleMaintained: true, inSource: true, inTarget: false }]);
    expect(merged.profiles.map((p) => p.name)).toEqual(['APP', 'DEFAULT']);
  });
});
