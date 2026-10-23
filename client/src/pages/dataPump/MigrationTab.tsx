import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  ApiError,
  checkMigrationFiles,
  deleteRemapSet,
  generateMigration,
  getDataPumpMeta,
  getMigrationBundle,
  getMigrationBundles,
  getMigrationPlan,
  getRemapSets,
  precheckMigration,
  saveRemapSet,
  startDataPump,
} from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type {
  DataFilter,
  DataPumpLogtime,
  DataPumpMeta,
  DbmsRow,
  DumpFileCheckRow,
  MappingRow,
  MigrationBundleDetail,
  MigrationBundleRow,
  MigrationJobView,
  MigrationPlanView,
  MigrationPrecheckRow,
  ObjectFilter,
  RemapSet,
  TableExistsAction,
} from '../../shared/lib/types';
import { ConfirmModal } from './ConfirmModal';
import { DataFilterEditor } from './DataFilterEditor';
import { cleanDataFilter, cleanObjectFilter } from './filterHelpers';
import { downloadText, formatBytes } from './helpers';
import { ObjectFilterEditor } from './ObjectFilterEditor';
import { ParfileModal, type ParfileView } from './ParfileModal';
import { useServerSave } from './useServerSave';
import { LogOptions } from './LogOptions';

// 이관 Import: 이 DB(원본)의 Export 이력 묶음 → 대상 DB용 impdp 작업(덤프 세트마다 하나)을 만들고, 덤프 파일·사전 점검을 거쳐 실행한다.
// 기준 목록은 Export 로그에서 실제로 나간 테이블/파티션이다. 빠짐·중복·매핑 누락은 서버가 막고, 화면은 그 목록 전체를 보여 준다.

interface Props {
  dbmsId: string;
  dbname: string;
  dbmsRows: DbmsRow[];
  sqlAllowed: boolean;
  initialBundleKey: string | null;
}

interface Problem {
  message: string;
  items: string[];
}

const KEEP_TOKENS = /^(=|KEEP|그대로)$/i;

// 매핑표 CSV 붙여넣기 (서버의 parseMappingCsv와 같은 규칙): "원본,대상" — 대상이 비었거나 = 이면 "그대로 사용"
function parseCsv(text: string): MappingRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^from\s*[,\t]\s*to$/i.test(line))
    .map((line) => {
      const [from, to = ''] = line.split(/[,\t]/).map((cell) => cell.trim());
      const exact = /^".*"$/.test(from) ? from.slice(1, -1) : from.toUpperCase();
      const keep = to === '' || KEEP_TOKENS.test(to);
      return { from: exact, to: keep ? '' : to, keep };
    });
}

