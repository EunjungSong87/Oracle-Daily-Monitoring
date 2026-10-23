import { useState, type ReactElement } from 'react';
import { previewDataPump, startDataPump } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DataFilter, DataPumpContent, DataPumpLogtime, DataPumpMeta, DataPumpRequest, ImportDraft, ObjectFilter, TableExistsAction } from '../../shared/lib/types';
import { ImportFromExportModal } from './ImportFromExportModal';
import { LogOptions } from './LogOptions';
import { ConfirmModal } from './ConfirmModal';
import { downloadText, todayPrefix } from './helpers';
import { ParfileModal, type ParfileView } from './ParfileModal';
import { DataFilterEditor } from './DataFilterEditor';
import { cleanDataFilter, cleanObjectFilter, hasIncludeRules } from './filterHelpers';
import { FilterSummary } from './FilterSummary';
import { ObjectFilterEditor } from './ObjectFilterEditor';
import { useServerSave } from './useServerSave';

interface RemapRow {
  from: string;
  to: string;
}

const TABLE_EXISTS_ACTIONS: { value: TableExistsAction; label: string }[] = [
  { value: 'SKIP', label: 'SKIP — 이미 있는 테이블은 건드리지 않음 (기본)' },
  { value: 'APPEND', label: 'APPEND — 기존 데이터 뒤에 추가' },
  { value: 'TRUNCATE', label: 'TRUNCATE — 기존 데이터를 지우고 넣음' },
  { value: 'REPLACE', label: 'REPLACE — 테이블을 지우고 다시 만듦' },
];

function splitNames(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

// 테이블 칸: OWNER.TABLE[:PARTITION] (SQL 표기, 따옴표 이름 가능) 또는 소유자 칸 + TABLE[:PARTITION].
// 소유자가 여럿이거나 파티션이 있어도 그대로 요청에 담는다 (기존 Export에서 가져온 항목이 하나도 빠지지 않게).
const TABLE_ENTRY = /^(?:("[^"]*"|[^".:]+)\.)?("[^"]*"|[^".:]+)(?::("[^"]*"|[^".:]+))?$/;

function tableRequest(entries: string[], defaultOwner: string): Pick<DataPumpRequest, 'qualifiedTables' | 'tablePartitions'> {
  const pairs: { owner: string; table: string }[] = [];
  const parts = new Map<string, { owner: string; table: string; partitions: string[] }>();
  const whole = new Set<string>();
  for (const entry of entries) {
    const match = entry.match(TABLE_ENTRY);
    const owner = match?.[1] ?? defaultOwner.trim();
    const table = match?.[2] ?? entry;
    const key = `${owner}.${table}`;
    if (!pairs.some((pair) => `${pair.owner}.${pair.table}` === key)) pairs.push({ owner, table });
    if (match?.[3]) parts.set(key, { owner, table, partitions: [...(parts.get(key)?.partitions ?? []), match[3]] });
    else whole.add(key);
  }
  // 같은 테이블을 통째로도 적었으면 통째로 (Export와 같은 규칙)
  return { qualifiedTables: pairs, tablePartitions: [...parts].filter(([key]) => !whole.has(key)).map(([, value]) => value) };
}

function sameItems(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function RemapEditor({ label, rows, onChange }: { label: string; rows: RemapRow[]; onChange: (rows: RemapRow[]) => void }): ReactElement {
  return (
    <div>
      <label>{label}</label>
      {rows.map((row, index) => (
        <div key={index} className="dp-row">
          <input
            type="text"
            placeholder="원본"
            value={row.from}
            onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, from: e.target.value } : item)))}
          />
          <span>→</span>
          <input
            type="text"
            placeholder="대상"
            value={row.to}
            onChange={(e) => onChange(rows.map((item, i) => (i === index ? { ...item, to: e.target.value } : item)))}
          />
          <button type="button" className="btn-secondary" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            삭제
          </button>
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => onChange([...rows, { from: '', to: '' }])}>
        + 추가
      </button>
    </div>
  );
}

interface Props {
  dbmsId: string;
  meta: DataPumpMeta;
  sqlAllowed: boolean; // DBA 이상 — QUERY/서브쿼리 SQL 조건
  onOpenMigration?: (bundleKey: string) => void; // "기존 Export에서 가져오기"에서 분할 묶음을 고르면 이관 Import 탭으로
}

