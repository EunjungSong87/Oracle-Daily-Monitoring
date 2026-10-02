import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { isSuperAdmin, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { getDbmsList, runParameterCompare } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type {
  CompareResultKind,
  DbmsRow,
  ParameterCompareResponse,
  ParameterCompareSide,
  ParameterItem,
  ParameterSideValue,
} from '../../shared/lib/types';

// 페이지 간에 모듈을 직접 공유하면 Rollup이 임의 이름의 청크를 만들어서(vite.config.ts 주석 참고)
// Object Compare와 같은 라벨이라도 여기 따로 둔다.
const RESULT_LABEL: Record<CompareResultKind, string> = {
  SAME: '동일',
  DIFF: '다름',
  ONLY_SOURCE: '기준에만 있음',
  ONLY_TARGET: '대상에만 있음',
};

type ResultFilter = 'NOT_SAME' | CompareResultKind | 'ALL';
const RESULT_FILTERS: { key: ResultFilter; label: string }[] = [
  { key: 'NOT_SAME', label: '차이 전체' },
  { key: 'DIFF', label: '다름' },
  { key: 'ONLY_SOURCE', label: '기준에만 있음' },
  { key: 'ONLY_TARGET', label: '대상에만 있음' },
  { key: 'SAME', label: '동일' },
  { key: 'ALL', label: '전체' },
];

// hidden까지 읽으면 7천 건 가까이 나오므로 나눠서 그린다.
const PAGE_SIZE = 300;

function matchesResult(item: ParameterItem, filter: ResultFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'NOT_SAME') return item.result !== 'SAME';
  return item.result === filter;
}

function sourceLabel(side: ParameterCompareSide): string {
  if (side.source === 'V$PARAMETER') return 'hidden 미포함 (V$PARAMETER)';
  return side.source === 'X$' ? 'hidden 포함 (X$)' : 'hidden 포함 (X_$ 뷰)';
}

