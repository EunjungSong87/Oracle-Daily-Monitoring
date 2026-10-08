import { useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { planPartitionImport, readPartitionManifest, startDataPump } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DataFilter, DataPumpMeta, ObjectFilter, PartitionImportPlan, PartitionImportJobView, PartitionManifest } from '../../shared/lib/types';
import { ConfirmModal } from './ConfirmModal';
import { formatBytes, todayPrefix } from './helpers';
import { PartitionJobList } from './PartitionJobList';
import { PartitionPicker } from './PartitionPicker';
import { ParfileModal, type ParfileView } from './ParfileModal';
import { DataFilterEditor } from './DataFilterEditor';
import { cleanDataFilter, cleanObjectFilter } from './filterHelpers';
import { FilterSummary } from './FilterSummary';
import { ObjectFilterEditor } from './ObjectFilterEditor';

interface Props {
  dbmsId: string;
  meta: DataPumpMeta;
  sqlAllowed: boolean; // DBA 이상 — QUERY/서브쿼리 SQL 조건
}

// 파티션 export의 매니페스트(.json)를 읽어 기간으로 파티션을 고르고, 파티션 하나당 import 작업 하나로 가져온다.
// 대상 테이블이 있으면 데이터만 APPEND하고, "비우고 넣기"면 같은 범위의 대상 파티션을 먼저 TRUNCATE한다
// (대상 파티션은 이름이 아니라 범위로 맞춤 — 인터벌 파티션은 DB마다 SYS_P… 이름이 다르기 때문).
export function PartitionImport({ dbmsId, meta, sqlAllowed }: Props): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState(meta.directories.find((dir) => dir.name === 'DATA_PUMP_DIR')?.name ?? meta.directories[0]?.name ?? '');
  const [manifestFile, setManifestFile] = useState('');
  const [manifestText, setManifestText] = useState<string | null>(null);
  const [manifest, setManifest] = useState<PartitionManifest | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [targetOwner, setTargetOwner] = useState('');
  const [logPrefix, setLogPrefix] = useState(todayPrefix('imp'));
  const [parallel, setParallel] = useState(1);
  const [content, setContent] = useState<'ALL' | 'DATA_ONLY'>('DATA_ONLY');
  const [excludeStatistics, setExcludeStatistics] = useState(true);
  const [truncateBeforeLoad, setTruncateBeforeLoad] = useState(false);
  const [objectFilter, setObjectFilter] = useState<ObjectFilter>({ rules: [] });
  const [dataFilter, setDataFilter] = useState<DataFilter>({});
  const [sqlEnabled, setSqlEnabled] = useState(false);

  const [plan, setPlan] = useState<PartitionImportPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [started, setStarted] = useState<Map<number, string>>(new Map());
  const [startingNo, setStartingNo] = useState<number | 'ALL' | null>(null);
  const [confirm, setConfirm] = useState<{ jobs: PartitionImportJobView[] } | null>(null);
  const [parfileView, setParfileView] = useState<ParfileView | null>(null);

  function applyManifest(text: string, parsed: PartitionManifest): void {
    setManifestText(text);
    setManifest(parsed);
    setSelected(new Set());
    setPlan(null);
    setTargetOwner(parsed.owner);
    setLogPrefix(`${todayPrefix('imp')}_${parsed.table}`.slice(0, 60));
  }

  async function loadFromServer(): Promise<void> {
    try {
      const result = await readPartitionManifest(dbmsId, directory, manifestFile.trim());
      applyManifest(result.text, result.manifest);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '매니페스트를 읽지 못했습니다.', 'error');
    }
  }

  // PC에 받아 둔 매니페스트를 올리는 경우: 내용 검증은 계획을 만들 때 서버가 한다. 여기서는 표시용으로만 읽는다.
  function loadFromPc(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as PartitionManifest;
        if (parsed?.kind !== 'DBC_PARTITION_EXPORT' || !Array.isArray(parsed.partitions)) throw new Error('DB Cockpit 파티션 매니페스트가 아닙니다.');
        applyManifest(text, parsed);
        setManifestFile(file.name);
      })
      .catch((error) => showToast(error instanceof Error ? error.message : '파일을 읽지 못했습니다.', 'error'));
  }

  async function makePlan(): Promise<void> {
    if (!manifestText || selected.size === 0) {
      showToast('파티션을 하나 이상 골라주세요.', 'error');
      return;
    }
    setPlanning(true);
    try {
      const result = await planPartitionImport(dbmsId, manifestText, Array.from(selected), {
        directory,
        logPrefix,
        targetOwner: targetOwner.trim() || null,
        parallel,
        content,
        excludeStatistics,
        truncateBeforeLoad,
        objectFilter: cleanObjectFilter(objectFilter),
        dataFilter: { ...cleanDataFilter(dataFilter), viewsAsTables: [] },
      });
      setPlan(result);
      setStarted(new Map());
    } catch (error) {
      showToast(error instanceof Error ? error.message : '계획을 만들지 못했습니다.', 'error');
    } finally {
      setPlanning(false);
    }
  }

  const firstJob = plan?.jobs[0] ?? null;
  // 대상 테이블이 없으면 첫 작업이 테이블을 만든다 — 그 작업이 시작되기 전에는 다른 작업을 막는다.
  const blockedReason = (job: PartitionImportJobView): string | null =>
    plan?.createsTable && firstJob && job.no !== firstJob.no && !started.has(firstJob.no) ? '1번 작업(테이블 생성)을 먼저 실행하세요.' : null;

  async function run(jobs: PartitionImportJobView[], typedDbname: string): Promise<void> {
    setStartingNo(jobs.length === 1 ? jobs[0].no : 'ALL');
    let ok = 0;
    for (const job of jobs) {
      try {
        // 파티션 import는 항상 APPEND라 기존 데이터를 바꾸는 작업 — 대상 DB명 확인을 함께 보낸다.
        const { jobName } = await startDataPump(dbmsId, job.request, typedDbname, job.bytes);
        setStarted((current) => new Map(current).set(job.no, jobName));
        ok++;
      } catch (error) {
        showToast(`작업 ${job.no}(${job.dumpfile}) 시작 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }
    if (ok > 0) showToast(`${ok}개 import 작업을 시작했습니다. "작업 현황" 탭에서 진행 상황을 볼 수 있습니다.`);
    setStartingNo(null);
    setConfirm(null);
  }

  const runnable = plan ? plan.jobs.filter((job) => !started.has(job.no) && blockedReason(job) === null) : [];
  const confirmTruncates = confirm?.jobs.flatMap((job) => job.truncatePartitions) ?? [];

  return (
    <>
      <div className="rt-panel">
        <h3>1. 매니페스트</h3>
        <div className="dp-grid">
          <div>
            <label htmlFor="dp-pi-dir">DIRECTORY (덤프와 매니페스트를 옮겨 둔 곳)</label>
            <select id="dp-pi-dir" value={directory} onChange={(e) => setDirectory(e.target.value)}>
              {meta.directories.map((dir) => (
                <option key={dir.name} value={dir.name}>
                  {dir.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="dp-pi-file">매니페스트 파일</label>
            <input id="dp-pi-file" type="text" placeholder="예: exp_20261006_ORDERS_manifest.json" value={manifestFile} onChange={(e) => setManifestFile(e.target.value)} />
          </div>
        </div>
        <div className="oc-actions dp-buttons">
          <button type="button" disabled={!manifestFile.trim().toLowerCase().endsWith('.json')} onClick={loadFromServer}>
            DB 서버에서 읽기
          </button>
          <button type="button" className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
            내 PC에서 올리기
          </button>
          <input ref={fileInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={loadFromPc} />
        </div>
        {manifest && (
          <p className="oc-hint">
            원본 {manifest.sourceDb} · {manifest.owner}.{manifest.table} · 파티션 키 {manifest.keyColumn} ({manifest.keyType}) · export한 파티션{' '}
            {manifest.partitions.length}개 · {manifest.createdAt.slice(0, 10)}
          </p>
        )}
      </div>

      {manifest && (
        <div className="rt-panel">
          <h3>2. 가져올 파티션</h3>
          <PartitionPicker partitions={manifest.partitions} selected={selected} onChange={setSelected} />
        </div>
      )}

      {manifest && (
        <div className="rt-panel">
          <h3>3. 옵션</h3>
          <div className="dp-grid">
            <div>
              <label htmlFor="dp-pi-owner">대상 스키마</label>
              <input id="dp-pi-owner" type="text" value={targetOwner} onChange={(e) => setTargetOwner(e.target.value.toUpperCase())} />
              {targetOwner && targetOwner !== manifest.owner && <div className="dp-hint-line">REMAP_SCHEMA {manifest.owner} → {targetOwner}</div>}
            </div>
            <div>
              <label htmlFor="dp-pi-prefix">로그 파일 접두어</label>
              <input id="dp-pi-prefix" type="text" value={logPrefix} onChange={(e) => setLogPrefix(e.target.value)} />
            </div>
            <div>
              <label htmlFor="dp-pi-content">CONTENT</label>
              <select id="dp-pi-content" value={content} onChange={(e) => setContent(e.target.value as 'ALL' | 'DATA_ONLY')}>
                <option value="DATA_ONLY">DATA_ONLY (이미 있는 테이블에 데이터만)</option>
                <option value="ALL">ALL (테이블이 없으면 만들기까지)</option>
              </select>
            </div>
            <div>
              <label htmlFor="dp-pi-parallel">PARALLEL (작업마다)</label>
              <input
                id="dp-pi-parallel"
                type="number"
                min={1}
                max={32}
                value={parallel}
                disabled={!meta.edition.parallelSupported}
                onChange={(e) => setParallel(Math.max(1, Math.min(32, Number(e.target.value) || 1)))}
              />
            </div>
          </div>
          <div className="oc-types">
            <label className="oc-check">
              <input type="checkbox" checked={excludeStatistics} onChange={(e) => setExcludeStatistics(e.target.checked)} />
              통계 제외
            </label>
            <label className="oc-check">
              <input type="checkbox" checked={truncateBeforeLoad} onChange={(e) => setTruncateBeforeLoad(e.target.checked)} />
              비우고 넣기 (같은 범위의 대상 파티션을 먼저 TRUNCATE — 범위가 다르면 거부)
            </label>
          </div>
          {truncateBeforeLoad && (
            <p className="pc-warning">대상 파티션의 기존 데이터를 지웁니다. 실행할 때 대상 DB명({meta.target.dbname})을 직접 입력해야 합니다.</p>
          )}
          <ObjectFilterEditor
            value={objectFilter}
            onChange={setObjectFilter}
            jobMode="TABLE"
            objectPaths={meta.objectPaths}
            versionNumber={meta.versionNumber}
            sqlEnabled={sqlAllowed && sqlEnabled}
          />
          <DataFilterEditor
            value={dataFilter}
            onChange={setDataFilter}
            operation="IMPORT"
            networkLink={null}
            versionNumber={meta.versionNumber}
            sqlAllowed={sqlAllowed}
            sqlEnabled={sqlAllowed && sqlEnabled}
            onSqlEnabledChange={setSqlEnabled}
            tableExistsAction="APPEND"
            allowViews={false}
            dbmsId={dbmsId}
            partitionImport
          />
          <div className="oc-actions dp-buttons">
            <button type="button" disabled={planning || selected.size === 0} onClick={makePlan}>
              {planning ? '만드는 중...' : `작업 만들기 (${selected.size}개 파티션)`}
            </button>
          </div>
        </div>
      )}

      {plan && (
        <div className="rt-panel">
          <div className="rt-panel-header">
            <h3>
              4. 작업 {plan.jobs.length}개{' '}
              <span className="oc-subtle">
                {plan.targetOwner}.{manifest?.table} · 전체 약 {formatBytes(plan.totalBytes)}
              </span>
            </h3>
            <div className="rt-panel-controls">
              <button
                type="button"
                className="btn-danger"
                disabled={runnable.length === 0 || startingNo !== null}
                onClick={() => setConfirm({ jobs: runnable })}
              >
                {plan.createsTable && firstJob && !started.has(firstJob.no) ? '1번 작업 실행 (테이블 생성)' : `전체 실행 (${runnable.length}개)`}
              </button>
            </div>
          </div>
          {plan.createsTable && (
            <p className="pc-warning">
              대상에 {plan.targetOwner}.{manifest?.table} 테이블이 없어 1번 작업이 테이블을 만듭니다. 1번 작업이 끝난 뒤("작업 현황" 탭에서 확인) 나머지를 실행하세요.
            </p>
          )}
          {plan.notes.map((note) => (
            <p key={note} className="oc-hint">
              {note}
            </p>
          ))}
          <PartitionJobList
            jobs={plan.jobs}
            started={started}
            startingNo={startingNo}
            disabledReason={blockedReason}
            onRun={(job) => setConfirm({ jobs: [job] })}
            onParfile={(job) => setParfileView({ title: `작업 ${job.no} — parfile`, command: job.command, parfile: job.parfile, parfileName: job.parfileName, notes: job.notes })}
          />
        </div>
      )}

      <ConfirmModal
        open={!!confirm}
        title="파티션 Import 실행"
        confirmLabel={`${confirm?.jobs.length ?? 0}개 작업 시작`}
        danger
        requireText={meta.target.dbname}
        busy={startingNo !== null}
        onConfirm={(typed) => confirm && run(confirm.jobs, typed)}
        onClose={() => setConfirm(null)}
      >
        <p>
          <strong>{meta.target.dbname}</strong>의 {plan?.targetOwner}.{manifest?.table}에 덤프 {confirm?.jobs.length}개(파티션 {confirm?.jobs.reduce((sum, job) => sum + job.partitions.length, 0)}개)를 가져옵니다 (APPEND).
        </p>
        {confirmTruncates.length > 0 && (
          <p className="pc-warning">
            시작 전에 대상 파티션 {confirmTruncates.join(', ')}의 데이터를 지웁니다 (TRUNCATE PARTITION … UPDATE INDEXES).
          </p>
        )}
        <FilterSummary objectFilter={cleanObjectFilter(objectFilter)} dataFilter={cleanDataFilter(dataFilter)} />
      </ConfirmModal>
      <ParfileModal view={parfileView} onClose={() => setParfileView(null)} />
    </>
  );
}
