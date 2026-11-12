import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import {
  ApiError,
  compileMigrationVerify,
  countMigrationVerify,
  downloadMigrationVerifyExcel,
  getDbmsList,
  getMigrationVerifyPlans,
  getRemapSets,
  runMigrationVerify,
} from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsRow, MigrationFinding, MigrationVerifyPlanRow, MigrationVerifyResult, MigrationVerifyScope, RemapSet } from '../../shared/lib/types';
import { ConfirmModal } from '../dataPump/ConfirmModal';

// Maintenance > 이관 검증: 이관한 범위(테이블/파티션)만 행 수·테이블스페이스 위치·정리 항목을 원본과 비교한다.
// 행 수는 기본이 Export/Import 로그 대조(DB 조회 없음), COUNT는 고른 테이블만.

const MAX_COUNT = 20;
const CATEGORY_LABEL: Record<MigrationFinding['category'], string> = {
  INVALID: 'INVALID 오브젝트',
  UNUSABLE: 'UNUSABLE 인덱스',
  CONSTRAINT: '제약조건',
  TRIGGER: '비활성 트리거',
  NO_STATS: '통계 없음',
  PRIVILEGE: '빠진 권한',
};

function copy(text: string, label: string): void {
  navigator.clipboard
    .writeText(text)
    .then(() => showToast(`${label} 복사했습니다.`))
    .catch(() => showToast('복사하지 못했습니다.', 'error'));
}

