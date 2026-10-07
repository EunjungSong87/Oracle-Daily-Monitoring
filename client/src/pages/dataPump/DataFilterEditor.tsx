import { useEffect, useState, type ReactElement } from 'react';
import { SchemaMultiSelect } from '../../shared/components/SchemaMultiSelect';
import { getDataPumpViews } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DataFilter, ViewAsTable } from '../../shared/lib/types';
import { countDataFilter, DATA_OPTIONS, parseTarget, targetText } from './filterHelpers';

interface Props {
  value: DataFilter;
  onChange: (next: DataFilter) => void;
  operation: 'EXPORT' | 'IMPORT';
  networkLink: string | null; // DB 링크 작업이면 링크 이름
  versionNumber: number;
  sqlAllowed: boolean; // DBA 이상
  sqlEnabled: boolean;
  onSqlEnabledChange: (next: boolean) => void;
  tableExistsAction?: string | null; // Import
  allowViews: boolean; // VIEWS_AS_TABLES를 보일지 (Export, DB 링크 Import)
  viewSchemas?: string[]; // 뷰를 고를 스키마 목록
  dbmsId: string;
  partitionImport?: boolean; // 파티션 덤프 Import 화면 (안내 문구)
}

// 데이터 필터·옵션: QUERY(행 조건), SAMPLE(비율), DATA_OPTIONS, VIEWS_AS_TABLES.
export function DataFilterEditor({
  value,
  onChange,
  operation,
  networkLink,
  versionNumber,
  sqlAllowed,
  sqlEnabled,
  onSqlEnabledChange,
  tableExistsAction,
  allowViews,
  viewSchemas = [],
  dbmsId,
  partitionImport,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const isExport = operation === 'EXPORT';
  const networkImport = !isExport && !!networkLink;
  const allowSample = isExport && !networkLink;
  const queries = value.queries ?? [];
  const samples = value.samples ?? [];
  const dataOptions = value.dataOptions ?? [];
  const views = value.viewsAsTables ?? [];

  const options = DATA_OPTIONS.filter((option) => option.operations.includes(operation) && (!option.networkImportOnly || networkImport));

  // 뷰 고르기: 스키마 → 그 스키마의 뷰 목록
  const [viewOwner, setViewOwner] = useState('');
  const [viewList, setViewList] = useState<string[]>([]);
  useEffect(() => {
    setViewList([]);
    if (!viewOwner) return;
    let cancelled = false;
    getDataPumpViews(dbmsId, viewOwner, networkLink)
      .then((result) => {
        if (!cancelled) setViewList(result);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : '뷰 목록을 읽지 못했습니다.', 'error'));
    return () => {
      cancelled = true;
    };
  }, [dbmsId, viewOwner, networkLink]);

  const set = (patch: Partial<DataFilter>) => onChange({ ...value, ...patch });
  const pickedViews = new Set(views.filter((view) => view.owner === viewOwner).map((view) => view.view));

  function setPickedViews(next: Set<string>): void {
    const others = views.filter((view) => view.owner !== viewOwner);
    const kept = views.filter((view) => view.owner === viewOwner && next.has(view.view));
    const added: ViewAsTable[] = [...next].filter((name) => !kept.some((view) => view.view === name)).map((name) => ({ owner: viewOwner, view: name, template: null }));
    set({ viewsAsTables: [...others, ...kept, ...added] });
  }

  const count = countDataFilter(value);

  return (
    <div className="dp-filter-section">
      <button type="button" className="oc-link dp-filter-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 데이터 필터·옵션 (QUERY / SAMPLE / DATA_OPTIONS{allowViews ? ' / VIEWS_AS_TABLES' : ''}) {count > 0 && <span className="oc-info-tag">{count}개</span>}
      </button>
      {open && (
        <div className="dp-filter-body">
          {/* QUERY */}
          <div className="dp-filter-sub">
            <div className="dp-source-row">
              <strong>QUERY (행 조건)</strong>
              {sqlAllowed ? (
                <label className="oc-check">
                  <input type="checkbox" checked={sqlEnabled} onChange={(e) => onSqlEnabledChange(e.target.checked)} />
                  SQL 조건 사용
                </label>
              ) : (
                <span className="oc-subtle">SQL 조건(QUERY, 서브쿼리)은 DBA 이상만 쓸 수 있습니다.</span>
              )}
            </div>
            {sqlEnabled &&
              queries.map((query, index) => (
                <div key={index} className="dp-filter-row">
                  <input
                    type="text"
                    placeholder="OWNER.TABLE (비우면 모든 테이블)"
                    value={targetText(query.owner, query.table)}
                    onChange={(e) => set({ queries: queries.map((item, i) => (i === index ? { ...item, ...parseTarget(e.target.value) } : item)) })}
                  />
                  <textarea
                    className="dp-sql-input"
                    placeholder="WHERE order_dt >= DATE '2026-01-01'"
                    value={query.where}
                    onChange={(e) => set({ queries: queries.map((item, i) => (i === index ? { ...item, where: e.target.value } : item)) })}
                  />
                  <button type="button" className="btn-secondary" onClick={() => set({ queries: queries.filter((_, i) => i !== index) })}>
                    삭제
                  </button>
                </div>
              ))}
            {sqlEnabled && (
              <div className="dp-buttons">
                <button type="button" className="btn-secondary" onClick={() => set({ queries: [...queries, { owner: null, table: null, where: '' }] })}>
                  + QUERY 추가
                </button>
              </div>
            )}
            <p className="oc-hint">
              WHERE 또는 ORDER BY로 시작하고, 세미콜론·주석·큰따옴표·DML/DDL은 쓸 수 없습니다. QUERY를 쓰면 direct path 대신 external table 방식이라 느려질 수
              있습니다. CONTENT=METADATA_ONLY와는 같이 못 씁니다.
            </p>
          </div>

          {/* SAMPLE */}
          {isExport && (
            <div className="dp-filter-sub">
              <strong>SAMPLE (비율)</strong>
              {!allowSample && <span className="oc-subtle"> — DB 링크(NETWORK_LINK) Export에는 쓸 수 없습니다.</span>}
              {allowSample &&
                samples.map((sample, index) => (
                  <div key={index} className="dp-filter-row">
                    <input
                      type="text"
                      placeholder="OWNER.TABLE (비우면 모든 테이블)"
                      value={targetText(sample.owner, sample.table)}
                      onChange={(e) => set({ samples: samples.map((item, i) => (i === index ? { ...item, ...parseTarget(e.target.value) } : item)) })}
                    />
                    <input
                      type="number"
                      min={0.000001}
                      max={99.999999}
                      step="any"
                      value={sample.percent}
                      onChange={(e) => set({ samples: samples.map((item, i) => (i === index ? { ...item, percent: Number(e.target.value) } : item)) })}
                    />
                    <span>%</span>
                    <button type="button" className="btn-secondary" onClick={() => set({ samples: samples.filter((_, i) => i !== index) })}>
                      삭제
                    </button>
                  </div>
                ))}
              {allowSample && (
                <div className="dp-buttons">
                  <button type="button" className="btn-secondary" onClick={() => set({ samples: [...samples, { owner: null, table: null, percent: 10 }] })}>
                    + SAMPLE 추가
                  </button>
                </div>
              )}
              {allowSample && <p className="oc-hint">데이터 블록 표본 비율 (0.000001 이상 100 미만). 분할 계획 크기에도 그 비율로 반영됩니다.</p>}
            </div>
          )}

          {/* DATA_OPTIONS */}
          <div className="dp-filter-sub">
            <strong>DATA_OPTIONS</strong>
            <div className="oc-types">
              {options.map((option) => {
                const supported = versionNumber >= option.since;
                const needsTea = option.name === 'TRUST_EXISTING_TABLE_PARTITIONS' && tableExistsAction !== 'APPEND' && tableExistsAction !== 'TRUNCATE';
                const disabled = !supported || needsTea;
                return (
                  <label key={option.name} className="oc-check" title={option.label}>
                    <input
                      type="checkbox"
                      disabled={disabled && !dataOptions.includes(option.name)}
                      checked={dataOptions.includes(option.name)}
                      onChange={(e) =>
                        set({ dataOptions: e.target.checked ? [...dataOptions, option.name] : dataOptions.filter((name) => name !== option.name) })
                      }
                    />
                    {option.name}
                    <span className="oc-subtle">
                      {' '}
                      — {option.label}
                      {!supported && ` (Oracle ${option.since} 이상)`}
                      {supported && needsTea && ' (TABLE_EXISTS_ACTION=APPEND/TRUNCATE일 때)'}
                    </span>
                  </label>
                );
              })}
            </div>
            {partitionImport && (
              <p className="oc-hint">
                대상 파티션 정의가 원본과 같으면 TRUST_EXISTING_TABLE_PARTITIONS로 파티션을 동시에 적재할 수 있습니다. 여러 작업이 같은 테이블에 동시에 쓰면
                DISABLE_APPEND_HINT를 켜서 잠금 대기를 피하는 것을 권장합니다.
              </p>
            )}
          </div>

          {/* VIEWS_AS_TABLES */}
          {allowViews && (
            <div className="dp-filter-sub">
              <strong>VIEWS_AS_TABLES (뷰를 테이블로)</strong>
              <div className="dp-source-row">
                <label>스키마</label>
                <select value={viewOwner} onChange={(e) => setViewOwner(e.target.value)}>
                  <option value="">선택</option>
                  {viewSchemas.map((schema) => (
                    <option key={schema} value={schema}>
                      {schema}
                    </option>
                  ))}
                </select>
              </div>
              {viewOwner && (
                <SchemaMultiSelect options={viewList} selected={pickedViews} onChange={setPickedViews} placeholder={`뷰 검색 (${viewList.length}개)`} />
              )}
              {views.length > 0 && (
                <table className="table oc-items-table dp-filter-table">
                  <thead>
                    <tr>
                      <th>뷰</th>
                      <th>템플릿 테이블 (선택, 같은 스키마)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {views.map((view, index) => (
                      <tr key={`${view.owner}.${view.view}`}>
                        <td className="oc-name">
                          {view.owner}.{view.view}
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="없으면 뷰 정의로 테이블을 만듦"
                            value={view.template ?? ''}
                            onChange={(e) =>
                              set({ viewsAsTables: views.map((item, i) => (i === index ? { ...item, template: e.target.value.trim().toUpperCase() || null } : item)) })
                            }
                          />
                        </td>
                        <td>
                          <button type="button" className="btn-secondary" onClick={() => set({ viewsAsTables: views.filter((_, i) => i !== index) })}>
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="oc-hint">
                테이블 모드에서만 됩니다 (Export는 뷰만 따로 한 작업으로 묶습니다). 뷰는 LOB/LONG 컬럼이 없어야 하고, 템플릿 테이블은 뷰와 같은 스키마의 파티션 없는 일반
                테이블이어야 합니다. 크기는 알 수 없어 분할 계획에 0으로 잡힙니다.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