function ItemsBox({ problem, onClose }: { problem: Problem; onClose?: () => void }): ReactElement {
  return (
    <div className="pc-warning dp-items-box">
      <div className="dp-items-head">
        <strong>{problem.message}</strong>
        {onClose && (
          <button type="button" className="oc-link" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
      {problem.items.length > 0 && (
        <>
          <textarea readOnly rows={Math.min(12, problem.items.length + 1)} value={problem.items.join('\n')} aria-label="항목 목록" />
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              navigator.clipboard
                .writeText(problem.items.join('\n'))
                .then(() => showToast(`${problem.items.length}개 항목을 복사했습니다.`))
                .catch(() => showToast('복사하지 못했습니다.', 'error'))
            }
          >
            목록 복사 ({problem.items.length}개)
          </button>
        </>
      )}
    </div>
  );
}

function MappingTable({ label, rows, onChange, placeholder }: { label: string; rows: MappingRow[]; onChange: (rows: MappingRow[]) => void; placeholder: string }): ReactElement {
  const [csv, setCsv] = useState('');
  const empty = rows.filter((row) => !row.keep && !row.to.trim()).length;
  function applyCsv(): void {
    let parsed: MappingRow[];
    try {
      parsed = parseCsv(csv);
    } catch {
      showToast('CSV를 읽지 못했습니다.', 'error');
      return;
    }
    const known = new Set(rows.map((row) => row.from));
    const unknown = parsed.filter((row) => !known.has(row.from)).map((row) => row.from);
    onChange(rows.map((row) => parsed.find((item) => item.from === row.from) ?? row));
    showToast(`${parsed.length - unknown.length}개 적용${unknown.length > 0 ? ` · 이 묶음에 없는 ${unknown.length}개는 무시 (${unknown.slice(0, 3).join(', ')})` : ''}`);
  }
  return (
    <div className="dp-map">
      <h4>
        {label} {empty > 0 ? <span className="dash-bad">미입력 {empty}개</span> : <span className="oc-subtle">모두 입력됨</span>}
      </h4>
      <table className="table oc-items-table">
        <thead>
          <tr>
            <th>원본</th>
            <th>대상</th>
            <th>그대로 사용</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.from} className={!row.keep && !row.to.trim() ? 'dp-map-empty' : undefined}>
              <td className="oc-name">{row.from}</td>
              <td>
                <input
                  type="text"
                  aria-label={`${row.from} 대상`}
                  placeholder={placeholder}
                  value={row.keep ? '' : row.to}
                  disabled={row.keep}
                  onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, to: e.target.value } : item)))}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${row.from} 그대로 사용`}
                  checked={row.keep}
                  onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, keep: e.target.checked, to: e.target.checked ? '' : item.to } : item)))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary>CSV 붙여넣기</summary>
        <textarea rows={4} placeholder={'원본,대상 (대상이 비었거나 = 이면 그대로 사용)\nUSERS,DATA01\nIDX_TS,='} value={csv} onChange={(e) => setCsv(e.target.value)} />
        <button type="button" className="btn-secondary" onClick={applyCsv}>
          적용
        </button>
      </details>
    </div>
  );
}

const FILE_STATUS: Record<DumpFileCheckRow['status'], string> = { OK: '있음', MISSING: '없음', SIZE_DIFF: '크기 다름', NO_SIZE: '있음 (크기 기준 없음)' };

export function MigrationTab({ dbmsId, dbname, dbmsRows, sqlAllowed, initialBundleKey }: Props): ReactElement {
  const [bundles, setBundles] = useState<MigrationBundleRow[] | null>(null);
  const [bundleKey, setBundleKey] = useState(initialBundleKey ?? '');
  const [detail, setDetail] = useState<MigrationBundleDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const [targetDbmsId, setTargetDbmsId] = useState(dbmsId);
  const [targetMeta, setTargetMeta] = useState<DataPumpMeta | null>(null);
  const [directory, setDirectory] = useState('');
  const [schemaRows, setSchemaRows] = useState<MappingRow[]>([]);
  const [tsRows, setTsRows] = useState<MappingRow[]>([]);
  const [remapSets, setRemapSets] = useState<RemapSet[]>([]);
  const [setName, setSetName] = useState('');

  const [tableExistsAction, setTableExistsAction] = useState<TableExistsAction>('SKIP');
  const [parallel, setParallel] = useState(1);
  const [content, setContent] = useState<'ALL' | 'DATA_ONLY' | 'METADATA_ONLY'>('ALL');
  const [excludeStatistics, setExcludeStatistics] = useState(true);
  const [metrics, setMetrics] = useState(false);
  const [logtime, setLogtime] = useState<DataPumpLogtime>('NONE');
  const [truncatePartitions, setTruncatePartitions] = useState(false);
  const [objectFilter, setObjectFilter] = useState<ObjectFilter>({ rules: [] });
  const [dataFilter, setDataFilter] = useState<DataFilter>({});
  const [sqlEnabled, setSqlEnabled] = useState(false);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [ackOmitted, setAckOmitted] = useState(false);
  const [filterExcluded, setFilterExcluded] = useState<string[] | null>(null); // 서버가 계산해 알려 준 Import 필터 제외 목록
  const [ackFilter, setAckFilter] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [plan, setPlan] = useState<MigrationPlanView | null>(null);
  const [fileCheck, setFileCheck] = useState<{ rows: DumpFileCheckRow[]; blocked: boolean } | null>(null);
  const [precheck, setPrecheck] = useState<{ rows: MigrationPrecheckRow[]; blocked: boolean; sizeNote: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [started, setStarted] = useState<Set<string>>(new Set());
  const [confirmJobs, setConfirmJobs] = useState<MigrationJobView[] | null>(null);
  const [running, setRunning] = useState(false);
  const [parfileView, setParfileView] = useState<ParfileView | null>(null);
  const serverSave = useServerSave(targetDbmsId);

  useEffect(() => {
    getMigrationBundles(dbmsId)
      .then(setBundles)
      .catch((error) => setProblem({ message: error instanceof Error ? error.message : 'Export 이력을 읽지 못했습니다.', items: [] }));
    getRemapSets()
      .then(setRemapSets)
      .catch(() => setRemapSets([]));
  }, [dbmsId]);

  function loadDetail(key: string): void {
    setDetail(null);
    setPlan(null);
    setPrecheck(null);
    setFileCheck(null);
    setProblem(null);
    if (!key) return;
    setLoadingDetail(true);
    getMigrationBundle(dbmsId, key)
      .then((result) => {
        setDetail(result);
        setSelected(new Set(result.sets.filter((set) => set.blockers.length === 0).map((set) => set.historyId)));
        setAckOmitted(false);
        setFilterExcluded(null);
        setAckFilter(false);
        // 매핑표는 이 묶음의 소유자/테이블스페이스로 새로 만든다 (이미 입력한 같은 이름은 유지)
        setSchemaRows((current) => result.placements.owners.map((from) => current.find((row) => row.from === from) ?? { from, to: '', keep: false }));
        setTsRows((current) => result.placements.tablespaces.map((from) => current.find((row) => row.from === from) ?? { from, to: '', keep: false }));
      })
      .catch((error) => setProblem({ message: error instanceof Error ? error.message : '묶음을 읽지 못했습니다.', items: error instanceof ApiError ? error.items : [] }))
      .finally(() => setLoadingDetail(false));
  }

  useEffect(() => {
    if (bundleKey) loadDetail(bundleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleKey]);

  useEffect(() => {
    setTargetMeta(null);
    getDataPumpMeta(targetDbmsId)
      .then((meta) => {
        setTargetMeta(meta);
        setDirectory(meta.directories.find((dir) => dir.name === 'DATA_PUMP_DIR')?.name ?? meta.directories[0]?.name ?? '');
      })
      .catch((error) => showToast(error instanceof Error ? `대상 DB 정보: ${error.message}` : '대상 DB 정보를 읽지 못했습니다.', 'error'));
  }, [targetDbmsId]);

  // 일부만 고르면 빠지는 항목 (서버의 omittedItems와 같은 형식 — 서버가 다시 계산해 대조한다)
  const omitted = useMemo(() => {
    if (!detail) return [];
    return [
      ...detail.sets.filter((set) => !selected.has(set.historyId)).flatMap((set) => set.items.map((item) => `${item.key} (${set.jobName})`)),
      ...detail.notRun.flatMap((job) => job.expected.map((key) => `${key} (${job.jobName} — Export 실행 기록 없음)`)),
    ].sort();
  }, [detail, selected]);

  const unmappedCount = [...schemaRows, ...tsRows].filter((row) => !row.keep && !row.to.trim()).length;
  const targetDbname = dbmsRows.find((row) => String(row.ID) === targetDbmsId)?.DBNAME ?? '';

  async function generate(): Promise<void> {
    if (!detail) return;
    setGenerating(true);
    setProblem(null);
    try {
      const result = await generateMigration(dbmsId, detail.bundleKey, {
        targetDbmsId,
        directory,
        mapping: { schemas: schemaRows, tablespaces: tsRows },
        selected: [...selected],
        options: {
          parallel,
          content,
          excludeStatistics,
          metrics: metrics && (targetMeta?.versionNumber ?? 0) >= 12.1,
          logtime: (targetMeta?.versionNumber ?? 0) >= 12.1 && logtime !== 'NONE' ? logtime : null,
          tableExistsAction, truncatePartitions, objectFilter: cleanObjectFilter(objectFilter), dataFilter: cleanDataFilter(dataFilter) },
        ack: { omitted: ackOmitted ? omitted : [], filterExcluded: ackFilter && filterExcluded ? filterExcluded : [] },
      });
      setPlan(result);
      setFileCheck(result.fileCheck ?? null);
      setPrecheck(null);
      setStarted(new Set());
      showToast(`Import 작업 ${result.jobs.length}개를 만들었습니다. 덤프 파일과 사전 점검을 확인한 뒤 실행하세요.`);
    } catch (error) {
      const items = error instanceof ApiError ? error.items : [];
      const message = error instanceof Error ? error.message : 'Import를 만들지 못했습니다.';
      if (/Import 필터로/.test(message)) {
        setFilterExcluded(items);
        setAckFilter(false);
      }
      setProblem({ message, items });
    } finally {
      setGenerating(false);
    }
  }

  async function recheckFiles(): Promise<void> {
    if (!plan) return;
    try {
      setFileCheck(await checkMigrationFiles(plan.planId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '파일을 확인하지 못했습니다.', 'error');
    }
  }

  async function runPrecheck(): Promise<void> {
    if (!plan) return;
    setChecking(true);
    try {
      setPrecheck(await precheckMigration(plan.planId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '사전 점검을 하지 못했습니다.', 'error');
    } finally {
      setChecking(false);
    }
  }

  async function reopenPlan(planId: string): Promise<void> {
    try {
      const result = await getMigrationPlan(planId);
      setPlan(result);
      setTargetDbmsId(result.targetDbmsId);
      setFileCheck(await checkMigrationFiles(planId));
      setPrecheck(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Import 계획을 읽지 못했습니다.', 'error');
    }
  }

  async function run(jobs: MigrationJobView[], typedDbname: string): Promise<void> {
    setRunning(true);
    let ok = 0;
    for (const job of jobs) {
      try {
        await startDataPump(plan?.targetDbmsId ?? targetDbmsId, job.request, typedDbname);
        setStarted((current) => new Set(current).add(job.jobName));
        ok++;
      } catch (error) {
        setProblem({ message: `${job.jobName} 시작 실패: ${error instanceof Error ? error.message : String(error)}`, items: error instanceof ApiError ? error.items : [] });
        break;
      }
    }
    if (ok > 0) showToast(`${ok}개 Import를 시작했습니다. 대상 DB의 "작업 현황"에서 진행과 대조 결과를 볼 수 있습니다.`);
    setRunning(false);
    setConfirmJobs(null);
  }

  async function saveSet(): Promise<void> {
    if (!setName.trim()) {
      showToast('매핑표 이름을 입력하세요.', 'error');
      return;
    }
    try {
      await saveRemapSet(setName.trim(), { schemas: schemaRows, tablespaces: tsRows });
      setRemapSets(await getRemapSets());
      showToast(`매핑표 "${setName.trim()}"을(를) 저장했습니다.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '매핑표를 저장하지 못했습니다.', 'error');
    }
  }

  function loadSet(id: number): void {
    const found = remapSets.find((item) => item.id === id);
    if (!found) return;
    const pick = (rows: MappingRow[], saved: MappingRow[]) => rows.map((row) => saved.find((item) => item.from === row.from) ?? row);
    setSchemaRows((rows) => pick(rows, found.schemas));
    setTsRows((rows) => pick(rows, found.tablespaces));
    setSetName(found.name);
    showToast(`매핑표 "${found.name}"을(를) 불러왔습니다 (이 묶음에 있는 항목만).`);
  }

  async function removeSet(): Promise<void> {
    const found = remapSets.find((item) => item.name === setName.trim());
    if (!found) return;
    try {
      await deleteRemapSet(found.id);
      setRemapSets(await getRemapSets());
      showToast(`매핑표 "${found.name}"을(를) 지웠습니다.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '지우지 못했습니다.', 'error');
    }
  }

  const blockedRun = !plan || !fileCheck || fileCheck.blocked || !precheck || precheck.blocked;
  const runnable = plan ? plan.jobs.filter((job) => !started.has(job.jobName) && job.waitFor.every((name) => started.has(name))) : [];
  const confirmDestructive = confirmJobs?.some((job) => job.destructive) ?? false;

  return (
    <>
      <div className="rt-panel">
        <h3>1. 원본 Export (이 DB: {dbname})</h3>
        <p className="oc-hint">
          Export 이력의 묶음(분할 계획 하나)을 고르면, Export 로그에서 실제로 나간 테이블/파티션을 기준으로 대상 DB용 Import 작업을 덤프 세트마다 하나씩 만듭니다.
          계획에 있는데 로그에 없는 항목이 있거나 Export가 끝나지 않았으면 만들 수 없습니다.
        </p>
        <select aria-label="Export 묶음" value={bundleKey} onChange={(e) => setBundleKey(e.target.value)}>
          <option value="">Export 묶음 선택…</option>
          {(bundles ?? []).map((row) => (
            <option key={row.bundleKey} value={row.bundleKey}>
              {row.startedAt} · 작업 {row.jobs}개 · {row.statuses} · {row.source === 'EXTERNAL' ? '외부 · ' : ''}
              {row.jobNames.split(',')[0]}
              {row.jobs > 1 ? ' …' : ''} · {row.targetDesc ?? ''}
            </option>
          ))}
        </select>
        {loadingDetail && <p className="oc-detail-note">읽는 중... (원본 DB의 테이블스페이스 위치 포함)</p>}
      </div>

      {problem && <ItemsBox problem={problem} onClose={() => setProblem(null)} />}

      {detail && (
        <div className="rt-panel">
          <h3>2. 덤프 세트 ({detail.sets.length}개) — Export 로그 기준</h3>
          {detail.exportGaps.length > 0 && <ItemsBox problem={{ message: `Export 단계에서 빠짐 ${detail.exportGaps.length}개 — Import를 만들 수 없습니다`, items: detail.exportGaps }} />}
          {detail.duplicates.length > 0 && <ItemsBox problem={{ message: `두 덤프에 중복 ${detail.duplicates.length}개 — Import를 만들 수 없습니다`, items: detail.duplicates }} />}
          {detail.notRun.length > 0 && (
            <p className="pc-warning">
              분할 계획의 작업 {detail.notRun.length}개({detail.notRun.map((job) => job.jobName).join(', ')})는 Export 실행 기록이 없습니다. 그 대상은 빠지는 목록에 들어갑니다.
            </p>
          )}
          <table className="table oc-items-table">
            <thead>
              <tr>
                <th></th>
                <th>Export 작업</th>
                <th>대상 (로그 기준)</th>
                <th>덤프 파일</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {detail.sets.map((set) => (
                <tr key={set.historyId}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${set.jobName} 포함`}
                      disabled={set.blockers.length > 0}
                      checked={selected.has(set.historyId)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(set.historyId);
                        else next.delete(set.historyId);
                        setSelected(next);
                        setAckOmitted(false);
                      }}
                    />
                  </td>
                  <td>
                    {set.jobName}
                    <div className="dp-hint-line">
                      {set.mode} · {set.owners.join(', ')} · {set.startedAt}
                    </div>
                  </td>
                  <td title={set.items.map((item) => `${item.key} ${item.rows}행`).join('\n')}>
                    {set.items.length}개: {set.items.slice(0, 3).map((item) => `${item.key}(${item.rows}행)`).join(', ')}
                    {set.items.length > 3 ? ' …' : ''}
                    {set.warnings.map((warning) => (
                      <div key={warning} className="dp-hint-line">
                        ⚠ {warning}
                      </div>
                    ))}
                  </td>
                  <td>
                    {set.dumpFiles ? `${set.dumpFiles.length}개 · ${formatBytes(set.dumpFiles.reduce((sum, file) => sum + (file.bytes ?? 0), 0))}` : <span className="dash-bad">정보 없음</span>}
                    <div className="dp-hint-line">{set.dumpfile}</div>
                  </td>
                  <td>
                    {set.status}
                    {set.blockers.map((blocker) => (
                      <div key={blocker} className="dp-hint-line dash-bad">
                        {blocker}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {omitted.length > 0 && (
            <div className="pc-warning">
              <strong>고르지 않은 작업 때문에 {omitted.length}개가 빠집니다.</strong>
              <textarea readOnly rows={Math.min(8, omitted.length + 1)} value={omitted.join('\n')} aria-label="빠지는 항목" />
              <label>
                <input type="checkbox" checked={ackOmitted} onChange={(e) => setAckOmitted(e.target.checked)} /> 이 {omitted.length}개를 빼고 진행합니다 (이력에 기록됨)
              </label>
            </div>
          )}
          {detail.imports.length > 0 && (
            <div className="dp-imports">
              <h4>이 Export로 만든 Import</h4>
              {detail.imports.map((item) => (
                <div key={item.planId} className="dp-hint-line">
                  <span className={item.status === '완료' ? 'dash-ok' : item.status === '불일치' ? 'dash-bad' : undefined}>{item.status}</span> · {item.reason} · {item.createdAt}{' '}
                  {item.createdBy ?? ''} · 대상 {dbmsRows.find((row) => Number(row.ID) === item.targetDbmsId)?.DBNAME ?? item.targetDbmsId}{' '}
                  <button type="button" className="oc-link" onClick={() => reopenPlan(item.planId)}>
                    다시 열기
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {detail && !detail.blocked && (
        <div className="rt-panel">
          <h3>3. 대상과 매핑</h3>
          <div className="dp-grid">
            <div>
              <label htmlFor="mig-target">대상 DB</label>
              <select id="mig-target" value={targetDbmsId} onChange={(e) => setTargetDbmsId(e.target.value)}>
                {dbmsRows.map((row) => (
                  <option key={String(row.ID)} value={String(row.ID)}>
                    {String(row.ID)} - {row.DBNAME}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="mig-dir">대상 DIRECTORY (덤프를 옮겨 둔 곳)</label>
              <select id="mig-dir" value={directory} onChange={(e) => setDirectory(e.target.value)}>
                {(targetMeta?.directories ?? []).map((dir) => (
                  <option key={dir.name} value={dir.name}>
                    {dir.name} ({dir.path})
                  </option>
                ))}
              </select>
            </div>
          </div>
          {detail.placements.error && <p className="pc-warning">원본 테이블스페이스 위치를 읽지 못했습니다: {detail.placements.error}</p>}
          <div className="dp-row">
            <label htmlFor="mig-set">매핑표</label>
            <select id="mig-set" value="" onChange={(e) => e.target.value && loadSet(Number(e.target.value))}>
              <option value="">불러오기…</option>
              {remapSets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.updatedBy ?? '?'} {item.updatedAt ?? ''})
                </option>
              ))}
            </select>
            <input type="text" aria-label="매핑표 이름" placeholder="저장할 이름" value={setName} onChange={(e) => setSetName(e.target.value)} />
            <button type="button" className="btn-secondary" onClick={saveSet}>
              저장
            </button>
            {remapSets.some((item) => item.name === setName.trim()) && (
              <button type="button" className="btn-secondary" onClick={removeSet}>
                삭제
              </button>
            )}
          </div>
          <div className="dp-map-grid">
            <MappingTable label="REMAP_SCHEMA (Export 대상 소유자)" rows={schemaRows} onChange={setSchemaRows} placeholder="대상 스키마" />
            <MappingTable label="REMAP_TABLESPACE (테이블·파티션·인덱스·LOB이 쓰는 원본 테이블스페이스)" rows={tsRows} onChange={setTsRows} placeholder="대상 테이블스페이스" />
          </div>
        </div>
      )}

      {detail && !detail.blocked && (
        <div className="rt-panel">
          <h3>4. 옵션</h3>
          <div className="dp-grid">
            <div>
              <label htmlFor="mig-tea">TABLE_EXISTS_ACTION</label>
              <select id="mig-tea" value={tableExistsAction} onChange={(e) => setTableExistsAction(e.target.value as TableExistsAction)}>
                <option value="SKIP">SKIP (이미 있으면 건너뜀 — 대조에서 "불일치"로 나옴)</option>
                <option value="APPEND">APPEND (기존 데이터에 추가)</option>
                <option value="TRUNCATE">TRUNCATE (비우고 넣기)</option>
                <option value="REPLACE">REPLACE (지우고 다시 만들기)</option>
              </select>
            </div>
            <div>
              <label htmlFor="mig-parallel">PARALLEL</label>
              <input id="mig-parallel" type="number" min={1} max={32} value={parallel} onChange={(e) => setParallel(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <div>
              <label htmlFor="mig-content">CONTENT</label>
              <select id="mig-content" value={content} onChange={(e) => setContent(e.target.value as typeof content)}>
                <option value="ALL">ALL</option>
                <option value="DATA_ONLY">DATA_ONLY</option>
                <option value="METADATA_ONLY">METADATA_ONLY</option>
              </select>
            </div>
          </div>
          <label>
            <input type="checkbox" checked={excludeStatistics} onChange={(e) => setExcludeStatistics(e.target.checked)} /> 통계 제외 (EXCLUDE=STATISTICS)
          </label>
          {targetMeta && <LogOptions metrics={metrics} logtime={logtime} onMetrics={setMetrics} onLogtime={setLogtime} versionNumber={targetMeta.versionNumber} />}
          {detail.partitionTables.length > 0 && (
            <label>
              <input type="checkbox" checked={truncatePartitions} onChange={(e) => setTruncatePartitions(e.target.checked)} /> 파티션 덤프는 같은 범위의 대상 파티션을 비우고 넣기 (범위로 짝지음 — 이름이 달라도 됨)
            </label>
          )}
          {targetMeta && (
            <details>
              <summary>대상을 줄이는 조건 (INCLUDE/EXCLUDE, QUERY, SAMPLE) — 빠지는 테이블은 확인을 받습니다</summary>
              <ObjectFilterEditor value={objectFilter} onChange={setObjectFilter} jobMode="TABLE" objectPaths={targetMeta.objectPaths} versionNumber={targetMeta.versionNumber} sqlEnabled={sqlAllowed && sqlEnabled} />
              <DataFilterEditor
                value={dataFilter}
                onChange={setDataFilter}
                operation="IMPORT"
                dbmsId={targetDbmsId}
                allowViews={false}
                networkLink={null}
                versionNumber={targetMeta.versionNumber}
                sqlAllowed={sqlAllowed}
                sqlEnabled={sqlAllowed && sqlEnabled}
                onSqlEnabledChange={setSqlEnabled}
              />
            </details>
          )}
          {filterExcluded && filterExcluded.length > 0 && (
            <label className="pc-warning">
              <input type="checkbox" checked={ackFilter} onChange={(e) => setAckFilter(e.target.checked)} /> Import 필터로 빠지는 {filterExcluded.length}개(위 목록)를 빼고 진행합니다
            </label>
          )}
          <div className="oc-actions dp-buttons">
            <button type="button" disabled={generating || selected.size === 0 || unmappedCount > 0 || (omitted.length > 0 && !ackOmitted) || !directory} onClick={generate}>
              {generating ? '만드는 중...' : `Import 만들기 (${selected.size}개 덤프 세트 → ${targetDbname})`}
            </button>
            {unmappedCount > 0 && <span className="dash-bad">매핑 미입력 {unmappedCount}개</span>}
          </div>
        </div>
      )}

      {plan && (
        <div className="rt-panel">
          <h3>
            5. 만든 Import ({plan.jobs.length}개 → {plan.targetDbname})
          </h3>
          {(plan.warnings ?? []).length > 0 && <ItemsBox problem={{ message: '확인할 점', items: plan.warnings ?? [] }} />}
          {plan.impact && plan.impact.rowFilters.length + plan.impact.unknown.length > 0 && (
            <ItemsBox
              problem={{
                message: 'Import 조건 경고 — 행 수가 Export와 달라지거나 미리 계산할 수 없음',
                items: [...plan.impact.rowFilters, ...plan.impact.unknown.map((key) => `${key}: 조건(서브쿼리 등)으로 빠지는지 미리 알 수 없음`)],
              }}
            />
          )}
          <table className="table oc-items-table">
            <thead>
              <tr>
                <th>Import 작업</th>
                <th>원본 Export</th>
                <th>대상 수</th>
                <th>메모</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {plan.jobs.map((job) => (
                <tr key={job.jobName}>
                  <td>
                    {job.jobName}
                    <div className="dp-hint-line">TABLE_EXISTS_ACTION={job.request.tableExistsAction}</div>
                  </td>
                  <td>{job.exportJobName}</td>
                  <td>{job.items}</td>
                  <td>
                    {job.notes.map((note) => (
                      <div key={note} className="dp-hint-line">
                        {note}
                      </div>
                    ))}
                  </td>
                  <td className="dp-actions">
                    <button type="button" className="btn-secondary" onClick={() => setParfileView({ title: job.jobName, command: job.command, parfile: job.parfile, parfileName: job.parfileName, notes: job.notes })}>
                      parfile
                    </button>
                    {started.has(job.jobName) ? (
                      <span className="dash-ok">시작함</span>
                    ) : (
                      <button type="button" disabled={blockedRun || running || !runnable.includes(job)} title={job.waitFor.length > 0 ? `먼저: ${job.waitFor.join(', ')}` : undefined} onClick={() => setConfirmJobs([job])}>
                        실행
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="oc-actions dp-buttons">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => plan.jobs.forEach((job, index) => window.setTimeout(() => downloadText(job.parfileName, job.parfile), index * 300))}
            >
              parfile 전체 다운로드 ({plan.jobs.length}개)
            </button>
            <button type="button" className="btn-secondary" disabled={serverSave.saving} onClick={() => serverSave.save(directory || String(plan.jobs[0]?.request.directory ?? ''), plan.jobs.map((job) => ({ name: job.parfileName, content: job.parfile })))}>
              대상 DB DIRECTORY에 parfile 저장
            </button>
            <button type="button" className="btn-danger" disabled={blockedRun || running || runnable.length === 0} onClick={() => setConfirmJobs(runnable)}>
              실행 가능한 것 모두 실행 ({runnable.length}개)
            </button>
          </div>

          <h4>
            덤프 파일 (대상 DIRECTORY){' '}
            <button type="button" className="oc-link" onClick={recheckFiles}>
              다시 확인
            </button>
          </h4>
          {fileCheck && (
            <>
              {fileCheck.blocked && <p className="pc-warning">없거나 크기가 다른 파일이 있어 실행할 수 없습니다. 덤프를 대상 서버 DIRECTORY로 옮긴 뒤 "다시 확인"을 누르세요.</p>}
              <table className="table oc-items-table">
                <thead>
                  <tr>
                    <th>Export 작업</th>
                    <th>파일</th>
                    <th>이력 크기</th>
                    <th>대상 크기</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {fileCheck.rows.map((row) => (
                    <tr key={`${row.jobName}:${row.name}`}>
                      <td>{row.jobName}</td>
                      <td className="oc-name">{row.name}</td>
                      <td>{row.expected === null ? '-' : row.expected.toLocaleString()}</td>
                      <td>{row.actual === null ? '-' : row.actual.toLocaleString()}</td>
                      <td className={row.status === 'MISSING' || row.status === 'SIZE_DIFF' ? 'dash-bad' : 'dash-ok'}>{FILE_STATUS[row.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h4>
            Import 전 사전 점검 (대상 DB, 실행 전 필수){' '}
            <button type="button" className="btn-secondary" disabled={checking} onClick={runPrecheck}>
              {checking ? '점검 중...' : precheck ? '다시 점검' : '사전 점검'}
            </button>
          </h4>
          {precheck && (
            <>
              <p className="oc-hint">{precheck.sizeNote}</p>
              <table className="table oc-items-table">
                <thead>
                  <tr>
                    <th>판정</th>
                    <th>항목</th>
                    <th>대상</th>
                    <th>내용</th>
                  </tr>
                </thead>
                <tbody>
                  {precheck.rows.map((row) => (
                    <tr key={`${row.check}:${row.target}`}>
                      <td className={row.status === 'BLOCK' ? 'dash-bad' : row.status === 'WARN' ? 'dp-warn' : 'dash-ok'}>{row.status === 'BLOCK' ? '차단' : row.status === 'WARN' ? '경고' : '통과'}</td>
                      <td>{row.check}</td>
                      <td className="oc-name">{row.target}</td>
                      <td>
                        {row.detail}
                        {row.sql && <pre className="dp-sql">{row.sql}</pre>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {precheck.blocked && <p className="pc-warning">"차단" 항목이 있어 실행할 수 없습니다. 보여 준 SQL은 실행하지 않았습니다 — 대상 DB에서 직접 조치한 뒤 다시 점검하세요.</p>}
            </>
          )}
        </div>
      )}

      <ConfirmModal
        open={!!confirmJobs}
        title="이관 Import 실행"
        confirmLabel="실행"
        danger={confirmDestructive}
        busy={running}
        requireText={confirmDestructive ? (plan?.targetDbname ?? targetDbname) : null}
        onConfirm={(typed) => confirmJobs && run(confirmJobs, typed)}
        onClose={() => setConfirmJobs(null)}
      >
        <p>
          대상 <strong>{plan?.targetDbname}</strong>에서 {confirmJobs?.length}개 Import를 시작합니다: {confirmJobs?.map((job) => job.jobName).join(', ')}
        </p>
        {confirmDestructive && <p className="pc-warning">APPEND/TRUNCATE/REPLACE 또는 파티션 비우기가 들어 있어 기존 데이터가 바뀝니다.</p>}
      </ConfirmModal>
      <ParfileModal view={parfileView} onClose={() => setParfileView(null)} />
      {serverSave.confirmNode}
    </>
  );
}
