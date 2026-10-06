import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getCompareSchemas, getDbmsList, runObjectCompare } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { CompareItem, CompareResponse, CompareResultKind, DbmsRow, SourceDiffLine } from '../../shared/lib/types';
import { ItemDetail } from './ItemDetail';
import { OBJECT_TYPES, RESULT_LABEL } from './objectTypes';

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
  return `${item.type}\u0000${item.name}`;
}

// DBMS를 고르면 그 DB의 스키마 목록을 불러온다. preferred(상대편에서 고른 스키마명)가 있으면 그걸 먼저 고른다.
function useSchemaPicker(dbmsId: string, preferred: string): {
  schemas: string[] | 'loading';
  schema: string;
  setSchema: (schema: string) => void;
} {
  const [schemas, setSchemas] = useState<string[] | 'loading'>([]);
  const [schema, setSchema] = useState('');
  const preferredRef = useRef(preferred);
  preferredRef.current = preferred;

  useEffect(() => {
    if (!dbmsId) return;
    let cancelled = false;
    setSchemas('loading');
    setSchema('');
    getCompareSchemas(dbmsId)
      .then((owners) => {
        if (cancelled) return;
        setSchemas(owners);
        setSchema(owners.includes(preferredRef.current) ? preferredRef.current : (owners[0] ?? ''));
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

  return { schemas, schema, setSchema };
}

export function App(): ReactElement {
  const { user, loading: userLoading } = useCurrentUser();
  const canUse = canSee(user, 'objectCompare');

  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [sourceDbmsId, setSourceDbmsId] = useState('');
  const [targetDbmsId, setTargetDbmsId] = useState('');
  const source = useSchemaPicker(sourceDbmsId, '');
  const target = useSchemaPicker(targetDbmsId, source.schema);

  // 보통 양쪽에서 같은 이름의 스키마를 비교하므로, 기준 스키마를 바꾸면 서로 다른 DB일 때에 한해 대상도
  // 같은 이름으로 따라가게 한다 (같은 DB 안에서는 스키마가 달라야 의미가 있으므로 건드리지 않는다).
  const targetSchemas = target.schemas;
  const setTargetSchema = target.setSchema;
  useEffect(() => {
    if (sourceDbmsId === targetDbmsId) return;
    if (source.schema && Array.isArray(targetSchemas) && targetSchemas.includes(source.schema)) {
      setTargetSchema(source.schema);
    }
  }, [source.schema, sourceDbmsId, targetDbmsId, targetSchemas, setTargetSchema]);

  const [types, setTypes] = useState<Set<string>>(new Set(OBJECT_TYPES));
  const [ignoreTablespace, setIgnoreTablespace] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [comparedAt, setComparedAt] = useState<Date | null>(null);

  const [resultFilter, setResultFilter] = useState<ResultFilter>('NOT_SAME');
  const [typeFilter, setTypeFilter] = useState('');
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
  }, [resultFilter, typeFilter, search, result]);

  function toggleType(type: string): void {
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function handleCompare(): Promise<void> {
    if (!sourceDbmsId || !targetDbmsId || !source.schema || !target.schema) {
      showToast('기준/대상 DBMS와 스키마를 모두 선택해주세요.', 'error');
      return;
    }
    if (types.size === 0) {
      showToast('비교할 오브젝트 종류를 하나 이상 선택해주세요.', 'error');
      return;
    }
    setRunning(true);
    try {
      const response = await runObjectCompare(
        { dbmsid: sourceDbmsId, schema: source.schema },
        { dbmsid: targetDbmsId, schema: target.schema },
        OBJECT_TYPES.filter((type) => types.has(type)),
        ignoreTablespace
      );
      diffCacheRef.current = new Map();
      setExpanded(new Set());
      setTypeFilter('');
      setSearch('');
      setResultFilter('NOT_SAME');
      setResult(response);
      setComparedAt(new Date());
      const differences = response.items.filter((item) => item.result !== 'SAME').length;
      showToast(differences === 0 ? '비교 완료: 차이가 없습니다.' : `비교 완료: 차이 ${differences}건`);
    } catch (error) {
      console.error('Error comparing objects:', error);
      showToast(error instanceof Error ? error.message : '오브젝트 비교 중 오류가 발생했습니다.', 'error');
    } finally {
      setRunning(false);
    }
  }

  function toggleExpanded(key: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 타입별 집계 (요약 표).
  const summary = useMemo(() => {
    if (!result) return [];
    return result.types.map((type) => {
      const counts: Record<CompareResultKind, number> = { SAME: 0, DIFF: 0, ONLY_SOURCE: 0, ONLY_TARGET: 0 };
      for (const item of result.items) {
        if (item.type === type) counts[item.result]++;
      }
      return { type, counts, total: counts.SAME + counts.DIFF + counts.ONLY_SOURCE + counts.ONLY_TARGET };
    });
  }, [result]);

  // 타입/이름 검색까지 적용한 목록 — 결과 필터 탭의 건수도 이 범위 안에서 센다.
  const scopedItems = useMemo(() => {
    if (!result) return [];
    const keyword = search.trim().toUpperCase();
    return result.items.filter(
      (item) => (!typeFilter || item.type === typeFilter) && (!keyword || item.name.toUpperCase().includes(keyword))
    );
  }, [result, typeFilter, search]);
  const filteredItems = useMemo(
    () => scopedItems.filter((item) => matchesFilter(item, resultFilter)),
    [scopedItems, resultFilter]
  );

  function pickSummaryCell(type: string, filter: ResultFilter): void {
    setTypeFilter(type);
    setResultFilter(filter);
    setSearch('');
  }

  const sourceLabel = result ? `${result.source.dbname}.${result.source.schema}` : '';
  const targetLabel = result ? `${result.target.dbname}.${result.target.schema}` : '';

  return (
    <>
      <AppHeader active="objectCompare" />
      <ToastHost />

      <h2 className="page-title">Object Compare (오브젝트 비교)</h2>

      {!userLoading && !canUse && <p className="issues-empty">이 화면을 사용할 권한이 없습니다. 최고관리자에게 화면 권한을 요청하세요.</p>}

      {canUse && (
        <>
          <div className="rt-panel">
            <h3>비교 조건</h3>
            <div className="oc-sides">
              <SidePicker
                title="기준 (Source)"
                idPrefix="oc-source"
                dbmsRows={dbmsRows}
                dbmsId={sourceDbmsId}
                onDbmsChange={setSourceDbmsId}
                schemas={source.schemas}
                schema={source.schema}
                onSchemaChange={source.setSchema}
              />
              <div className="oc-sides-arrow" aria-hidden="true">
                ↔
              </div>
              <SidePicker
                title="대상 (Target)"
                idPrefix="oc-target"
                dbmsRows={dbmsRows}
                dbmsId={targetDbmsId}
                onDbmsChange={setTargetDbmsId}
                schemas={target.schemas}
                schema={target.schema}
                onSchemaChange={target.setSchema}
              />
            </div>

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
                  오브젝트 목록 <span className="oc-subtle">({filteredItems.length}건)</span>
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
                                <td colSpan={4}>
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
  schemas: string[] | 'loading';
  schema: string;
  onSchemaChange: (schema: string) => void;
}

function SidePicker({ title, idPrefix, dbmsRows, dbmsId, onDbmsChange, schemas, schema, onSchemaChange }: SidePickerProps): ReactElement {
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
      <label htmlFor={`${idPrefix}-schema`}>스키마</label>
      <select
        id={`${idPrefix}-schema`}
        value={schema}
        disabled={schemas === 'loading'}
        onChange={(e) => onSchemaChange(e.target.value)}
      >
        {schemas === 'loading' && <option value="">불러오는 중...</option>}
        {Array.isArray(schemas) && schemas.length === 0 && <option value="">스키마가 없습니다</option>}
        {Array.isArray(schemas) &&
          schemas.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
      </select>
    </div>
  );
}