export function App(): ReactElement {
  const { user, loading } = useCurrentUser();
  const canUse = canSee(user, 'migrationVerify');
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [plans, setPlans] = useState<MigrationVerifyPlanRow[]>([]);
  const [remapSets, setRemapSets] = useState<RemapSet[]>([]);
  const [mode, setMode] = useState<'PLAN' | 'LIST'>('PLAN');
  const [planId, setPlanId] = useState('');
  const [list, setList] = useState('');
  const [sourceDbmsId, setSourceDbmsId] = useState('');
  const [targetDbmsId, setTargetDbmsId] = useState('');
  const [remapSetId, setRemapSetId] = useState('');
  const [result, setResult] = useState<MigrationVerifyResult | null>(null);
  const [scope, setScope] = useState<MigrationVerifyScope | null>(null);
  const [running, setRunning] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [countPick, setCountPick] = useState<Set<string>>(new Set());
  const [counting, setCounting] = useState(false);
  const [compilePick, setCompilePick] = useState<Set<string>>(new Set());
  const [confirmCompile, setConfirmCompile] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<{ message: string; items: string[] } | null>(null);

  useEffect(() => {
    if (!canUse) return;
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        if (rows.length > 0) {
          setSourceDbmsId(String(rows[0].ID));
          setTargetDbmsId(String(rows[0].ID));
        }
      })
      .catch(() => showToast('DBMS 목록 조회 실패', 'error'));
    getMigrationVerifyPlans()
      .then(setPlans)
      .catch((err) => setError({ message: err instanceof Error ? err.message : '이관 Import 목록을 읽지 못했습니다.', items: [] }));
    getRemapSets()
      .then(setRemapSets)
      .catch(() => setRemapSets([]));
  }, [canUse]);

  const dbname = (id: string | number) => dbmsRows.find((row) => String(row.ID) === String(id))?.DBNAME ?? String(id);

  async function run(nextScope?: MigrationVerifyScope): Promise<void> {
    const target = nextScope ?? (mode === 'PLAN' ? { planId } : { list, sourceDbmsId, targetDbmsId, remapSetId: remapSetId || undefined });
    setRunning(true);
    setError(null);
    try {
      const verified = await runMigrationVerify(target);
      setResult(verified);
      setScope(target);
      setCountPick(new Set());
      setCompilePick(new Set());
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : '검증하지 못했습니다.', items: err instanceof ApiError ? err.items : [] });
    } finally {
      setRunning(false);
    }
  }

  async function count(): Promise<void> {
    if (!result || !scope) return;
    setCounting(true);
    try {
      const rows = await countMigrationVerify(scope, [...countPick]);
      const updated = result.rows.map((row) => rows.find((item) => item.targetKey === row.targetKey) ?? row);
      const status = (key: 'MATCH' | 'MISMATCH' | 'UNKNOWN') => updated.filter((row) => row.status === key).length;
      setResult({ ...result, rows: updated, summary: { ...result.summary, rows: { MATCH: status('MATCH'), MISMATCH: status('MISMATCH'), UNKNOWN: status('UNKNOWN') } } });
      setCountPick(new Set());
      showToast(`${rows.length}개 테이블을 COUNT했습니다.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'COUNT하지 못했습니다.', 'error');
    } finally {
      setCounting(false);
    }
  }

  async function compile(typed: string): Promise<void> {
    if (!result || !scope) return;
    setCompiling(true);
    try {
      const objects = result.findings.filter((f) => compilePick.has(`${f.owner}.${f.name}.${f.type}`)).map((f) => ({ owner: f.owner, name: f.name, type: f.type }));
      const results = await compileMigrationVerify(scope, objects, typed);
      const failed = results.filter((r) => !r.ok);
      showToast(`재컴파일 ${results.length}개 중 ${results.length - failed.length}개 VALID${failed.length > 0 ? ` · 실패 ${failed.map((r) => `${r.owner}.${r.name}`).join(', ')}` : ''}`, failed.length > 0 ? 'error' : undefined);
      setConfirmCompile(false);
      await run(scope);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '재컴파일하지 못했습니다.', 'error');
    } finally {
      setCompiling(false);
    }
  }

  const rows = useMemo(() => (result ? result.rows.filter((row) => !problemsOnly || row.status !== 'MATCH') : []), [result, problemsOnly]);
  const tablespaces = useMemo(() => (result ? result.tablespaces.filter((row) => !problemsOnly || row.status !== '일치') : []), [result, problemsOnly]);
  const findings = useMemo(() => (result ? result.findings.filter((row) => !problemsOnly || row.origin === '새로 생김') : []), [result, problemsOnly]);
  const actionSql = result ? result.findings.filter((f) => f.sql && (f.category === 'UNUSABLE' || f.category === 'NO_STATS')).map((f) => f.sql as string) : [];
  const s = result?.summary;

  return (
    <>
      <AppHeader active="migrationVerify" />
      <ToastHost />
      <h2 className="page-title">이관 검증</h2>
      {!loading && !canUse && <p className="issues-empty">이 화면을 볼 권한이 없습니다.</p>}
      {canUse && (
        <div className="rt-panel">
          <h3>1. 범위</h3>
          <div className="status-tabs" role="group" aria-label="범위 고르기">
            <button type="button" className={`status-tab${mode === 'PLAN' ? ' status-tab-active' : ''}`} onClick={() => setMode('PLAN')}>
              이관 Import에서
            </button>
            <button type="button" className={`status-tab${mode === 'LIST' ? ' status-tab-active' : ''}`} onClick={() => setMode('LIST')}>
              목록 붙여넣기
            </button>
          </div>
          {mode === 'PLAN' && (
            <select aria-label="이관 Import" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">이관 Import 선택…</option>
              {plans.map((plan) => (
                <option key={plan.planId} value={plan.planId}>
                  {plan.createdAt} · {dbname(plan.sourceDbmsId)} → {dbname(plan.targetDbmsId)} · 작업 {plan.jobs}개 · {plan.createdBy ?? ''}
                </option>
              ))}
            </select>
          )}
          {mode === 'LIST' && (
            <>
              <textarea rows={6} placeholder={'한 줄에 하나씩 (원본 이름)\nHR.EMP\nSALES.ORDERS:P2026_01'} value={list} onChange={(e) => setList(e.target.value)} />
              <div className="dp-grid">
                <div>
                  <label htmlFor="mv-src">원본 DB</label>
                  <select id="mv-src" value={sourceDbmsId} onChange={(e) => setSourceDbmsId(e.target.value)}>
                    {dbmsRows.map((row) => (
                      <option key={String(row.ID)} value={String(row.ID)}>
                        {row.DBNAME}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="mv-tgt">대상 DB</label>
                  <select id="mv-tgt" value={targetDbmsId} onChange={(e) => setTargetDbmsId(e.target.value)}>
                    {dbmsRows.map((row) => (
                      <option key={String(row.ID)} value={String(row.ID)}>
                        {row.DBNAME}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="mv-map">매핑표</label>
                  <select id="mv-map" value={remapSetId} onChange={(e) => setRemapSetId(e.target.value)}>
                    <option value="">없음 (이름 그대로)</option>
                    {remapSets.map((set) => (
                      <option key={set.id} value={String(set.id)}>
                        {set.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}
          <div className="oc-actions dp-buttons">
            <button type="button" disabled={running || (mode === 'PLAN' ? !planId : !list.trim())} onClick={() => run()}>
              {running ? '검증 중...' : '검증'}
            </button>
          </div>
          <p className="oc-hint">
            원본·대상 DB는 범위 테이블의 OWNER+이름 조건으로만 읽습니다 (딕셔너리 뷰, DBA_SEGMENTS 안 씀). 행 수는 Export/Import 로그로 대조하고, 실제 COUNT는 아래에서 고른 테이블만
            합니다.
          </p>
        </div>
      )}

      {error && (
        <div className="pc-warning dp-items-box">
          <strong>{error.message}</strong>
          {error.items.length > 0 && <textarea readOnly rows={Math.min(10, error.items.length + 1)} value={error.items.join('\n')} />}
        </div>
      )}

      {result && s && (
        <>
          <div className="rt-panel">
            <div className="rt-panel-header">
              <h3>
                2. 결과 — {result.label} · {result.sourceDbname} → {result.targetDbname}
              </h3>
              <div className="rt-panel-controls">
                <label className="oc-check">
                  <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> 문제만 보기
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => downloadMigrationVerifyExcel(result).catch((err) => showToast(err instanceof Error ? err.message : '엑셀을 만들지 못했습니다.', 'error'))}
                >
                  엑셀 내보내기
                </button>
              </div>
            </div>
            <div className="dash-summary">
              <div>
                <span>범위</span>
                <strong>{s.total}</strong>
              </div>
              <div className={s.rows.MISMATCH > 0 ? 'dash-summary-bad' : undefined}>
                <span>행 수 일치 / 불일치 / 미확인</span>
                <strong>
                  {s.rows.MATCH} / {s.rows.MISMATCH} / {s.rows.UNKNOWN}
                </strong>
              </div>
              <div className={s.tablespaces.mismatch + s.tablespaces.suspect + s.tablespaces.missing > 0 ? 'dash-summary-bad' : undefined}>
                <span>테이블스페이스 일치 / 불일치</span>
                <strong>
                  {s.tablespaces.match} / {s.tablespaces.mismatch + s.tablespaces.suspect + s.tablespaces.missing}
                </strong>
                <em>
                  매핑 누락 의심 {s.tablespaces.suspect} · 대상에 없음 {s.tablespaces.missing}
                </em>
              </div>
              <div className={s.cleanup.new > 0 ? 'dash-summary-warn' : undefined}>
                <span>정리 항목 (새로 생김)</span>
                <strong>
                  {s.cleanup.total} ({s.cleanup.new})
                </strong>
              </div>
            </div>
            {result.notes.map((note) => (
              <p key={note} className="pc-warning">
                {note}
              </p>
            ))}
          </div>

          <div className="rt-panel">
            <div className="rt-panel-header">
              <h3>행 수</h3>
              <button type="button" className="btn-secondary" disabled={counting || countPick.size === 0} onClick={count}>
                {counting ? 'COUNT 중...' : `고른 테이블 COUNT (${countPick.size}/${MAX_COUNT})`}
              </button>
            </div>
            <table className="table oc-items-table">
              <thead>
                <tr>
                  <th>COUNT</th>
                  <th>대상</th>
                  <th>원본</th>
                  <th>Export 로그</th>
                  <th>Import 로그</th>
                  <th>원본 COUNT</th>
                  <th>대상 COUNT</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const filter = result.rowFilters[row.targetKey];
                  return (
                    <tr key={row.targetKey}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${row.targetKey} COUNT`}
                          checked={countPick.has(row.targetKey)}
                          disabled={!countPick.has(row.targetKey) && countPick.size >= MAX_COUNT}
                          onChange={(e) => {
                            const next = new Set(countPick);
                            if (e.target.checked) next.add(row.targetKey);
                            else next.delete(row.targetKey);
                            setCountPick(next);
                          }}
                        />
                      </td>
                      <td className="oc-name">{row.targetKey}</td>
                      <td className="oc-name">
                        {row.sourceKey}
                        {filter?.kind === 'QUERY' && <div className="dp-hint-line">QUERY {filter.where}</div>}
                        {filter?.kind === 'SAMPLE' && <div className="dp-hint-line">SAMPLE (COUNT 비교 불가)</div>}
                      </td>
                      <td>{row.exportRows ?? '-'}</td>
                      <td>{row.importRows ?? '-'}</td>
                      <td>{row.sourceCount ?? '-'}</td>
                      <td>{row.targetCount ?? '-'}</td>
                      <td className={row.status === 'MATCH' ? 'dash-ok' : row.status === 'MISMATCH' ? 'dash-bad' : 'dp-warn'}>
                        {row.status === 'MATCH' ? '일치' : row.status === 'MISMATCH' ? '불일치' : '미확인'}
                        <div className="dp-hint-line">{row.detail}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="issues-empty">표시할 항목이 없습니다.</p>}
          </div>

          <div className="rt-panel">
            <h3>테이블스페이스 위치 (매핑 기준 기대값 vs 실제)</h3>
            <table className="table oc-items-table">
              <thead>
                <tr>
                  <th>종류</th>
                  <th>테이블</th>
                  <th>오브젝트</th>
                  <th>파티션</th>
                  <th>원본</th>
                  <th>기대</th>
                  <th>실제</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {tablespaces.map((row, index) => (
                  <tr key={`${row.kind}:${row.table}:${row.object}:${row.partition}:${row.subpartition}:${index}`}>
                    <td>{row.kind}</td>
                    <td className="oc-name">{row.table}</td>
                    <td className="oc-name">{row.object || '-'}</td>
                    <td>{[row.partition, row.subpartition].filter(Boolean).join(' / ') || '-'}</td>
                    <td>{row.sourceTablespace ?? '-'}</td>
                    <td>{row.expected ?? '-'}</td>
                    <td>{row.actual ?? '-'}</td>
                    <td className={row.status === '일치' ? 'dash-ok' : 'dash-bad'}>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tablespaces.length === 0 && <p className="issues-empty">표시할 항목이 없습니다.</p>}
          </div>

          <div className="rt-panel">
            <div className="rt-panel-header">
              <h3>정리 점검 (원본에서도 같은 상태면 &quot;원래 그랬음&quot;)</h3>
              <div className="rt-panel-controls">
                {actionSql.length > 0 && (
                  <button type="button" className="btn-secondary" onClick={() => copy(actionSql.join('\n'), `REBUILD/통계 SQL ${actionSql.length}개를`)}>
                    REBUILD·통계 SQL 복사 ({actionSql.length})
                  </button>
                )}
                {isSuperAdmin && (
                  <button type="button" className="btn-danger" disabled={compilePick.size === 0} onClick={() => setConfirmCompile(true)}>
                    고른 INVALID 재컴파일 ({compilePick.size})
                  </button>
                )}
              </div>
            </div>
            <table className="table oc-items-table">
              <thead>
                <tr>
                  {isSuperAdmin && <th></th>}
                  <th>분류</th>
                  <th>오브젝트</th>
                  <th>테이블</th>
                  <th>내용</th>
                  <th>원본 대비</th>
                  <th>조치 SQL</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f, index) => {
                  const key = `${f.owner}.${f.name}.${f.type}`;
                  return (
                    <tr key={`${f.category}:${key}:${f.partition}:${index}`}>
                      {isSuperAdmin && (
                        <td>
                          {f.compilable && (
                            <input
                              type="checkbox"
                              aria-label={`${key} 재컴파일`}
                              checked={compilePick.has(key)}
                              onChange={(e) => {
                                const next = new Set(compilePick);
                                if (e.target.checked) next.add(key);
                                else next.delete(key);
                                setCompilePick(next);
                              }}
                            />
                          )}
                        </td>
                      )}
                      <td>{CATEGORY_LABEL[f.category]}</td>
                      <td className="oc-name">
                        {f.owner}.{f.name}
                        <div className="dp-hint-line">{f.type}</div>
                      </td>
                      <td className="oc-name">
                        {f.table ?? '-'}
                        {f.partition ? `:${f.partition}` : ''}
                      </td>
                      <td>{f.detail}</td>
                      <td className={f.origin === '새로 생김' ? 'dash-bad' : 'oc-subtle'}>{f.origin}</td>
                      <td>
                        {f.sql && (
                          <>
                            <code className="dp-sql">{f.sql}</code>{' '}
                            <button type="button" className="oc-link" onClick={() => copy(f.sql as string, 'SQL을')}>
                              복사
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {findings.length === 0 && <p className="issues-empty">표시할 항목이 없습니다.</p>}
            <p className="oc-hint">REBUILD와 통계 수집은 SQL만 만들어 드립니다 (복사해서 직접 실행). INVALID 재컴파일은 최고관리자만, 대상 DB명 확인 후 실행하고 기록이 남습니다.</p>
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmCompile}
        title="INVALID 오브젝트 재컴파일"
        confirmLabel="재컴파일"
        danger
        requireText={result?.targetDbname ?? null}
        busy={compiling}
        onConfirm={compile}
        onClose={() => setConfirmCompile(false)}
      >
        <p>
          대상 <strong>{result?.targetDbname}</strong>에서 {compilePick.size}개를 ALTER … COMPILE 합니다: {[...compilePick].slice(0, 10).join(', ')}
          {compilePick.size > 10 ? ' …' : ''}
        </p>
      </ConfirmModal>
    </>
  );
}