// Import: 덤프 파일에서, 또는 DB 링크(NETWORK_LINK)로 덤프 없이 바로 가져오기. 기존 데이터를 건드리는 TABLE_EXISTS_ACTION은 대상 DB명을 입력해야 실행된다 (서버도 한 번 더 확인).
export function ImportTab({ dbmsId, meta, sqlAllowed, onOpenMigration }: Props): ReactElement {
  const [directory, setDirectory] = useState(meta.directories.find((dir) => dir.name === 'DATA_PUMP_DIR')?.name ?? meta.directories[0]?.name ?? '');
  // 가져올 곳: 빈 값 = 덤프 파일, 아니면 DB 링크 이름 (덤프 없이 링크 너머 DB에서 바로)
  const [networkLink, setNetworkLink] = useState('');
  const [flashbackConsistent, setFlashbackConsistent] = useState(true);
  const [dumpfile, setDumpfile] = useState('');
  const [logfile, setLogfile] = useState(`${todayPrefix('imp')}.log`);
  const [mode, setMode] = useState<DataPumpRequest['mode']>('FULL');
  const [schemasText, setSchemasText] = useState('');
  const [tableOwner, setTableOwner] = useState('');
  const [tablesText, setTablesText] = useState('');
  const [remapSchemas, setRemapSchemas] = useState<RemapRow[]>([]);
  const [remapTablespaces, setRemapTablespaces] = useState<RemapRow[]>([]);
  const [tableExistsAction, setTableExistsAction] = useState<TableExistsAction>('SKIP');
  const [content, setContent] = useState<DataPumpContent>('ALL');
  const [excludeStatistics, setExcludeStatistics] = useState(true);
  const [metrics, setMetrics] = useState(false);
  const [logtime, setLogtime] = useState<DataPumpLogtime>('NONE');
  const [parallel, setParallel] = useState(meta.edition.parallelSupported ? 4 : 1);
  const [objectFilter, setObjectFilter] = useState<ObjectFilter>({ rules: [] });
  const [dataFilter, setDataFilter] = useState<DataFilter>({});
  const [sqlEnabled, setSqlEnabled] = useState(false);
  // "기존 Export에서 가져오기"로 채운 항목 — 폼과 계속 대조해 "Export N개 → Import N개"를 보여 준다
  const [fromExportOpen, setFromExportOpen] = useState(false);
  const [imported, setImported] = useState<{ source: string; mode: DataPumpRequest['mode']; items: string[] } | null>(null);
  const statsLocked = hasIncludeRules(objectFilter) && meta.versionNumber < 21;

  const [parfileView, setParfileView] = useState<ParfileView | null>(null);
  const serverSave = useServerSave(dbmsId);
  // Export parfile 여러 개 → impdp parfile 여러 개 (파일마다 하나, 서버 미리보기로 만들고 검사)
  const [manyParfiles, setManyParfiles] = useState<{ name: string; items: number; filled: number; view: ParfileView; jobName: string }[] | null>(null);
  // 다시 만들 때 쓰는 원본(Export parfile들)과 만들 때의 폼 옵션 — 폼을 바꾸면 "옵션이 바뀜"을 보여 준다
  const [manyDrafts, setManyDrafts] = useState<{ name: string; draft: ImportDraft }[] | null>(null);
  const [manyOptions, setManyOptions] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const destructive = tableExistsAction !== 'SKIP';
  const directoryPath = meta.directories.find((dir) => dir.name === directory)?.path;

  function buildRequest(): DataPumpRequest {
    return {
      operation: 'IMPORT',
      mode,
      schemas: mode === 'SCHEMA' ? splitNames(schemasText) : undefined,
      ...(mode === 'TABLE' ? tableRequest(splitNames(tablesText), tableOwner) : {}),
      directory,
      dumpfile: networkLink ? '' : dumpfile,
      logfile,
      parallel,
      content,
      excludeStatistics,
      metrics: metrics && meta.versionNumber >= 12.1,
      logtime: meta.versionNumber >= 12.1 && logtime !== 'NONE' ? logtime : null,
      tableExistsAction,
      remapSchemas: remapSchemas.filter((row) => row.from || row.to),
      remapTablespaces: remapTablespaces.filter((row) => row.from || row.to),
      networkLink: networkLink || null,
      flashbackConsistent: networkLink ? flashbackConsistent : false,
      objectFilter: cleanObjectFilter(objectFilter),
      // VIEWS_AS_TABLES는 DB 링크 Import에서만
      dataFilter: { ...cleanDataFilter(dataFilter), viewsAsTables: networkLink ? (dataFilter.viewsAsTables ?? []) : [] },
    };
  }

  async function showParfile(): Promise<void> {
    try {
      const preview = await previewDataPump(dbmsId, buildRequest());
      setParfileView({ title: 'Import parfile', command: preview.command, parfile: preview.parfile, parfileName: preview.parfileName, notes: preview.notes });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'parfile을 만들지 못했습니다.', 'error');
    }
  }

  async function run(typedDbname: string): Promise<void> {
    setStarting(true);
    try {
      const request = buildRequest();
      const { jobName } = await startDataPump(dbmsId, request, destructive ? typedDbname : undefined);
      showToast(`Import 작업 ${jobName}을(를) 시작했습니다. "작업 현황" 탭에서 진행 상황을 볼 수 있습니다.`);
      setConfirmOpen(false);
    } catch (error) {
      console.error('Error starting import:', error);
      showToast(error instanceof Error ? error.message : 'Import를 시작하지 못했습니다.', 'error');
    } finally {
      setStarting(false);
    }
  }

  // 가져온 값을 폼에 채운다. 절대 규칙: Export 항목(스키마/테이블/파티션)과 폼에 들어갈 항목이 개수·내용 모두 같아야 채운다.
  function applyDraft(draft: ImportDraft): string | null {
    const text = draft.mode === 'SCHEMA' ? draft.schemas.join(', ') : draft.mode === 'TABLE' ? draft.tables.join('\n') : '';
    const filled = draft.mode === 'FULL' ? [] : splitNames(text);
    if (!sameItems(filled, draft.items)) {
      return `Export ${draft.items.length}개 → Import 폼 ${filled.length}개로 항목이 맞지 않아 채우지 않았습니다 (이름에 공백 등 폼이 나눌 수 없는 문자가 있는지 확인하세요).`;
    }
    setNetworkLink('');
    if (draft.directory) {
      if (meta.directories.some((dir) => dir.name === draft.directory)) setDirectory(draft.directory);
      else showToast(`Export의 DIRECTORY ${draft.directory}가 이 DB에 없어 DIRECTORY는 지금 값을 유지합니다.`, 'error');
    }
    if (draft.dumpfile) setDumpfile(draft.dumpfile);
    setLogfile(`${todayPrefix('imp')}.log`);
    setMode(draft.mode);
    setSchemasText(draft.mode === 'SCHEMA' ? text : '');
    setTablesText(draft.mode === 'TABLE' ? text : '');
    setTableOwner('');
    if (draft.parallel) setParallel(meta.edition.parallelSupported ? draft.parallel : 1);
    if (draft.content) setContent(draft.content);
    if (draft.excludeStatistics !== null) setExcludeStatistics(draft.excludeStatistics);
    if (draft.metrics !== null) setMetrics(draft.metrics);
    if (draft.logtime !== null) setLogtime(draft.logtime);
    setObjectFilter(draft.objectFilter);
    setDataFilter(draft.dataFilter);
    if ((draft.dataFilter.queries ?? []).length > 0) setSqlEnabled(true);
    setImported({ source: draft.source, mode: draft.mode, items: draft.items });
    showToast(`${draft.source}: Export ${draft.items.length}개 → Import ${filled.length}개 일치, 폼에 채웠습니다.`);
    return null;
  }

  // Export parfile 여러 개 → impdp parfile을 파일마다 하나. 대상·DUMPFILE·필터는 그 Export에서, REMAP·TABLE_EXISTS_ACTION 등은 지금 폼 값.
  // 절대 규칙: 파일마다 Export 항목 수와 Import 요청 항목 수가 같아야 하고, 하나라도 실패하면 아무것도 만들지 않는다.
  async function applyMany(drafts: { name: string; draft: ImportDraft }[]): Promise<string | null> {
    const base = buildRequest();
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
    const digits = Math.max(2, String(drafts.length).length);
    const results: { name: string; items: number; filled: number; view: ParfileView; jobName: string }[] = [];
    for (const [index, { name, draft }] of drafts.entries()) {
      const nn = String(index + 1).padStart(digits, '0');
      const tables = draft.mode === 'TABLE' ? tableRequest(draft.items, '') : null;
      const filled = draft.mode === 'SCHEMA' ? draft.items.length : tables ? tables.qualifiedTables!.length - (tables.tablePartitions ?? []).length + (tables.tablePartitions ?? []).reduce((sum, item) => sum + item.partitions.length, 0) : 0;
      if (filled !== draft.items.length) return `${name}: Export ${draft.items.length}개 → Import ${filled}개로 맞지 않아 만들지 않았습니다 (같은 테이블을 통째와 파티션으로 함께 적었는지 확인하세요).`;
      const request: DataPumpRequest = {
        ...base,
        mode: draft.mode,
        schemas: draft.mode === 'SCHEMA' ? draft.items : undefined,
        qualifiedTables: tables?.qualifiedTables,
        tablePartitions: tables?.tablePartitions,
        tableOwner: undefined,
        tables: undefined,
        networkLink: null,
        flashbackConsistent: false,
        directory: draft.directory && meta.directories.some((dir) => dir.name === draft.directory) ? draft.directory : base.directory,
        dumpfile: draft.dumpfile ?? '',
        logfile: `${todayPrefix('imp')}_${nn}.log`,
        jobName: `DBC_IMP_${stamp}_${nn}`,
        // PARALLEL/CONTENT/통계 제외/REMAP/TABLE_EXISTS_ACTION은 아래 Import 폼 값 (base). 필터는 Export의 것과 폼의 것을 합친다.
        objectFilter: { rules: [...draft.objectFilter.rules, ...(base.objectFilter?.rules ?? [])] },
        dataFilter: { ...base.dataFilter, queries: [...(draft.dataFilter.queries ?? []), ...(base.dataFilter?.queries ?? [])], viewsAsTables: [] },
      };
      try {
        const preview = await previewDataPump(dbmsId, request);
        results.push({ name, items: draft.items.length, filled, jobName: preview.jobName, view: { title: `${preview.jobName} ← ${name}`, command: preview.command, parfile: preview.parfile, parfileName: preview.parfileName, notes: preview.notes } });
      } catch (error) {
        return `${name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    setManyParfiles(results);
    setManyDrafts(drafts);
    setManyOptions(optionsKey());
    showToast(`impdp parfile ${results.length}개를 만들었습니다.`);
    return null;
  }

  // 여러 개 만들 때 폼에서 가져오는 옵션 (바뀌었는지 비교용)
  function optionsKey(): string {
    const { remapSchemas: rs, remapTablespaces: rt, tableExistsAction: tea, parallel: par, content: con, excludeStatistics: ex, metrics: me, logtime: lt, objectFilter: of, dataFilter: df, directory: dir } = buildRequest();
    return JSON.stringify([rs, rt, tea, par, con, ex, me, lt, of, df, dir]);
  }

  async function rebuildMany(): Promise<void> {
    if (!manyDrafts) return;
    const problem = await applyMany(manyDrafts);
    if (problem) showToast(problem, 'error');
  }

  function downloadMany(): void {
    // 브라우저가 여러 파일 다운로드를 막지 않도록 조금씩 간격을 둔다 (Export 탭과 같은 방식)
    (manyParfiles ?? []).forEach((item, index) => window.setTimeout(() => downloadText(item.view.parfileName, item.view.parfile), index * 300));
  }

  // 채운 뒤 폼을 고쳐도 계속 대조해서 보여 준다
  const currentItems = mode === 'FULL' ? [] : splitNames(mode === 'SCHEMA' ? schemasText : tablesText);
  const importedMatch = imported ? imported.mode === mode && sameItems([...currentItems].sort(), [...imported.items].sort()) : null;

  return (
    <>
      <div className="rt-panel">
        <div className="rt-panel-header">
          <h3>기존 Export에서 가져오기</h3>
          <button type="button" className="btn-secondary" onClick={() => setFromExportOpen(true)}>
            기존 Export에서 가져오기
          </button>
        </div>
        <p className="oc-hint">Export의 작업 이력·parfile·로그에서 DIRECTORY, DUMPFILE, 대상(스키마/테이블/파티션), PARALLEL, CONTENT, 필터를 채웁니다.</p>
        {imported && (
          <p className={importedMatch ? 'dash-ok' : 'pc-warning'}>
            {imported.source}: Export {imported.items.length}개 → Import {currentItems.length}개 {importedMatch ? '일치' : '불일치 — 폼을 고쳤거나 모드가 바뀌었습니다'}
          </p>
        )}
      </div>
      <ImportFromExportModal open={fromExportOpen} dbmsId={dbmsId} meta={meta} onClose={() => setFromExportOpen(false)} onApply={applyDraft} onApplyMany={applyMany} onOpenMigration={onOpenMigration} />
      {manyParfiles && (
        <div className="rt-panel">
          <div className="rt-panel-header">
            <h3>
              impdp parfile {manyParfiles.length}개 (Export parfile마다 하나){' '}
              {manyOptions !== optionsKey() && <span className="dash-bad">아래 옵션이 바뀌었습니다 — 다시 만들어야 반영됩니다</span>}
            </h3>
            <div className="rt-panel-controls">
              <button type="button" onClick={rebuildMany}>
                아래 옵션으로 다시 만들기
              </button>
              <button type="button" className="btn-secondary" onClick={downloadMany}>
                parfile 전체 다운로드
              </button>
              <button type="button" className="btn-secondary" disabled={serverSave.saving} onClick={() => serverSave.save(directory, manyParfiles.map((item) => ({ name: item.view.parfileName, content: item.view.parfile })))}>
                DB 서버 {directory}에 전체 저장
              </button>
              <button type="button" className="btn-secondary" onClick={() => setManyParfiles(null)}>
                닫기
              </button>
            </div>
          </div>
          <table className="table oc-items-table">
            <thead>
              <tr>
                <th>Export parfile</th>
                <th>impdp parfile</th>
                <th>대조</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {manyParfiles.map((item) => (
                <tr key={item.jobName}>
                  <td className="oc-name">{item.name}</td>
                  <td>{item.view.parfileName}</td>
                  <td className={item.items === item.filled ? 'dash-ok' : 'dash-bad'}>
                    Export {item.items}개 → Import {item.filled}개 {item.items === item.filled ? '일치' : '불일치'}
                  </td>
                  <td>
                    <button type="button" className="btn-secondary" onClick={() => setParfileView(item.view)}>
                      보기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="oc-hint">
            Export parfile에서는 대상·DUMPFILE·DIRECTORY만 가져오고, REMAP_SCHEMA/REMAP_TABLESPACE·TABLE_EXISTS_ACTION·CONTENT·PARALLEL·통계 제외·필터는 아래 Import 폼 값으로 만듭니다(필터는 Export의 것과 합침). 아래에서 옵션을 바꾼 뒤 &quot;아래 옵션으로 다시 만들기&quot;를 누르세요.
          </p>
        </div>
      )}

      <div className="rt-panel">
        <h3>가져올 곳</h3>
        <div className="status-tabs dp-inline">
          <button type="button" className={`status-tab${!networkLink ? ' status-tab-active' : ''}`} onClick={() => setNetworkLink('')}>
            덤프 파일
          </button>
          <button
            type="button"
            className={`status-tab${networkLink ? ' status-tab-active' : ''}`}
            disabled={meta.dbLinks.length === 0}
            title={meta.dbLinks.length === 0 ? '이 DB에 쓸 수 있는 DB 링크가 없습니다.' : undefined}
            onClick={() => {
              setNetworkLink(meta.dbLinks[0]?.name ?? '');
              if (mode === 'FULL') setMode('SCHEMA'); // 링크로는 원본 DB 전체를 가져오지 않음
            }}
          >
            DB 링크 (NETWORK_LINK)
          </button>
        </div>
        {networkLink && (
          <>
            <div className="dp-grid">
              <div>
                <label htmlFor="dp-imp-link">DB 링크</label>
                <select id="dp-imp-link" value={networkLink} onChange={(e) => setNetworkLink(e.target.value)}>
                  {meta.dbLinks.map((link) => (
                    <option key={`${link.owner}.${link.name}`} value={link.name}>
                      {link.name}
                      {link.owner === 'PUBLIC' ? ' (PUBLIC)' : ''}
                      {link.host ? ` → ${link.host}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="oc-types">
              <label className="oc-check">
                <input type="checkbox" checked={flashbackConsistent} onChange={(e) => setFlashbackConsistent(e.target.checked)} />
                일관성 있는 시점으로 (원본 DB의 시작 시점 SCN — FLASHBACK)
              </label>
            </div>
            <p className="oc-hint">
              덤프 파일 없이 링크 너머 DB에서 {meta.target.dbname}로 바로 가져옵니다 (로그 파일만 아래 DIRECTORY에 생김). 링크 접속 계정에 export 권한
              (DATAPUMP_EXP_FULL_DATABASE)이 필요하고, LONG 컬럼 테이블은 링크로 가져올 수 없습니다. 네트워크 대역폭이 속도를 좌우합니다.
            </p>
          </>
        )}
        <div className="dp-grid">
          <div>
            <label htmlFor="dp-imp-dir">DIRECTORY</label>
            <select id="dp-imp-dir" value={directory} onChange={(e) => setDirectory(e.target.value)}>
              {meta.directories.map((dir) => (
                <option key={dir.name} value={dir.name}>
                  {dir.name}
                </option>
              ))}
            </select>
            {directoryPath && <div className="dp-hint-line">DB 서버 경로: {directoryPath}</div>}
          </div>
          {!networkLink && (
            <div>
              <label htmlFor="dp-imp-dump">덤프 파일 (여러 개면 %U)</label>
              <input id="dp-imp-dump" type="text" placeholder="예: exp_20261002_01_%U.dmp" value={dumpfile} onChange={(e) => setDumpfile(e.target.value)} />
            </div>
          )}
          <div>
            <label htmlFor="dp-imp-log">로그 파일</label>
            <input id="dp-imp-log" type="text" value={logfile} onChange={(e) => setLogfile(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rt-panel">
        <h3>가져올 범위와 옵션</h3>
        <div className="status-tabs dp-inline">
          {(networkLink ? (['SCHEMA', 'TABLE'] as const) : (['FULL', 'SCHEMA', 'TABLE'] as const)).map((value) => (
            <button key={value} type="button" className={`status-tab${mode === value ? ' status-tab-active' : ''}`} onClick={() => setMode(value)}>
              {value === 'FULL' ? '덤프 전체' : value === 'SCHEMA' ? '스키마 지정' : '테이블 지정'}
            </button>
          ))}
        </div>
        {mode === 'SCHEMA' && (
          <>
            <label htmlFor="dp-imp-schemas">스키마 (쉼표/줄바꿈으로 여러 개)</label>
            <input id="dp-imp-schemas" type="text" placeholder="HR, SCOTT" value={schemasText} onChange={(e) => setSchemasText(e.target.value)} />
          </>
        )}
        {mode === 'TABLE' && (
          <div className="dp-grid">
            <div>
              <label htmlFor="dp-imp-owner">테이블 소유자 (OWNER.를 안 붙인 테이블에만)</label>
              <input id="dp-imp-owner" type="text" value={tableOwner} onChange={(e) => setTableOwner(e.target.value)} />
            </div>
            <div>
              <label htmlFor="dp-imp-tables">테이블 (쉼표/줄바꿈으로 여러 개 — OWNER.TABLE, OWNER.TABLE:PARTITION도 됨)</label>
              <textarea id="dp-imp-tables" rows={4} value={tablesText} onChange={(e) => setTablesText(e.target.value)} />
            </div>
          </div>
        )}

        <div className="dp-grid">
          <RemapEditor label="REMAP_SCHEMA (원본 → 대상 스키마)" rows={remapSchemas} onChange={setRemapSchemas} />
          <RemapEditor label="REMAP_TABLESPACE (원본 → 대상 테이블스페이스)" rows={remapTablespaces} onChange={setRemapTablespaces} />
        </div>

        <div className="dp-grid">
          <div>
            <label htmlFor="dp-imp-tea">이미 있는 테이블 (TABLE_EXISTS_ACTION)</label>
            <select id="dp-imp-tea" value={tableExistsAction} onChange={(e) => setTableExistsAction(e.target.value as TableExistsAction)}>
              {TABLE_EXISTS_ACTIONS.map((action) => (
                <option key={action.value} value={action.value}>
                  {action.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="dp-imp-content">CONTENT</label>
            <select id="dp-imp-content" value={content} onChange={(e) => setContent(e.target.value as DataPumpContent)}>
              <option value="ALL">ALL (구조 + 데이터)</option>
              <option value="METADATA_ONLY">METADATA_ONLY (구조만)</option>
              <option value="DATA_ONLY">DATA_ONLY (데이터만)</option>
            </select>
          </div>
          <div>
            <label htmlFor="dp-imp-parallel">PARALLEL</label>
            <input
              id="dp-imp-parallel"
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
        </div>
        <div className="oc-types">
          <label className="oc-check">
            <input type="checkbox" checked={excludeStatistics && !statsLocked} disabled={statsLocked} onChange={(e) => setExcludeStatistics(e.target.checked)} />
            통계 제외 (EXCLUDE=STATISTICS){statsLocked && ' — INCLUDE를 쓰면 포함 목록이 정함 (21c 미만)'}
          </label>
          <LogOptions metrics={metrics} logtime={logtime} onMetrics={setMetrics} onLogtime={setLogtime} versionNumber={meta.versionNumber} />
        </div>
        <ObjectFilterEditor
          value={objectFilter}
          onChange={setObjectFilter}
          jobMode={mode}
          objectPaths={meta.objectPaths}
          versionNumber={meta.versionNumber}
          sqlEnabled={sqlAllowed && sqlEnabled}
        />
        <DataFilterEditor
          value={dataFilter}
          onChange={setDataFilter}
          operation="IMPORT"
          networkLink={networkLink || null}
          versionNumber={meta.versionNumber}
          sqlAllowed={sqlAllowed}
          sqlEnabled={sqlAllowed && sqlEnabled}
          onSqlEnabledChange={setSqlEnabled}
          tableExistsAction={tableExistsAction}
          allowViews={!!networkLink && mode === 'TABLE'}
          viewSchemas={meta.schemas}
          dbmsId={dbmsId}
        />
        {destructive && (
          <p className="pc-warning">
            TABLE_EXISTS_ACTION={tableExistsAction}는 대상 DB({meta.target.dbname})의 기존 데이터를 바꿉니다. 실행할 때 DB명을 직접 입력해야 합니다.
          </p>
        )}
        <div className="oc-actions dp-buttons">
          <button type="button" className="btn-secondary" onClick={showParfile}>
            parfile 보기
          </button>
          <button type="button" className={destructive ? 'btn-danger' : undefined} disabled={!networkLink && !dumpfile.trim()} onClick={() => setConfirmOpen(true)}>
            Import 실행
          </button>
        </div>
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="Import 실행"
        confirmLabel="Import 시작"
        danger={destructive}
        requireText={destructive ? meta.target.dbname : null}
        busy={starting}
        onConfirm={run}
        onClose={() => setConfirmOpen(false)}
      >
        <p>
          <strong>{meta.target.dbname}</strong>에{' '}
          {networkLink ? (
            <>
              DB 링크 <code>{networkLink}</code> 너머 DB에서 바로
            </>
          ) : (
            <code>
              {directory}/{dumpfile}
            </code>
          )}
          를 가져옵니다.
        </p>
        <ul className="dp-summary">
          <li>범위: {mode === 'FULL' ? '덤프 전체' : mode === 'SCHEMA' ? `스키마 ${splitNames(schemasText).join(', ')}` : `테이블 ${splitNames(tablesText).length}개 (${splitNames(tablesText).slice(0, 10).map((name) => (name.includes('.') || !tableOwner ? name : `${tableOwner}.${name}`)).join(', ')}${splitNames(tablesText).length > 10 ? ' …' : ''})`}</li>
          {remapSchemas.filter((row) => row.from).map((row) => (
            <li key={`s${row.from}`}>
              REMAP_SCHEMA {row.from} → {row.to}
            </li>
          ))}
          {remapTablespaces.filter((row) => row.from).map((row) => (
            <li key={`t${row.from}`}>
              REMAP_TABLESPACE {row.from} → {row.to}
            </li>
          ))}
          <li>
            이미 있는 테이블: <strong>{tableExistsAction}</strong>
          </li>
        </ul>
        <FilterSummary objectFilter={cleanObjectFilter(objectFilter)} dataFilter={cleanDataFilter(dataFilter)} />
      </ConfirmModal>
      <ParfileModal
        view={parfileView}
        onClose={() => setParfileView(null)}
        serverDirectory={directory}
        saving={serverSave.saving}
        onSaveToServer={(view) => serverSave.save(directory, [{ name: view.parfileName, content: view.parfile }])}
      />
      {serverSave.confirmNode}
    </>
  );
}
