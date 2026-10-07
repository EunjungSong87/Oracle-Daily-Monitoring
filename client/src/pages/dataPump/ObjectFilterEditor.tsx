import { useId, useMemo, useState, type ReactElement } from 'react';
import type { FilterKind, ObjectFilter, ObjectFilterRule, ObjectPathInfo, ObjectPathMode } from '../../shared/lib/types';
import { NAME_OPS } from './filterHelpers';

type FilterMode = 'NONE' | 'INCLUDE' | 'EXCLUDE' | 'BOTH';

interface Props {
  value: ObjectFilter;
  onChange: (next: ObjectFilter) => void;
  jobMode: 'SCHEMA' | 'TABLE' | 'FULL';
  objectPaths: Record<ObjectPathMode, ObjectPathInfo[]>;
  versionNumber: number;
  sqlEnabled: boolean; // "SQL 조건 사용"을 켰을 때만 서브쿼리 조건
}

const PRESETS: { label: string; rules: { kind: FilterKind; path: string }[] }[] = [
  {
    label: '인덱스·제약조건·통계 제외 (데이터 위주 이관)',
    rules: [
      { kind: 'EXCLUDE', path: 'INDEX' },
      { kind: 'EXCLUDE', path: 'CONSTRAINT' },
      { kind: 'EXCLUDE', path: 'STATISTICS' },
    ],
  },
  {
    label: '통계·GRANT 제외',
    rules: [
      { kind: 'EXCLUDE', path: 'STATISTICS' },
      { kind: 'EXCLUDE', path: 'GRANT' },
    ],
  },
  {
    label: '코드 오브젝트만 (PROCEDURE/FUNCTION/PACKAGE/TRIGGER/VIEW)',
    rules: ['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'VIEW'].map((path) => ({ kind: 'INCLUDE' as const, path })),
  },
];

function modeOf(filter: ObjectFilter): FilterMode {
  const kinds = new Set(filter.rules.map((rule) => rule.kind));
  if (kinds.has('INCLUDE') && kinds.has('EXCLUDE')) return 'BOTH';
  if (kinds.has('INCLUDE')) return 'INCLUDE';
  if (kinds.has('EXCLUDE')) return 'EXCLUDE';
  return 'NONE';
}

// 오브젝트 필터 (INCLUDE/EXCLUDE): 규칙 여러 줄 = [포함/제외] + [유형] + [이름 조건] + [값].
// 유형은 지금 작업 모드에서 쓸 수 있는 것만 (기본은 최상위 경로, "전체 경로 보기"면 TABLE/INDEX 같은 경로까지).
export function ObjectFilterEditor({ value, onChange, jobMode, objectPaths, versionNumber, sqlEnabled }: Props): ReactElement {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [showAllPaths, setShowAllPaths] = useState(false);
  const [mode, setMode] = useState<FilterMode>(modeOf(value));
  const bothAllowed = versionNumber >= 21;

  const pathMode: ObjectPathMode = jobMode === 'SCHEMA' ? 'SCHEMA' : jobMode === 'TABLE' ? 'TABLE' : 'DATABASE';
  const paths = objectPaths[pathMode] ?? [];
  const pathInfo = useMemo(() => new Map(paths.map((info) => [info.path, info])), [paths]);
  const visiblePaths = showAllPaths ? paths : paths.filter((info) => !info.path.includes('/'));
  const kinds: FilterKind[] = mode === 'INCLUDE' ? ['INCLUDE'] : mode === 'EXCLUDE' ? ['EXCLUDE'] : ['INCLUDE', 'EXCLUDE'];

  function setRules(rules: ObjectFilterRule[]): void {
    onChange({ rules });
  }

  function changeMode(next: FilterMode): void {
    setMode(next);
    // 모드에 안 맞는 규칙은 지운다 (없음이면 전부)
    setRules(next === 'NONE' ? [] : value.rules.filter((rule) => next === 'BOTH' || rule.kind === next));
  }

  function update(index: number, patch: Partial<ObjectFilterRule>): void {
    setRules(value.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  }

  function applyPreset(preset: (typeof PRESETS)[number]): void {
    const rules = preset.rules.filter((rule) => pathInfo.has(rule.path)).map((rule) => ({ ...rule, op: 'ALL' as const, values: [] }));
    const kindsInPreset = new Set(rules.map((rule) => rule.kind));
    setMode(kindsInPreset.has('INCLUDE') ? 'INCLUDE' : 'EXCLUDE');
    setRules(rules);
    setOpen(true);
  }

  const count = value.rules.length;

  return (
    <div className="dp-filter-section">
      <button type="button" className="oc-link dp-filter-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 오브젝트 필터 (INCLUDE / EXCLUDE) {count > 0 && <span className="oc-info-tag">{count}개</span>}
      </button>
      {open && (
        <div className="dp-filter-body">
          <div className="dp-source-row">
            <label>모드</label>
            <select value={mode} onChange={(e) => changeMode(e.target.value as FilterMode)}>
              <option value="NONE">없음</option>
              <option value="INCLUDE">INCLUDE (이것만 포함)</option>
              <option value="EXCLUDE">EXCLUDE (이것만 제외)</option>
              <option value="BOTH" disabled={!bothAllowed}>
                INCLUDE + EXCLUDE {bothAllowed ? '' : '(Oracle 21c 이상)'}
              </option>
            </select>
            <label className="oc-check">
              <input type="checkbox" checked={showAllPaths} onChange={(e) => setShowAllPaths(e.target.checked)} />
              전체 경로 보기 (TABLE/INDEX 같은 하위 경로까지)
            </label>
          </div>
          <div className="dp-buttons">
            {PRESETS.map((preset) => {
              const usable = preset.rules.some((rule) => pathInfo.has(rule.path));
              return (
                <button key={preset.label} type="button" className="btn-secondary" disabled={!usable} title={usable ? undefined : '이 작업 모드에서는 쓸 수 없는 유형입니다.'} onClick={() => applyPreset(preset)}>
                  {preset.label}
                </button>
              );
            })}
          </div>

          <datalist id={listId}>
            {visiblePaths.map((info) => (
              <option key={info.path} value={info.path}>
                {info.comments}
              </option>
            ))}
          </datalist>

          {value.rules.length > 0 && (
            <table className="table oc-items-table dp-filter-table">
              <thead>
                <tr>
                  <th>포함/제외</th>
                  <th>오브젝트 유형</th>
                  <th>이름 조건</th>
                  <th>값</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {value.rules.map((rule, index) => {
                  const info = pathInfo.get(rule.path.toUpperCase());
                  const namedOk = !info || info.named;
                  return (
                    <tr key={index}>
                      <td>
                        <select value={rule.kind} onChange={(e) => update(index, { kind: e.target.value as FilterKind })}>
                          {kinds.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          list={listId}
                          value={rule.path}
                          placeholder="유형 검색 (예: INDEX)"
                          onChange={(e) => {
                            const path = e.target.value.toUpperCase();
                            const nextInfo = pathInfo.get(path);
                            update(index, nextInfo && !nextInfo.named ? { path, op: 'ALL', values: [] } : { path });
                          }}
                        />
                        {rule.path && !info && <div className="dp-hint-line pc-warning-text">이 모드에서 쓸 수 없는 유형</div>}
                        {info && <div className="dp-hint-line">{info.comments}</div>}
                      </td>
                      <td>
                        <select
                          value={rule.op}
                          disabled={!namedOk}
                          title={namedOk ? undefined : '이름으로 거를 수 없는 유형입니다 (전체만).'}
                          onChange={(e) => update(index, { op: e.target.value as ObjectFilterRule['op'], values: [], subquery: null })}
                        >
                          {NAME_OPS.filter((op) => op.value !== 'SUBQUERY' || sqlEnabled || rule.op === 'SUBQUERY').map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {rule.op === 'SUBQUERY' ? (
                          <textarea
                            className="dp-sql-input"
                            placeholder="SELECT table_name FROM ... (IN (서브쿼리)로 쓰입니다)"
                            value={rule.subquery ?? ''}
                            disabled={!sqlEnabled}
                            onChange={(e) => update(index, { subquery: e.target.value })}
                          />
                        ) : rule.op !== 'ALL' ? (
                          <input
                            type="text"
                            placeholder={rule.op === 'IN' || rule.op === 'NOT IN' ? '쉼표로 여러 개 (TMP_A, TMP_B)' : rule.op.includes('LIKE') ? '패턴 (예: PKG_%)' : '이름'}
                            value={(rule.values ?? []).join(', ')}
                            onChange={(e) =>
                              update(index, {
                                values:
                                  rule.op === 'IN' || rule.op === 'NOT IN'
                                    ? e.target.value.split(',').map((item) => item.trim().toUpperCase())
                                    : [e.target.value.trim().toUpperCase()],
                              })
                            }
                          />
                        ) : (
                          <span className="oc-none">유형 전체</span>
                        )}
                      </td>
                      <td>
                        <button type="button" className="btn-secondary" onClick={() => setRules(value.rules.filter((_, i) => i !== index))}>
                          삭제
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="dp-buttons">
            <button
              type="button"
              className="btn-secondary"
              disabled={mode === 'NONE'}
              onClick={() => setRules([...value.rules, { kind: kinds[0], path: '', op: 'ALL', values: [] }])}
            >
              + 규칙 추가
            </button>
          </div>
          <p className="oc-hint">
            EXCLUDE 이름 조건은 여러 개가 각각 적용됩니다 (어느 하나라도 맞으면 제외). 같은 유형의 INCLUDE 이름 조건은 =/IN끼리만 합칠 수 있습니다.
            {!bothAllowed && ' INCLUDE와 EXCLUDE를 같이 쓰는 것은 Oracle 21c부터라, 이 DB에서는 INCLUDE를 쓰면 "통계 제외"도 꺼집니다.'}
          </p>
        </div>
      )}
    </div>
  );
}
