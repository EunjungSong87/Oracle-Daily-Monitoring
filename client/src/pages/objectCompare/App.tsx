import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getCompareSchemas, getDbmsList, runObjectCompare, runSecurityCompare } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import { SchemaMultiSelect } from '../../shared/components/SchemaMultiSelect';
import type { CompareItem, CompareResponse, CompareResultKind, DbmsRow, SchemaPair, SecuritySelection, SourceDiffLine } from '../../shared/lib/types';
import { ItemDetail } from './ItemDetail';
import { OBJECT_TYPES, RESULT_LABEL } from './objectTypes';
import { SecurityPicker } from './SecurityPicker';

// 결과 목록 필터. NOT_SAME(차이 전체)이 기본값 — 보통 동일한 오브젝트가 대부분이라 차이만 먼저 보여준다.
type ResultFilter = 'NOT_SAME' | CompareResultKind | 'ALL';
const RESULT_FILTERS: { key: ResultFilter; label: string }[] = [
  { key: 'NOT_SAME', label: '차이 전체' },
  { key: 'DIFF', label: '다름' },
  { key: 'ONLY_SOURCE', label: '기준에만 있음' },
  { key: 'ONLY_TARGET', label: '대상에만 있음' },
  { key: 'SAME', label: '동일' },
  { key: 'ALL', label: '전체' },
];

// 한 번에 그리는 행 수. 스키마가 크면 수천 건이 나올 수 있어서 나눠서 그린다.
const PAGE_SIZE = 300;

const RESULT_KINDS: CompareResultKind[] = ['DIFF', 'ONLY_SOURCE', 'ONLY_TARGET', 'SAME'];

function matchesFilter(item: CompareItem, filter: ResultFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'NOT_SAME') return item.result !== 'SAME';
  return item.result === filter;
}

function itemKey(item: CompareItem): string {
  return `${item.sourceSchema ?? ''}\u0000${item.type}\u0000${item.name}`;
}

// 목록의 "스키마" 칸: 같은 이름이면 하나만, 다르면 기준 → 대상. TABLESPACE는 DB 전체.
function pairLabel(item: CompareItem): string {
  if (!item.sourceSchema) return '(DB 전체)';
  return item.sourceSchema === item.targetSchema ? item.sourceSchema : `${item.sourceSchema} → ${item.targetSchema}`;
}

