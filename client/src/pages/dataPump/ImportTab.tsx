import { useState, type ReactElement } from 'react';
import { previewDataPump, startDataPump } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DataPumpContent, DataPumpMeta, DataPumpRequest, TableExistsAction } from '../../shared/lib/types';
import { ConfirmModal } from './ConfirmModal';
import { todayPrefix } from './helpers';
import { ParfileModal, type ParfileView } from './ParfileModal';
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
}

// Import: 덤프 파일에서 가져오기. 기존 데이터를 건드리는 TABLE_EXISTS_ACTION은 대상 DB명을 입력해야 실행된다 (서버도 한 번 더 확인).
export function ImportTab({ dbmsId, meta }: Props): ReactElement {
  const [directory, setDirectory] = useState(meta.directories.find((dir) => dir.name === 'DATA_PUMP_DIR')?.name ?? meta.directories[0]?.name ?? '');
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
  const [parallel, setParallel] = useState(meta.edition.parallelSupported ? 4 : 1);

  const [parfileView, setParfileView] = useState<ParfileView | null>(null);
  const serverSave = useServerSave(dbmsId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const destructive = tableExistsAction !== 'SKIP';
  const directoryPath = meta.directories.find((dir) => dir.name === directory)?.path;

  function buildRequest(): DataPumpRequest {
    return {
      operation: 'IMPORT',
      mode,
      schemas: mode === 'SCHEMA' ? splitNames(schemasText) : undefined,
      tableOwner: mode === 'TABLE' ? tableOwner : undefined,
      tables: mode === 'TABLE' ? splitNames(tablesText) : undefined,
      directory,
      dumpfile,
      logfile,
      parallel,
      content,
      excludeStatistics,
      tableExistsAction,
      remapSchemas: remapSchemas.filter((row) => row.from || row.to),
      remapTablespaces: remapTablespaces.filter((row) => row.from || row.to),
    };
  }

  async function showParfile(): Promise<void> {
    try {
      const preview = await previewDataPump(dbmsId, buildRequest());
      setParfileView({ title: 'Import parfile', command: preview.command, parfile: preview.parfile, parfileName: preview.parfileName });
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

  return (
    <>
      <div className="rt-panel">
        <h3>덤프 파일</h3>
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
          <div>
            <label htmlFor="dp-imp-dump">덤프 파일 (여러 개면 %U)</label>
            <input id="dp-imp-dump" type="text" placeholder="예: exp_20261002_01_%U.dmp" value={dumpfile} onChange={(e) => setDumpfile(e.target.value)} />
          </div>
          <div>
            <label htmlFor="dp-imp-log">로그 파일</label>
            <input id="dp-imp-log" type="text" value={logfile} onChange={(e) => setLogfile(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="rt-panel">
        <h3>가져올 범위와 옵션</h3>
        <div className="status-tabs dp-inline">
          {(['FULL', 'SCHEMA', 'TABLE'] as const).map((value) => (
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
              <label htmlFor="dp-imp-owner">테이블 소유자</label>
              <input id="dp-imp-owner" type="text" value={tableOwner} onChange={(e) => setTableOwner(e.target.value)} />
            </div>
            <div>
              <label htmlFor="dp-imp-tables">테이블 (쉼표/줄바꿈으로 여러 개)</label>
              <input id="dp-imp-tables" type="text" value={tablesText} onChange={(e) => setTablesText(e.target.value)} />
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
            <input type="checkbox" checked={excludeStatistics} onChange={(e) => setExcludeStatistics(e.target.checked)} />
            통계 제외 (EXCLUDE=STATISTICS)
          </label>
        </div>
        {destructive && (
          <p className="pc-warning">
            TABLE_EXISTS_ACTION={tableExistsAction}는 대상 DB({meta.target.dbname})의 기존 데이터를 바꿉니다. 실행할 때 DB명을 직접 입력해야 합니다.
          </p>
        )}
        <div className="oc-actions dp-buttons">
          <button type="button" className="btn-secondary" onClick={showParfile}>
            parfile 보기
          </button>
          <button type="button" className={destructive ? 'btn-danger' : undefined} disabled={!dumpfile.trim()} onClick={() => setConfirmOpen(true)}>
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
          <strong>{meta.target.dbname}</strong>에 <code>{directory}/{dumpfile}</code>를 가져옵니다.
        </p>
        <ul className="dp-summary">
          <li>범위: {mode === 'FULL' ? '덤프 전체' : mode === 'SCHEMA' ? `스키마 ${splitNames(schemasText).join(', ')}` : `${tableOwner}.${splitNames(tablesText).join(', ')}`}</li>
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
