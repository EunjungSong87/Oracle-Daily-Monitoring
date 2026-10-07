import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { SchemaMultiSelect } from '../../shared/components/SchemaMultiSelect';
import { getSecurityLists } from '../../shared/lib/api';
import type { SecurityListResponse, SecurityNameEntry, SecuritySelection } from '../../shared/lib/types';

interface Props {
  sourceDbmsId: string;
  targetDbmsId: string;
  selection: SecuritySelection;
  onChange: (next: SecuritySelection) => void;
}

// 계정·권한 비교에서 비교할 계정 / Role / Profile 고르기. 목록은 두 DB를 합친 것이고,
// 오라클 기본 계정·Role(SYS, DBA, CONNECT 등)은 기본으로 숨긴다.
export function SecurityPicker({ sourceDbmsId, targetDbmsId, selection, onChange }: Props): ReactElement {
  const [lists, setLists] = useState<SecurityListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeMaintained, setIncludeMaintained] = useState(false);

  // DB를 바꾸면 목록을 다시 읽고 고른 것은 비운다 (다른 DB 기준이라).
  useEffect(() => {
    setLists(null);
    setError(null);
    onChange({ users: [], roles: [], profiles: [] });
    if (!sourceDbmsId || !targetDbmsId) return;
    let cancelled = false;
    getSecurityLists(sourceDbmsId, targetDbmsId)
      .then((result) => {
        if (!cancelled) setLists(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '계정/Role/Profile 목록을 읽지 못했습니다.');
      });
    return () => {
      cancelled = true;
    };
    // onChange는 부모의 setState라 바뀌지 않으므로 의존성에서 뺀다.
  }, [sourceDbmsId, targetDbmsId]);

  const visible = useMemo(() => {
    const names = (entries: SecurityNameEntry[]) => entries.filter((entry) => includeMaintained || !entry.oracleMaintained).map((entry) => entry.name);
    return {
      users: names(lists?.users ?? []),
      roles: names(lists?.roles ?? []),
      profiles: (lists?.profiles ?? []).map((entry) => entry.name),
    };
  }, [lists, includeMaintained]);

  // 한쪽 DB에만 있는 이름 수 (참고 표시)
  const oneSided = (entries: SecurityNameEntry[] | undefined, picked: string[]) =>
    (entries ?? []).filter((entry) => picked.includes(entry.name) && (!entry.inSource || !entry.inTarget)).length;

  const field = (
    key: keyof SecuritySelection,
    label: string,
    options: string[],
    entries: SecurityNameEntry[] | undefined
  ): ReactElement => {
    const picked = selection[key];
    const onlyOne = oneSided(entries, picked);
    return (
      <div className="oc-sec-field">
        <div className="oc-types-header">
          <span className="oc-field-label">
            {label} <span className="oc-subtle">({picked.length}개 선택{onlyOne > 0 ? ` · 한쪽 DB에만 있는 것 ${onlyOne}개` : ''})</span>
          </span>
          <button type="button" className="btn-secondary" onClick={() => onChange({ ...selection, [key]: options })} disabled={options.length === 0}>
            전체 선택
          </button>
          <button type="button" className="btn-secondary" onClick={() => onChange({ ...selection, [key]: [] })}>
            전체 해제
          </button>
        </div>
        <SchemaMultiSelect
          options={options}
          selected={new Set(picked)}
          onChange={(next) => onChange({ ...selection, [key]: [...next] })}
          placeholder={`${label} 검색 (${options.length}개)`}
        />
      </div>
    );
  };

  if (error) return <p className="pc-warning">{error}</p>;
  if (!lists) return <p className="oc-detail-note">계정 / Role / Profile 목록을 읽는 중...</p>;

  return (
    <>
      {field('users', '계정 (User / 스키마)', visible.users, lists.users)}
      {field('roles', 'Role', visible.roles, lists.roles)}
      {field('profiles', 'Profile', visible.profiles, lists.profiles)}
      <label className="oc-check">
        <input type="checkbox" checked={includeMaintained} onChange={(e) => setIncludeMaintained(e.target.checked)} />
        오라클 기본 계정·Role도 목록에 보이기 (SYS, SYSTEM, DBA, CONNECT 등)
      </label>
      <p className="oc-hint">
        같은 이름끼리 양쪽 DB를 비교합니다. 계정과 Role은 속성, 시스템 권한, 받은 Role(Role 안의 Role 포함), 오브젝트 권한, 컬럼 권한을 비교하고(계정은 테이블스페이스
        할당량도), Profile은 제한값을 비교합니다. 직접 부여된 권한만 비교하므로 Role을 통해 받은 권한은 "받은 Role"로 보이고, 그 Role도 같이 고르면 안의 권한 차이가
        보입니다. 비밀번호는 비교하지 않습니다.
      </p>
    </>
  );
}