// DBMS를 고르면 그 DB의 스키마 목록을 불러온다.
function useSchemaList(dbmsId: string): string[] | 'loading' {
  const [schemas, setSchemas] = useState<string[] | 'loading'>([]);

  useEffect(() => {
    if (!dbmsId) return;
    let cancelled = false;
    setSchemas('loading');
    getCompareSchemas(dbmsId)
      .then((owners) => {
        if (cancelled) return;
        setSchemas(owners);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Error loading schemas:', error);
        showToast(error instanceof Error ? error.message : '스키마 목록 조회 실패', 'error');
        setSchemas([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dbmsId]);

  return schemas;
}

export function App(): ReactElement {
  const { user, loading: userLoading } = useCurrentUser();
  const canUse = canSee(user, 'objectCompare');

  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [sourceDbmsId, setSourceDbmsId] = useState('');
  const [targetDbmsId, setTargetDbmsId] = useState('');
  const sourceSchemaList = useSchemaList(sourceDbmsId);
  const targetSchemaList = useSchemaList(targetDbmsId);

  // 기준 스키마는 여러 개 고르고, 스키마마다 비교할 대상 스키마를 짝짓는다. 대상은 따로 고르지 않으면
  // 서로 다른 DB일 때 같은 이름 스키마로 맞춘다 (같은 DB 안에서는 자기 자신과 비교할 수 없어 직접 골라야 함).
  const [sourceSchemas, setSourceSchemas] = useState<Set<string>>(new Set());
  const [targetOf, setTargetOf] = useState<Record<string, string>>({});
  useEffect(() => {
    setSourceSchemas(new Set());
  }, [sourceDbmsId]);
  useEffect(() => {
    setTargetOf({});
  }, [targetDbmsId]);
  const targetList = Array.isArray(targetSchemaList) ? targetSchemaList : [];
  const sameDbms = sourceDbmsId === targetDbmsId;
  const pairs: SchemaPair[] = [...sourceSchemas].sort().map((schema) => {
    const picked = targetOf[schema];
    const fallback = !sameDbms && targetList.includes(schema) ? schema : '';
    return { source: schema, target: picked && targetList.includes(picked) ? picked : fallback };
  });

  const [types, setTypes] = useState<Set<string>>(new Set(OBJECT_TYPES));
  // 오브젝트 비교(스키마) / 계정·권한 비교 (Profile, User, Role과 그 권한)
  const [mode, setMode] = useState<'OBJECT' | 'SECURITY'>('OBJECT');
  const [securitySelection, setSecuritySelection] = useState<SecuritySelection>({ users: [], roles: [], profiles: [] });
  const [ignoreTablespace, setIgnoreTablespace] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [comparedAt, setComparedAt] = useState<Date | null>(null);

  const [resultFilter, setResultFilter] = useState<ResultFilter>('NOT_SAME');
  const [typeFilter, setTypeFilter] = useState('');
  const [schemaFilter, setSchemaFilter] = useState(''); // 여러 스키마 비교에서 기준 스키마 하나만 보기
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const diffCacheRef = useRef(new Map<string, SourceDiffLine[]>());

  useEffect(() => {
    if (!canUse) return;
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        if (rows.length > 0) {
          setSourceDbmsId(String(rows[0].ID));
          // 보통 서로 다른 두 DB를 비교하므로 대상은 두 번째 DB를 기본으로 고른다 (하나뿐이면 같은 DB의 다른 스키마 비교).
          setTargetDbmsId(String(rows[Math.min(1, rows.length - 1)].ID));
        }
      })
      .catch((error) => {
        console.error('Error loading dbms list:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, [canUse]);

  // 필터가 바뀌면 다시 첫 페이지부터 보여준다.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [resultFilter, typeFilter, schemaFilter, search, result]);

  function toggleType(type: string): void {
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function handleCompare(): Promise<void> {
    if (!sourceDbmsId || !targetDbmsId) {
      showToast('기준/대상 DBMS를 선택해주세요.', 'error');
      return;
    }
    if (mode === 'OBJECT') {
      if (pairs.length === 0) {
        showToast('기준 스키마를 하나 이상 골라주세요.', 'error');
        return;
      }
      const unpaired = pairs.filter((pair) => !pair.target).map((pair) => pair.source);
      if (unpaired.length > 0) {
        showToast(`대상 스키마를 골라주세요: ${unpaired.join(', ')}`, 'error');
        return;
      }
      const targets = pairs.map((pair) => pair.target);
      const duplicated = targets.find((name, index) => targets.indexOf(name) !== index);
      if (duplicated) {
        showToast(`대상 스키마 ${duplicated}가 두 기준 스키마에 짝지어져 있습니다.`, 'error');
        return;
      }
      if (types.size === 0) {
        showToast('비교할 오브젝트 종류를 하나 이상 선택해주세요.', 'error');
        return;
      }
    } else if (securitySelection.users.length + securitySelection.roles.length + securitySelection.profiles.length === 0) {
      showToast('비교할 계정 / Role / Profile을 하나 이상 골라주세요.', 'error');
      return;
    }
    setRunning(true);
    try {
      const response =
        mode === 'OBJECT'
          ? await runObjectCompare(
              sourceDbmsId,
              targetDbmsId,
              pairs,
              OBJECT_TYPES.filter((type) => types.has(type)),
              ignoreTablespace
            )
          : await runSecurityCompare(sourceDbmsId, targetDbmsId, securitySelection);
      diffCacheRef.current = new Map();
      setExpanded(new Set());
      setTypeFilter('');
      setSchemaFilter('');
      setSearch('');
      setResultFilter('NOT_SAME');
      setResult(response);
      setComparedAt(new Date());
      const differences = response.items.filter((item) => item.result !== 'SAME').length;
      showToast(differences === 0 ? '비교 완료: 차이가 없습니다.' : `비교 완료: 차이 ${differences}건`);
    } catch (error) {
      console.error('Error comparing:', error);
      showToast(error instanceof Error ? error.message : '비교 중 오류가 발생했습니다.', 'error');
    } finally {
      setRunning(false);
    }
  }

  // 오브젝트 ↔ 계정·권한을 바꾸면 이전 결과는 다른 종류라 지운다.
  function changeMode(next: 'OBJECT' | 'SECURITY'): void {
    if (next === mode) return;
    setMode(next);
    setResult(null);
  }

  function toggleExpanded(key: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 여러 스키마를 비교한 결과인지 (스키마 칸/필터를 보일지)
  const resultPairs = useMemo(() => result?.pairs ?? [], [result]);
  const multiSchema = resultPairs.length > 1;
  // 스키마 필터를 건 항목 (TABLESPACE는 DB 전체라 스키마를 고르면 빠진다)
  const schemaItems = useMemo(() => {
    if (!result) return [];
    return schemaFilter ? result.items.filter((item) => item.sourceSchema === schemaFilter) : result.items;
  }, [result, schemaFilter]);

  // 타입별 집계 (요약 표). 스키마 필터가 있으면 그 스키마만.
  const summary = useMemo(() => {
    if (!result) return [];
    return result.types
      .map((type) => {
        const counts: Record<CompareResultKind, number> = { SAME: 0, DIFF: 0, ONLY_SOURCE: 0, ONLY_TARGET: 0 };
        for (const item of schemaItems) {
          if (item.type === type) counts[item.result]++;
        }
        return { type, counts, total: counts.SAME + counts.DIFF + counts.ONLY_SOURCE + counts.ONLY_TARGET };
      })
      .filter((row) => !schemaFilter || row.type !== 'TABLESPACE');
  }, [result, schemaItems, schemaFilter]);

  // 스키마별 차이 건수 (여러 스키마 비교 요약)
  const schemaSummary = useMemo(
    () =>
      resultPairs.map((pair) => {
        const own = (result?.items ?? []).filter((item) => item.sourceSchema === pair.source);
        return { pair, total: own.length, differences: own.filter((item) => item.result !== 'SAME').length };
      }),
    [result, resultPairs]
  );

  // 스키마/타입/이름 검색까지 적용한 목록 — 결과 필터 탭의 건수도 이 범위 안에서 센다. 검색은 스키마 이름에도 걸린다.
  const scopedItems = useMemo(() => {
    const keyword = search.trim().toUpperCase();
    return schemaItems.filter(
      (item) =>
        (!typeFilter || item.type === typeFilter) &&
        (!keyword || item.name.toUpperCase().includes(keyword) || (item.sourceSchema ?? '').toUpperCase().includes(keyword))
    );
  }, [schemaItems, typeFilter, search]);
  const filteredItems = useMemo(
    () => scopedItems.filter((item) => matchesFilter(item, resultFilter)),
    [scopedItems, resultFilter]
  );

  function pickSummaryCell(type: string, filter: ResultFilter): void {
    setTypeFilter(type);
    setResultFilter(filter);
    setSearch('');
  }

  // 계정·권한 비교는 스키마가 없어 DB 이름만
  const sideName = (side: CompareResponse['source']) => (side.schema ? `${side.dbname}.${side.schema}` : side.dbname);
  const sourceLabel = result ? sideName(result.source) : '';
  const targetLabel = result ? sideName(result.target) : '';

  return (
    <>
      <AppHeader active="objectCompare" />
      <ToastHost />

      <h2 className="page-title">Object Compare (오브젝트 · 계정·권한 비교)</h2>

      {!userLoading && !canUse && <p className="issues-empty">이 화면을 사용할 권한이 없습니다. 최고관리자에게 화면 권한을 요청하세요.</p>}

      {canUse && (
        <>
          <div className="rt-panel">
            <div className="status-tabs oc-mode-tabs">
              <button type="button" className={`status-tab${mode === 'OBJECT' ? ' status-tab-active' : ''}`} onClick={() => changeMode('OBJECT')}>
                오브젝트
              </button>
              <button type="button" className={`status-tab${mode === 'SECURITY' ? ' status-tab-active' : ''}`} onClick={() => changeMode('SECURITY')}>
                계정·권한
              </button>
            </div>
            <h3>비교 조건</h3>
            <div className="oc-sides">
              <SidePicker title="기준 (Source)" idPrefix="oc-source" dbmsRows={dbmsRows} dbmsId={sourceDbmsId} onDbmsChange={setSourceDbmsId}>
                {mode === 'OBJECT' && (
                  <>
                    <label>스키마 (여러 개 선택 가능)</label>
                    {sourceSchemaList === 'loading' ? (
                      <p className="oc-subtle">불러오는 중...</p>
                    ) : (
                      <SchemaMultiSelect
                        options={sourceSchemaList}
                        selected={sourceSchemas}
                        onChange={setSourceSchemas}
                        placeholder={`스키마 검색 (${sourceSchemaList.length}개, ${sourceSchemas.size}개 선택)`}
                      />
                    )}
                  </>
                )}
              </SidePicker>
              <div className="oc-sides-arrow" aria-hidden="true">
                ↔
              </div>
              <SidePicker title="대상 (Target)" idPrefix="oc-target" dbmsRows={dbmsRows} dbmsId={targetDbmsId} onDbmsChange={setTargetDbmsId}>
                {mode === 'OBJECT' && (
                  <p className="oc-hint">
                    {targetSchemaList === 'loading'
                      ? '스키마 목록을 불러오는 중...'
                      : sameDbms
                        ? '같은 DB 안의 다른 스키마와 비교합니다 — 아래 표에서 기준 스키마마다 대상 스키마를 골라주세요.'
                        : '기준 스키마마다 같은 이름의 스키마와 비교합니다. 다른 스키마와 비교하려면 아래 표에서 바꾸세요.'}
                  </p>
                )}
              </SidePicker>
            </div>

            {mode === 'OBJECT' && pairs.length > 0 && (
              <table className="table oc-items-table oc-pairs-table">
                <thead>
                  <tr>
                    <th>기준 스키마</th>
                    <th></th>
                    <th>대상 스키마</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((pair) => (
                    <tr key={pair.source}>
                      <td className="oc-name">{pair.source}</td>
                      <td aria-hidden="true">→</td>
                      <td>
                        <select
                          value={pair.target}
                          aria-label={`${pair.source}의 대상 스키마`}
                          onChange={(e) => setTargetOf((current) => ({ ...current, [pair.source]: e.target.value }))}
                        >
                          <option value="">{targetList.length === 0 ? '대상 스키마 없음' : '선택'}</option>
                          {targetList
                            .filter((schema) => !(sameDbms && schema === pair.source))
                            .map((schema) => (
                              <option key={schema} value={schema}>
                                {schema}
                              </option>
                            ))}
                        </select>
                        {!pair.target && (
                          <span className="pc-warning-text">
                            {sameDbms ? ' 같은 DB라 비교할 다른 스키마를 골라주세요' : ' 대상에 같은 이름 스키마가 없습니다 — 골라주세요'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {mode === 'SECURITY' ? (
              <SecurityPicker sourceDbmsId={sourceDbmsId} targetDbmsId={targetDbmsId} selection={securitySelection} onChange={setSecuritySelection} />
            ) : (
              <>
                <div className="oc-types-header">
                  <span className="oc-field-label">비교할 오브젝트 종류</span>
                  <button type="button" className="btn-secondary" onClick={() => setTypes(new Set(OBJECT_TYPES))}>
                    전체 선택
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setTypes(new Set())}>
                    전체 해제
                  </button>
                </div>
                <div className="oc-types">
                  {OBJECT_TYPES.map((type) => (
                    <label key={type} className="oc-check">
                      <input type="checkbox" checked={types.has(type)} onChange={() => toggleType(type)} />
                      {type}
                    </label>
                  ))}
                </div>
                <p className="oc-hint">
                  TABLESPACE는 스키마와 상관없이 DB 전체의 테이블스페이스를 비교합니다. 나머지는 선택한 스키마의 오브젝트만 비교합니다.
                </p>

                <label className="oc-check">
                  <input type="checkbox" checked={ignoreTablespace} onChange={(e) => setIgnoreTablespace(e.target.checked)} />
                  테이블/인덱스가 저장된 테이블스페이스 이름 차이는 무시
                </label>
              </>
            )}

            <div className="oc-actions">
              <button type="button" disabled={running} onClick={handleCompare}>
                {running ? '비교 중...' : '비교 실행'}
              </button>
            </div>
          </div>

          {result && (
            <>
              <div className="rt-panel">
                <h3>
                  비교 요약{' '}
                  <span className="oc-subtle">
                    기준 {sourceLabel} ↔ 대상 {targetLabel}
                    {comparedAt && ` · ${comparedAt.toLocaleString('ko-KR', { hour12: false })}`}
                  </span>
                </h3>
                {multiSchema && (
                  <div className="oc-schema-summary">
                    {schemaSummary.map(({ pair, total, differences }) => (
                      <button
                        key={pair.source}
                        type="button"
                        className={`status-tab${schemaFilter === pair.source ? ' status-tab-active' : ''}`}
                        onClick={() => setSchemaFilter(schemaFilter === pair.source ? '' : pair.source)}
                        title={`${total}개 중 차이 ${differences}개 — 누르면 이 스키마만 봅니다`}
                      >
                        {pair.source === pair.target ? pair.source : `${pair.source} → ${pair.target}`}{' '}
                        <span className={differences > 0 ? 'oc-count-DIFF' : 'oc-none'}>차이 {differences}</span>
                      </button>
                    ))}
                  </div>
                )}
                <table className="table oc-summary-table">
                  <thead>
                    <tr>
                      <th>종류</th>
                      <th>전체</th>
                      {RESULT_KINDS.map((kind) => (
                        <th key={kind}>{RESULT_LABEL[kind]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((row) => (
                      <tr key={row.type}>
                        <td>
                          <button type="button" className="oc-link" onClick={() => pickSummaryCell(row.type, 'ALL')}>
                            {row.type}
                          </button>
                        </td>
                        <td>{row.total}</td>
                        {RESULT_KINDS.map((kind) => (
                          <td key={kind}>
                            {row.counts[kind] === 0 ? (
                              <span className="oc-none">0</span>
                            ) : (
                              <button
                                type="button"
                                className={`oc-link oc-count oc-count-${kind}`}
                                onClick={() => pickSummaryCell(row.type, kind)}
                              >
                                {row.counts[kind]}
                              </button>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="oc-hint">숫자를 누르면 아래 목록이 그 조건으로 걸러집니다.</p>
              </div>

              <div className="rt-panel">
                <h3>
                  {mode === 'SECURITY' ? '계정·권한 목록' : '오브젝트 목록'} <span className="oc-subtle">({filteredItems.length}건)</span>
                </h3>
                <div className="oc-filters">
                  <div className="status-tabs">
                    {RESULT_FILTERS.map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        className={`status-tab${resultFilter === key ? ' status-tab-active' : ''}`}
                        onClick={() => setResultFilter(key)}
                      >
                        {label} {scopedItems.filter((item) => matchesFilter(item, key)).length}
                      </button>
                    ))}
                  </div>
                  {multiSchema && (
                    <select value={schemaFilter} onChange={(e) => setSchemaFilter(e.target.value)} aria-label="스키마">
                      <option value="">모든 스키마</option>
                      {resultPairs.map((pair) => (
                        <option key={pair.source} value={pair.source}>
                          {pair.source === pair.target ? pair.source : `${pair.source} → ${pair.target}`}
                        </option>
                      ))}
                    </select>
                  )}
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="오브젝트 종류">
                    <option value="">모든 종류</option>
                    {result.types.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder="이름 검색"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="오브젝트 이름 검색"
                  />
                </div>

                {filteredItems.length === 0 ? (
                  <p className="issues-empty">조건에 맞는 오브젝트가 없습니다.</p>
                ) : (
                  <table className="table oc-items-table">
                    <thead>
                      <tr>
                        {multiSchema && <th>스키마</th>}
                        <th>종류</th>
                        <th>이름</th>
                        <th>결과</th>
                        <th>내용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.slice(0, visibleCount).map((item) => {
                        const key = itemKey(item);
                        const open = expanded.has(key);
                        return (
                          <Fragment key={key}>
                            <tr className="oc-item-row" onClick={() => toggleExpanded(key)}>
                              {multiSchema && <td className="oc-name">{pairLabel(item)}</td>}
                              <td>{item.type}</td>
                              <td className="oc-name">
                                <span className="oc-caret">{open ? '▾' : '▸'}</span>
                                {item.name}
                              </td>
                              <td>
                                <span className={`issue-badge oc-badge-${item.result}`}>{RESULT_LABEL[item.result]}</span>
                              </td>
                              <td>{item.summary}</td>
                            </tr>
                            {open && (
                              <tr className="oc-detail-row">
                                <td colSpan={multiSchema ? 5 : 4}>
                                  <ItemDetail item={item} result={result} diffCache={diffCacheRef.current} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {filteredItems.length > visibleCount && (
                  <div className="oc-actions">
                    <button type="button" className="btn-secondary" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                      더 보기 ({filteredItems.length - visibleCount}건 남음)
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

interface SidePickerProps {
  title: string;
  idPrefix: string;
  dbmsRows: DbmsRow[];
  dbmsId: string;
  onDbmsChange: (id: string) => void;
  children?: ReactNode; // DBMS 아래에 붙는 스키마 선택 등 (계정·권한 비교는 없음)
}

function SidePicker({ title, idPrefix, dbmsRows, dbmsId, onDbmsChange, children }: SidePickerProps): ReactElement {
  return (
    <div className="oc-side">
      <div className="oc-side-title">{title}</div>
      <label htmlFor={`${idPrefix}-dbms`}>DBMS</label>
      <select id={`${idPrefix}-dbms`} value={dbmsId} onChange={(e) => onDbmsChange(e.target.value)}>
        {dbmsRows.map((row) => (
          <option key={String(row.ID)} value={String(row.ID)}>
            {String(row.ID)} - {row.DBNAME}
          </option>
        ))}
      </select>
      {children}
    </div>
  );
}
