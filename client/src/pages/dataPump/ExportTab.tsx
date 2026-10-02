import { Fragment, useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { getDataPumpHistory, getDataPumpScn, planDataPumpExport, startDataPump } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DataPumpContent, DataPumpMeta, ExportGroup, ExportPlanResponse, ExportSplitOptions } from '../../shared/lib/types';
import { ConfirmModal } from './ConfirmModal';
import { downloadText, estimateSeconds, formatBytes, formatDuration, todayPrefix } from './helpers';
import { ParfileModal, type ParfileView } from './ParfileModal';
import { SchemaMultiSelect } from './SchemaMultiSelect';
import { useServerSave } from './useServerSave';

const CHUNK_PRESETS = [
  { value: '500G', label: '500 GB' },
  { value: '1T', label: '1 TB' },
  { value: '2T', label: '2 TB' },
  { value: 'NONE', label: '나누지 않음' },
  { value: 'CUSTOM', label: '직접 입력' },
];

interface Props {
  dbmsId: string;
  meta: DataPumpMeta;
}

// Export: 스키마를 고르거나 "OWNER.TABLE" 목록을 올리면, 테이블 크기를 보고 분할 크기(기본 1TB) 이하의 작업들로 나눈다.
// 작업마다 바로 실행하거나 parfile을 받을 수 있다.
export function ExportTab({ dbmsId, meta }: Props): ReactElement {
  const [sourceKind, setSourceKind] = useState<'SCHEMAS' | 'TABLES'>('SCHEMAS');
  const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set());
  const [tableList, setTableList] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [directory, setDirectory] = useState(meta.directories.find((dir) => dir.name === 'DATA_PUMP_DIR')?.name ?? meta.directories[0]?.name ?? '');
  const [filePrefix, setFilePrefix] = useState(todayPrefix('exp'));
  const [chunkPreset, setChunkPreset] = useState('1T');
  const [customChunk, setCustomChunk] = useState('');
  const [parallel, setParallel] = useState(meta.edition.parallelSupported ? 4 : 1);
  const [filesizeMode, setFilesizeMode] = useState<ExportSplitOptions['filesizeMode']>('AUTO');
  const [customFilesize, setCustomFilesize] = useState('');
  const [content, setContent] = useState<DataPumpContent>('ALL');
  const [excludeStatistics, setExcludeStatistics] = useState(true);
  const [flashbackConsistent, setFlashbackConsistent] = useState(true);
  const [reuseDumpfiles, setReuseDumpfiles] = useState(false);

  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<ExportPlanResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [started, setStarted] = useState<Map<number, string>>(new Map());
  const [startingNo, setStartingNo] = useState<number | 'ALL' | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [parfileView, setParfileView] = useState<ParfileView | null>(null);
  const serverSave = useServerSave(dbmsId);
  // 지난 export 이력의 평균 속도 — 작업별 예상 시간 어림용. 이력이 없거나 못 읽으면 예상 시간 칸만 비운다.
  const [throughput, setThroughput] = useState<{ bytesPerSec: number | null; samples: number }>({ bytesPerSec: null, samples: 0 });

  useEffect(() => {
    let cancelled = false;
    getDataPumpHistory(dbmsId)
      .then((history) => {
        if (!cancelled) setThroughput({ bytesPerSec: history.throughput.exportBytesPerSec, samples: history.throughput.samples });
      })
      .catch((error) => console.error('Error loading data pump history:', error));
    return () => {
      cancelled = true;
    };
  }, [dbmsId]);

  const directoryPath = meta.directories.find((dir) => dir.name === directory)?.path;

  function loadTableFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        setTableList(text);
        showToast(`${file.name}을(를) 불러왔습니다.`);
      })
      .catch(() => showToast('파일을 읽지 못했습니다.', 'error'));
    event.target.value = '';
  }

  async function makePlan(): Promise<void> {
    if (sourceKind === 'SCHEMAS' && selectedSchemas.size === 0) {
      showToast('스키마를 하나 이상 골라주세요.', 'error');
      return;
    }
    if (sourceKind === 'TABLES' && !tableList.trim()) {
      showToast('테이블 목록을 입력하거나 파일을 올려주세요.', 'error');
      return;
    }
    setPlanning(true);
    try {
      const options: ExportSplitOptions = {
        directory,
        filePrefix,
        chunkSize: chunkPreset === 'CUSTOM' ? customChunk : chunkPreset,
        parallel,
        filesizeMode,
        customFilesize: filesizeMode === 'CUSTOM' ? customFilesize : null,
        content,
        excludeStatistics,
        flashbackConsistent,
        reuseDumpfiles,
      };
      const source = sourceKind === 'SCHEMAS' ? { schemas: Array.from(selectedSchemas) } : { tableList };
      const result = await planDataPumpExport(dbmsId, source, options);
      setPlan(result);
      setStarted(new Map());
      setExpanded(new Set());
      if (result.missing.length > 0) showToast(`목록 중 ${result.missing.length}개 테이블은 DB에 없어 뺐습니다.`, 'error');
    } catch (error) {
      console.error('Error planning export:', error);
      showToast(error instanceof Error ? error.message : '분할 계획을 만들지 못했습니다.', 'error');
    } finally {
      setPlanning(false);
    }
  }

  async function startGroup(group: ExportGroup, flashbackScn: string | null): Promise<boolean> {
    try {
      const { jobName } = await startDataPump(dbmsId, { ...group.request, flashbackScn }, undefined, group.bytes);
      setStarted((current) => new Map(current).set(group.no, jobName));
      return true;
    } catch (error) {
      console.error('Error starting export:', error);
      showToast(`작업 ${group.no} 시작 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return false;
    }
  }

  async function runOne(group: ExportGroup): Promise<void> {
    setStartingNo(group.no);
    if (await startGroup(group, null)) showToast(`작업 ${group.no}을(를) 시작했습니다. "작업 현황" 탭에서 진행 상황을 볼 수 있습니다.`);
    setStartingNo(null);
  }

  // 전체 실행: 모든 작업에 같은 SCN을 걸어 작업끼리도 같은 시점의 데이터가 되게 한다.
  async function runAll(): Promise<void> {
    if (!plan) return;
    setStartingNo('ALL');
    try {
      const scn = flashbackConsistent ? await getDataPumpScn(dbmsId) : null;
      let ok = 0;
      for (const group of plan.groups) {
        if (started.has(group.no)) continue;
        if (await startGroup(group, scn)) ok++;
      }
      showToast(`${ok}개 작업을 시작했습니다${scn ? ` (SCN ${scn} 기준)` : ''}.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '전체 실행 실패', 'error');
    } finally {
      setStartingNo(null);
      setConfirmAll(false);
    }
  }

  // 계획을 만든 시점의 DIRECTORY (옵션을 나중에 바꿔도 계획과 어긋나지 않게)
  const planDirectory = plan?.groups[0]?.request.directory ?? directory;
  const planDirectoryPath = meta.directories.find((dir) => dir.name === planDirectory)?.path ?? null;
  const runScriptName = `${filePrefix}_run_all.sh`;

  // 작업 순서대로 하나씩 돌리는 셸 스크립트. parfile이 있는 디렉토리에서 실행해야 해서 cd부터 한다.
  function runScript(): string {
    if (!plan) return '';
    return [
      '#!/bin/sh',
      `# DB Cockpit Data Pump — ${meta.target.dbname}, 작업 ${plan.groups.length}개 (하나씩 차례대로 실행, 비밀번호는 작업마다 입력)`,
      '# 동시에 돌리려면 각 줄 끝에 & 를 붙이세요.',
      planDirectoryPath ? `cd "${planDirectoryPath}" || exit 1` : '# parfile이 있는 디렉토리로 이동한 뒤 실행하세요.',
      ...plan.groups.map((group) => group.command),
      '',
    ].join('\n');
  }

  function downloadAllParfiles(): void {
    if (!plan) return;
    // 브라우저가 여러 파일 다운로드를 막지 않도록 조금씩 간격을 둔다.
    plan.groups.forEach((group, index) => window.setTimeout(() => downloadText(group.parfileName, group.parfile), index * 300));
    window.setTimeout(() => downloadText(runScriptName, runScript()), plan.groups.length * 300);
  }

  // parfile 전부 + 실행 스크립트를 DB 서버의 DIRECTORY(덤프가 생길 곳)에 바로 만든다.
  function saveAllToServer(): void {
    if (!plan) return;
    serverSave.save(planDirectory, [
      ...plan.groups.map((group) => ({ name: group.parfileName, content: group.parfile })),
      { name: runScriptName, content: runScript() },
    ]);
  }

  const pending = plan ? plan.groups.filter((group) => !started.has(group.no)).length : 0;

  return (
    <>
      <div className="rt-panel">
        <h3>1. 대상</h3>
        <div className="status-tabs dp-inline">
          <button type="button" className={`status-tab${sourceKind === 'SCHEMAS' ? ' status-tab-active' : ''}`} onClick={() => setSourceKind('SCHEMAS')}>
            스키마 선택
          </button>
          <button type="button" className={`status-tab${sourceKind === 'TABLES' ? ' status-tab-active' : ''}`} onClick={() => setSourceKind('TABLES')}>
            테이블 목록 올리기
          </button>
        </div>

        {sourceKind === 'SCHEMAS' ? (
          <>
            <SchemaMultiSelect
              options={meta.schemas}
              selected={selectedSchemas}
              onChange={setSelectedSchemas}
              placeholder={`스키마 검색 (${meta.schemas.length}개) — 입력하면 목록이 걸러집니다`}
            />
            <p className="oc-hint">
              스키마 전체(테이블 + 뷰/프로시저/시퀀스/권한 등)를 내보냅니다. 고른 스키마들의 합이 분할 크기 이하면 작업 하나(SCHEMAS=A,B,…)로,
              넘으면 크기를 보고 여러 스키마를 묶어 분할 크기 이하 작업들로 나눕니다. 혼자서도 분할 크기를 넘는 스키마만 큰 테이블부터 따로 떼어 내고,
              그 스키마의 나머지는 떼어 낸 테이블만 제외한 작업에 담습니다.
            </p>
          </>
        ) : (
          <>
            <textarea
              className="dp-table-list"
              placeholder={'한 줄에 하나씩  소유자.테이블\nHR.EMPLOYEES\nHR.DEPARTMENTS\nSALES.ORDERS'}
              value={tableList}
              onChange={(e) => setTableList(e.target.value)}
            />
            <div className="dp-row">
              <input ref={fileInputRef} type="file" accept=".txt,.csv,.sql,text/plain" hidden onChange={loadTableFile} />
              <button type="button" className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
                파일에서 불러오기 (.txt / .csv)
              </button>
              <span className="oc-subtle">{tableList.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).length}줄</span>
            </div>
            <p className="oc-hint">
              "OWNER.TABLE", "OWNER TABLE", "OWNER,TABLE" 형식 모두 됩니다. 테이블 데이터만 내보내며(TABLE 모드), 소유자가 다르면 작업을 따로 만듭니다.
            </p>
          </>
        )}
      </div>

      <div className="rt-panel">
        <h3>2. 옵션</h3>
        <div className="dp-grid">
          <div>
            <label htmlFor="dp-exp-dir">DIRECTORY</label>
            <select id="dp-exp-dir" value={directory} onChange={(e) => setDirectory(e.target.value)}>
              {meta.directories.map((dir) => (
                <option key={dir.name} value={dir.name}>
                  {dir.name}
                </option>
              ))}
            </select>
            {directoryPath && <div className="dp-hint-line">DB 서버 경로: {directoryPath}</div>}
          </div>
          <div>
            <label htmlFor="dp-exp-prefix">파일 이름 접두어</label>
            <input id="dp-exp-prefix" type="text" value={filePrefix} onChange={(e) => setFilePrefix(e.target.value)} />
            <div className="dp-hint-line">
              덤프: {filePrefix}_01_%U.dmp · 로그: {filePrefix}_01.log
            </div>
          </div>
          <div>
            <label htmlFor="dp-exp-chunk">작업 하나의 최대 크기 (분할 기준)</label>
            <select id="dp-exp-chunk" value={chunkPreset} onChange={(e) => setChunkPreset(e.target.value)}>
              {CHUNK_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            {chunkPreset === 'CUSTOM' && (
              <input type="text" placeholder="예: 800G, 1.5T" value={customChunk} onChange={(e) => setCustomChunk(e.target.value)} />
            )}
          </div>
          <div>
            <label htmlFor="dp-exp-parallel">PARALLEL (작업마다)</label>
            <input
              id="dp-exp-parallel"
              type="number"
              min={1}
              max={32}
              value={parallel}
              disabled={!meta.edition.parallelSupported}
              onChange={(e) => setParallel(Math.max(1, Math.min(32, Number(e.target.value) || 1)))}
            />
            {!meta.edition.parallelSupported && (
              <div className="dp-hint-line">이 DB는 Enterprise Edition이 아니라 PARALLEL을 쓸 수 없습니다 (1로 고정).</div>
            )}
          </div>
          <div>
            <label htmlFor="dp-exp-filesize">덤프 파일 하나의 크기 (FILESIZE)</label>
            <select id="dp-exp-filesize" value={filesizeMode} onChange={(e) => setFilesizeMode(e.target.value as ExportSplitOptions['filesizeMode'])}>
              <option value="AUTO">자동 — 작업 크기 ÷ PARALLEL</option>
              <option value="CUSTOM">직접 입력</option>
              <option value="NONE">지정 안 함</option>
            </select>
            {filesizeMode === 'CUSTOM' && (
              <input type="text" placeholder="예: 100G" value={customFilesize} onChange={(e) => setCustomFilesize(e.target.value)} />
            )}
          </div>
          <div>
            <label htmlFor="dp-exp-content">CONTENT</label>
            <select id="dp-exp-content" value={content} onChange={(e) => setContent(e.target.value as DataPumpContent)}>
              <option value="ALL">ALL (구조 + 데이터)</option>
              <option value="METADATA_ONLY">METADATA_ONLY (구조만)</option>
              <option value="DATA_ONLY">DATA_ONLY (데이터만)</option>
            </select>
          </div>
        </div>
        <div className="oc-types">
          <label className="oc-check">
            <input type="checkbox" checked={excludeStatistics} onChange={(e) => setExcludeStatistics(e.target.checked)} />
            통계 제외 (EXCLUDE=STATISTICS)
          </label>
          <label className="oc-check">
            <input type="checkbox" checked={flashbackConsistent} onChange={(e) => setFlashbackConsistent(e.target.checked)} />
            일관성 있는 시점으로 (FLASHBACK — 전체 실행 시 모든 작업이 같은 SCN)
          </label>
          <label className="oc-check">
            <input type="checkbox" checked={reuseDumpfiles} onChange={(e) => setReuseDumpfiles(e.target.checked)} />
            같은 이름의 덤프 파일 덮어쓰기 (REUSE_DUMPFILES)
          </label>
        </div>
        <div className="oc-actions">
          <button type="button" disabled={planning || !directory} onClick={makePlan}>
            {planning ? '테이블 크기 확인 중...' : '분할 계획 만들기'}
          </button>
        </div>
      </div>

      {plan && (
        <div className="rt-panel">
          <div className="rt-panel-header">
            <h3>
              3. 작업 {plan.groups.length}개{' '}
              <span className="oc-subtle">
                전체 약 {formatBytes(plan.totalBytes)} · 분할 기준 {plan.chunkBytes ? formatBytes(plan.chunkBytes) : '없음'} · PARALLEL {parallel}
              </span>
              <span
                className="dp-hint-line dp-plan-eta"
                title="이 DB에서 최근에 끝난 export(30초 이상)들의 '예상 크기 ÷ 수행 시간' 평균으로 어림한 값입니다. PARALLEL, 동시에 도는 작업 수, DB 부하에 따라 크게 달라질 수 있습니다."
              >
                {throughput.bytesPerSec !== null
                  ? `예상 시간: 하나씩 돌리면 합계 약 ${formatDuration(estimateSeconds(plan.totalBytes, throughput.bytesPerSec))} (지난 export ${throughput.samples}개 평균 속도 ${formatBytes(throughput.bytesPerSec)}/초 기준)`
                  : '예상 시간: 이 DB에서 끝난 export 이력(30초 이상)이 쌓이면 지난 작업 평균 속도로 보여 줍니다.'}
              </span>
            </h3>
            <div className="rt-panel-controls">
              <button type="button" className="btn-secondary" onClick={downloadAllParfiles}>
                parfile 전체 다운로드
              </button>
              <button type="button" className="btn-secondary" disabled={serverSave.saving} onClick={saveAllToServer}>
                {serverSave.saving ? '저장 중...' : `DB 서버 ${planDirectory}에 parfile 저장`}
              </button>
              <button type="button" disabled={pending === 0 || startingNo !== null} onClick={() => setConfirmAll(true)}>
                전체 실행 ({pending}개)
              </button>
            </div>
          </div>
          {plan.missing.length > 0 && (
            <p className="pc-warning">DB에 없는 테이블이라 뺀 항목 {plan.missing.length}개: {plan.missing.slice(0, 20).join(', ')}{plan.missing.length > 20 ? ' …' : ''}</p>
          )}
          <table className="table oc-items-table dp-groups">
            <thead>
              <tr>
                <th>#</th>
                <th>모드</th>
                <th>소유자</th>
                <th>내용</th>
                <th>예상 크기</th>
                <th>덤프 파일</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {plan.groups.map((group) => {
                const open = expanded.has(group.no);
                const jobName = started.get(group.no);
                return (
                  <Fragment key={group.no}>
                    <tr>
                      <td>{group.no}</td>
                      <td>
                        <span className={`issue-badge ${group.mode === 'SCHEMA' ? 'oc-badge-ONLY_SOURCE' : 'oc-badge-SAME'}`}>{group.mode}</span>
                      </td>
                      <td className="oc-name">
                        {group.owners.length <= 3 ? group.owners.join(', ') : `${group.owners.slice(0, 3).join(', ')} 외 ${group.owners.length - 3}개`}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="oc-link"
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (next.has(group.no)) next.delete(group.no);
                              else next.add(group.no);
                              return next;
                            })
                          }
                        >
                          {open ? '▾' : '▸'} 테이블 {group.tables.length}개
                        </button>
                        {group.mode === 'SCHEMA' && <span className="oc-subtle">+ 테이블 외 오브젝트</span>}
                        {group.excludedTables.length > 0 && <span className="oc-subtle">(큰 테이블 {group.excludedTables.length}개 제외)</span>}
                      </td>
                      <td>
                        {formatBytes(group.bytes)}
                        {group.oversize && (
                          <span className="oc-info-tag" title="테이블 하나가 분할 기준보다 커서 더 나눌 수 없음">
                            기준 초과
                          </span>
                        )}
                        {throughput.bytesPerSec !== null && (
                          <div className="dp-hint-line">약 {formatDuration(estimateSeconds(group.bytes, throughput.bytesPerSec))}</div>
                        )}
                      </td>
                      <td>
                        <div className="oc-name">{group.request.dumpfile}</div>
                        <div className="dp-hint-line">
                          {group.filesize ? `FILESIZE ${group.filesize} × 약 ${group.expectedFiles}개` : `PARALLEL ${parallel}개 파일`}
                        </div>
                      </td>
                      <td className="dp-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() =>
                            setParfileView({ title: `작업 ${group.no} — parfile`, command: group.command, parfile: group.parfile, parfileName: group.parfileName })
                          }
                        >
                          parfile
                        </button>
                        {jobName ? (
                          <span className="issue-badge oc-badge-SAME" title={jobName}>
                            실행됨
                          </span>
                        ) : (
                          <button type="button" disabled={startingNo !== null} onClick={() => runOne(group)}>
                            {startingNo === group.no ? '시작 중...' : '실행'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="oc-detail-row">
                        <td colSpan={7}>
                          <div className="dp-table-chips">
                            {group.owners.length > 1 && <p className="dp-hint-line dp-full">스키마: {group.owners.join(', ')}</p>}
                            {group.tables.map((table) => (
                              <span key={`${table.owner}.${table.name}`} className="dp-chip">
                                {group.owners.length > 1 ? `${table.owner}.` : ''}
                                {table.name} <em>{formatBytes(table.bytes)}</em>
                              </span>
                            ))}
                            {group.tables.length === 0 && <span className="oc-none">테이블 없음 (테이블 외 오브젝트만)</span>}
                          </div>
                          {group.excludedTables.length > 0 && (
                            <p className="dp-hint-line">다른 작업으로 분리되어 이 작업에서 제외: {group.excludedTables.join(', ')}</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="oc-hint">
            예상 크기는 세그먼트(할당 공간) 기준이라 실제 덤프는 보통 이보다 작습니다. 각 작업의 덤프/로그는 DB 서버의 {directory}
            {directoryPath ? ` (${directoryPath})` : ''}에 생깁니다. parfile로 직접 돌릴 때는 작업마다 FLASHBACK_TIME=SYSTIMESTAMP라 작업끼리 시점이
            조금씩 다를 수 있습니다.
          </p>
        </div>
      )}

      <ConfirmModal
        open={confirmAll}
        title="전체 실행"
        confirmLabel={`${pending}개 작업 시작`}
        busy={startingNo === 'ALL'}
        onConfirm={runAll}
        onClose={() => setConfirmAll(false)}
      >
        <p>
          <strong>{meta.target.dbname}</strong>에서 export 작업 {pending}개를 지금 동시에 시작합니다 (각 PARALLEL {parallel}).
        </p>
        <p className="oc-hint">
          DB 서버의 CPU/IO와 {directory} 디스크 여유 공간(약 {formatBytes(plan?.totalBytes)} 필요)을 확인하세요.
          {flashbackConsistent && ' 모든 작업이 같은 SCN 시점의 데이터로 내보내집니다 (작업이 길면 UNDO 보존 기간이 충분해야 합니다).'}
        </p>
      </ConfirmModal>
      <ParfileModal
        view={parfileView}
        onClose={() => setParfileView(null)}
        serverDirectory={planDirectory}
        saving={serverSave.saving}
        onSaveToServer={(view) => serverSave.save(planDirectory, [{ name: view.parfileName, content: view.parfile }])}
      />
      {serverSave.confirmNode}
    </>
  );
}