export function App(): ReactElement {
  const { user, loading: userLoading } = useCurrentUser();
  const canUse = isSuperAdmin(user);

  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [sourceDbmsId, setSourceDbmsId] = useState('');
  const [targetDbmsId, setTargetDbmsId] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ParameterCompareResponse | null>(null);
  const [comparedAt, setComparedAt] = useState<Date | null>(null);

  const [resultFilter, setResultFilter] = useState<ResultFilter>('NOT_SAME');
  const [includeHidden, setIncludeHidden] = useState(true);
  const [excludeEnvSpecific, setExcludeEnvSpecific] = useState(true);
  const [nonDefaultOnly, setNonDefaultOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!canUse) return;
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        if (rows.length > 0) {
          setSourceDbmsId(String(rows[0].ID));
          setTargetDbmsId(String(rows[Math.min(1, rows.length - 1)].ID));
        }
      })
      .catch((error) => {
        console.error('Error loading dbms list:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, [canUse]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [resultFilter, includeHidden, excludeEnvSpecific, nonDefaultOnly, search, result]);

  async function handleCompare(): Promise<void> {
    if (!sourceDbmsId || !targetDbmsId) {
      showToast('기준/대상 DBMS를 선택해주세요.', 'error');
      return;
    }
    setRunning(true);
    try {
      const response = await runParameterCompare(sourceDbmsId, targetDbmsId);
      setResult(response);
      setComparedAt(new Date());
      setResultFilter('NOT_SAME');
      setSearch('');
      showToast('파라미터 비교 완료');
    } catch (error) {
      console.error('Error comparing parameters:', error);
      showToast(error instanceof Error ? error.message : '파라미터 비교 중 오류가 발생했습니다.', 'error');
    } finally {
      setRunning(false);
    }
  }

  // 결과 탭을 제외한 조건(hidden/환경 고유/기본값/검색)까지 적용한 목록 — 탭의 건수도 이 범위에서 센다.
  const scopedItems = useMemo(() => {
    if (!result) return [];
    const keyword = search.trim().toLowerCase();
    return result.items.filter((item) => {
      if (!includeHidden && item.hidden) return false;
      if (excludeEnvSpecific && item.envSpecific) return false;
      if (nonDefaultOnly && item.source?.isDefault !== false && item.target?.isDefault !== false) return false;
      if (keyword && !item.name.includes(keyword) && !(item.description ?? '').toLowerCase().includes(keyword)) return false;
      return true;
    });
  }, [result, includeHidden, excludeEnvSpecific, nonDefaultOnly, search]);
  const filteredItems = useMemo(() => scopedItems.filter((item) => matchesResult(item, resultFilter)), [scopedItems, resultFilter]);

  return (
    <>
      <AppHeader active="parameterCompare" />
      <ToastHost />

      <h2 className="page-title">Parameter Compare (파라미터 비교)</h2>

      {!userLoading && !canUse && <p className="issues-empty">이 기능은 최고관리자만 사용할 수 있습니다.</p>}

      {canUse && (
        <>
          <div className="rt-panel">
            <h3>비교 대상</h3>
            <div className="oc-sides">
              <DbmsPicker title="기준 (Source)" id="pc-source" dbmsRows={dbmsRows} value={sourceDbmsId} onChange={setSourceDbmsId} />
              <div className="oc-sides-arrow" aria-hidden="true">
                ↔
              </div>
              <DbmsPicker title="대상 (Target)" id="pc-target" dbmsRows={dbmsRows} value={targetDbmsId} onChange={setTargetDbmsId} />
            </div>
            <p className="oc-hint">
              접속한 인스턴스의 초기화 파라미터 전체를 hidden(_) 파라미터까지 포함해 비교합니다. hidden 전체를 읽으려면
              대상 DB에 <code>scripts/grant_hidden_parameter_views.sql</code>을 SYS로 한 번 실행해 두어야 합니다.
            </p>
            <div className="oc-actions">
              <button type="button" disabled={running} onClick={handleCompare}>
                {running ? '비교 중...' : '비교 실행'}
              </button>
            </div>
          </div>

          {result && (
            <div className="rt-panel">
              <h3>
                비교 결과{' '}
                <span className="oc-subtle">{comparedAt && comparedAt.toLocaleString('ko-KR', { hour12: false })}</span>
              </h3>

              <div className="pc-side-summary">
                <SideSummary title="기준" side={result.source} />
                <SideSummary title="대상" side={result.target} />
              </div>

              {!result.hiddenFullyCompared && (
                <p className="pc-warning">
                  {result.source.hiddenIncluded || result.target.hiddenIncluded
                    ? '한쪽 DB에서 hidden 파라미터 전체를 읽지 못해, hidden은 양쪽 모두 직접 설정한(기본값이 아닌) 것만 비교했습니다.'
                    : '두 DB 모두 hidden 파라미터 전체를 읽지 못해, hidden은 직접 설정한(기본값이 아닌) 것만 비교했습니다.'}{' '}
                  전체를 비교하려면 해당 DB에 <code>scripts/grant_hidden_parameter_views.sql</code>을 SYS로 실행하세요.
                </p>
              )}

              <div className="oc-filters">
                <div className="status-tabs">
                  {RESULT_FILTERS.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      className={`status-tab${resultFilter === key ? ' status-tab-active' : ''}`}
                      onClick={() => setResultFilter(key)}
                    >
                      {label} {scopedItems.filter((item) => matchesResult(item, key)).length}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="파라미터명/설명 검색"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="파라미터 검색"
                />
              </div>
              <div className="oc-types pc-options">
                <label className="oc-check">
                  <input type="checkbox" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} />
                  hidden(_) 파라미터 포함
                </label>
                <label className="oc-check" title="db_name, instance_name, control_files, 경로(*_dest), 리스너, service_names 등">
                  <input type="checkbox" checked={excludeEnvSpecific} onChange={(e) => setExcludeEnvSpecific(e.target.checked)} />
                  DB마다 다른 게 정상인 파라미터 제외 (DB명, 경로, 리스너 등)
                </label>
                <label className="oc-check">
                  <input type="checkbox" checked={nonDefaultOnly} onChange={(e) => setNonDefaultOnly(e.target.checked)} />
                  한쪽이라도 직접 설정한(기본값 아닌) 것만
                </label>
              </div>

              {filteredItems.length === 0 ? (
                <p className="issues-empty">조건에 맞는 파라미터가 없습니다.</p>
              ) : (
                <table className="table oc-items-table pc-table">
                  <thead>
                    <tr>
                      <th>파라미터</th>
                      <th>기준 — {result.source.dbname}</th>
                      <th>대상 — {result.target.dbname}</th>
                      <th>결과</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.slice(0, visibleCount).map((item) => (
                      <tr key={item.name}>
                        <td>
                          <div className="oc-name">
                            {item.name}
                            {item.envSpecific && <span className="oc-info-tag">환경 고유</span>}
                          </div>
                          {item.description && <div className="pc-description">{item.description}</div>}
                        </td>
                        <ValueCell value={item.source} highlight={item.result === 'DIFF'} />
                        <ValueCell value={item.target} highlight={item.result === 'DIFF'} />
                        <td>
                          <span className={`issue-badge oc-badge-${item.result}`}>{RESULT_LABEL[item.result]}</span>
                        </td>
                      </tr>
                    ))}
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
          )}
        </>
      )}
    </>
  );
}

function ValueCell({ value, highlight }: { value: ParameterSideValue | null; highlight: boolean }): ReactElement {
  if (!value) {
    return (
      <td>
        <span className="oc-none">(없음)</span>
      </td>
    );
  }
  const shown = value.displayValue ?? value.value;
  return (
    <td className={`oc-value${highlight ? ' pc-value-diff' : ''}`}>
      {shown === null || shown === '' ? <span className="oc-none">(빈 값)</span> : shown}
      {value.isDefault && <span className="oc-info-tag">기본값</span>}
    </td>
  );
}

function SideSummary({ title, side }: { title: string; side: ParameterCompareSide }): ReactElement {
  return (
    <div className="oc-side">
      <div className="oc-side-title">
        {title} — {side.dbname}
      </div>
      <div className="pc-side-meta">
        {side.instance
          ? `${side.instance.instanceName} @ ${side.instance.hostName} · Oracle ${side.instance.version}`
          : '인스턴스 정보 없음 (V$INSTANCE 조회 권한 없음)'}
      </div>
      <span className={`issue-badge ${side.hiddenIncluded ? 'oc-badge-SAME' : 'oc-badge-DIFF'}`}>{sourceLabel(side)}</span>
    </div>
  );
}

interface DbmsPickerProps {
  title: string;
  id: string;
  dbmsRows: DbmsRow[];
  value: string;
  onChange: (id: string) => void;
}

function DbmsPicker({ title, id, dbmsRows, value, onChange }: DbmsPickerProps): ReactElement {
  return (
    <div className="oc-side">
      <div className="oc-side-title">{title}</div>
      <label htmlFor={id}>DBMS</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {dbmsRows.map((row) => (
          <option key={String(row.ID)} value={String(row.ID)}>
            {String(row.ID)} - {row.DBNAME}
          </option>
        ))}
      </select>
    </div>
  );
}
