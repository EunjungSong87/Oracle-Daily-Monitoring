import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { ApiError, getImportDraft, getImportDraftExports } from '../../shared/lib/api';
import type { DataPumpMeta, ImportDraft, ImportDraftExportRow } from '../../shared/lib/types';

// Import 탭 "기존 Export에서 가져오기": 작업 이력 / parfile / Export 로그 헤더에서 Import 폼 값을 읽어 온다 (서버가 파싱).
// 대상 DB에는 새 조회를 하지 않는다 — 이력은 메타 DB, 로그는 기존 로그 읽기 API.

interface Props {
  open: boolean;
  dbmsId: string;
  meta: DataPumpMeta;
  onClose: () => void;
  onApply: (draft: ImportDraft) => string | null; // 채우지 못하면 이유를 돌려준다 (항목 수 불일치 등)
  onOpenMigration?: (bundleKey: string) => void; // 분할 묶음은 이관 Import 탭에서
  // Export parfile 여러 개 → impdp parfile 여러 개 (파일마다 하나). 만들지 못하면 이유를 돌려준다.
  onApplyMany?: (drafts: { name: string; draft: ImportDraft }[]) => Promise<string | null>;
}

type Source = 'HISTORY' | 'PARFILE' | 'LOG';

export function ImportFromExportModal({ open, dbmsId, meta, onClose, onApply, onOpenMigration, onApplyMany }: Props): ReactElement | null {
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source>('HISTORY');
  const [exports, setExports] = useState<ImportDraftExportRow[] | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [directory, setDirectory] = useState(meta.directories.find((dir) => dir.name === 'DATA_PUMP_DIR')?.name ?? meta.directories[0]?.name ?? '');
  const [logfile, setLogfile] = useState('');
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]); // 여러 개 올린 parfile
  const [many, setMany] = useState<{ name: string; draft: ImportDraft }[] | null>(null);
  const [error, setError] = useState<{ message: string; items: string[] } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setError(null);
    getImportDraftExports(dbmsId)
      .then(setExports)
      .catch(() => setExports([]));
  }, [open, dbmsId]);

  if (!open) return null;
  // 분할 묶음(작업 2개 이상)의 작업 하나만 채우면 나머지 덤프의 항목이 빠진다 → 이관 Import 탭으로 안내 (서버도 거부)
  const bundled = source === 'HISTORY' ? (exports ?? []).find((row) => row.id === historyId && row.bundleJobs > 1) ?? null : null;

  async function read(): Promise<void> {
    setLoading(true);
    setDraft(null);
    setMany(null);
    setError(null);
    try {
      if (source === 'PARFILE' && files.length > 1) {
        // 파일마다 따로 읽는다 — 하나라도 못 읽으면 전체를 만들지 않는다 (빠지는 parfile이 없게)
        const results: { name: string; draft: ImportDraft }[] = [];
        for (const file of files) {
          try {
            results.push({ name: file.name, draft: await getImportDraft(dbmsId, { source: 'PARFILE', text: file.text }) });
          } catch (err) {
            throw new ApiError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, err instanceof ApiError ? err.items : []);
          }
        }
        setMany(results);
        return;
      }
      const input =
        source === 'HISTORY'
          ? { source, historyId: historyId ?? -1 }
          : source === 'PARFILE'
            ? { source, text }
            : { source, directory, logfile: logfile.trim() };
      setDraft(await getImportDraft(dbmsId, input));
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : '읽지 못했습니다.', items: err instanceof ApiError ? err.items : [] });
    } finally {
      setLoading(false);
    }
  }

  function upload(event: ChangeEvent<HTMLInputElement>): void {
    const picked = [...(event.target.files ?? [])];
    event.target.value = '';
    if (picked.length === 0) return;
    Promise.all(picked.map(async (file) => ({ name: file.name, text: await file.text() })))
      .then((read) => {
        setFiles(read.length > 1 ? read : []);
        setText(read.length > 1 ? read.map((file) => `# ${file.name}\n${file.text}`).join('\n') : read[0].text);
        setMany(null);
        setDraft(null);
      })
      .catch(() => setError({ message: '파일을 읽지 못했습니다.', items: [] }));
  }

  async function applyMany(): Promise<void> {
    if (!many || !onApplyMany) return;
    setLoading(true);
    const problem = await onApplyMany(many);
    setLoading(false);
    if (problem) setError({ message: problem, items: [] });
    else onClose();
  }

  function apply(): void {
    if (!draft) return;
    const problem = onApply(draft);
    if (problem) setError({ message: problem, items: [] });
    else onClose();
  }

  return (
    <Modal open onClose={onClose} title="기존 Export에서 가져오기" wide>
      <div className="modal-body">
        <div className="status-tabs" role="group" aria-label="가져올 곳">
          {(
            [
              ['HISTORY', '작업 이력'],
              ['PARFILE', 'parfile'],
              ['LOG', 'Export 로그'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" className={`status-tab${source === key ? ' status-tab-active' : ''}`} onClick={() => (setSource(key), setDraft(null), setError(null))}>
              {label}
            </button>
          ))}
        </div>

        {source === 'HISTORY' && (
          <>
            {exports && exports.length === 0 && <p className="issues-empty">이 DB에서 끝난 Export 이력이 없습니다.</p>}
            {exports && exports.length > 0 && (
              <select aria-label="Export 이력" size={8} value={historyId ?? ''} onChange={(e) => setHistoryId(Number(e.target.value))}>
                {exports.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.startedAt} · {row.jobName} · {row.jobMode} · {row.status}
                    {row.bundleJobs > 1 ? ` (묶음 ${row.bundleJobs}개 — 이관 Import)` : row.hasRequest ? '' : ' (요청 없음 — 대상 목록 사용)'} · {row.targetDesc ?? ''}
                  </option>
                ))}
              </select>
            )}
            {bundled && (
              <div className="pc-warning">
                이 Export는 작업 {bundled.bundleJobs}개로 나눈 묶음입니다. 하나만 가져오면 나머지 덤프의 항목이 빠지므로, 묶음 전체를 "이관 Import" 탭에서 만드세요 (빠짐·중복 확인, 덤프 파일·사전 점검, 실행 후 대조).
                {onOpenMigration && bundled.bundleKey && (
                  <div className="oc-actions">
                    <button type="button" onClick={() => (onOpenMigration(bundled.bundleKey as string), onClose())}>
                      이관 Import에서 묶음 전체로 만들기
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {source === 'PARFILE' && (
          <>
            {files.length > 1 && <p className="oc-hint">parfile {files.length}개를 올렸습니다 — 파일마다 impdp parfile을 하나씩 만듭니다 ({files.map((file) => file.name).join(', ')}).</p>}
            <textarea rows={10} readOnly={files.length > 1} placeholder={'Export parfile 내용을 붙여넣으세요\nDIRECTORY=DATA_PUMP_DIR\nDUMPFILE=exp_%U.dmp\nTABLES=HR.EMP,SALES.ORDERS:P2026_01'} value={text} onChange={(e) => setText(e.target.value)} />
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>
              .par 파일 올리기 (여러 개 가능)
            </button>
            {files.length > 1 && (
              <button type="button" className="btn-secondary" onClick={() => (setFiles([]), setText(''), setMany(null))}>
                지우기
              </button>
            )}
            <input ref={fileRef} type="file" multiple accept=".par,.txt" style={{ display: 'none' }} onChange={upload} />
          </>
        )}
        {source === 'LOG' && (
          <div className="dp-grid">
            <div>
              <label htmlFor="dp-ife-dir">DIRECTORY</label>
              <select id="dp-ife-dir" value={directory} onChange={(e) => setDirectory(e.target.value)}>
                {meta.directories.map((dir) => (
                  <option key={dir.name} value={dir.name}>
                    {dir.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="dp-ife-log">Export 로그 파일</label>
              <input id="dp-ife-log" type="text" placeholder="예: exp_20261022.log" value={logfile} onChange={(e) => setLogfile(e.target.value)} />
            </div>
          </div>
        )}

        <div className="oc-actions dp-buttons">
          <button
            type="button"
            className="btn-secondary"
            disabled={loading || (source === 'HISTORY' && (historyId === null || bundled !== null)) || (source === 'PARFILE' && !text.trim()) || (source === 'LOG' && !logfile.trim())}
            onClick={read}
          >
            {loading ? '읽는 중...' : '읽기'}
          </button>
        </div>

        {error && (
          <div className="pc-warning dp-items-box">
            <strong>{error.message}</strong>
            {error.items.length > 0 && <textarea readOnly rows={Math.min(10, error.items.length + 1)} value={error.items.join('\n')} />}
          </div>
        )}

        {many && (
          <div className="dp-items-box">
            <table className="table oc-items-table">
              <thead>
                <tr>
                  <th>Export parfile</th>
                  <th>대상</th>
                  <th>DUMPFILE</th>
                  <th>반영 안 된 항목 / 경고</th>
                </tr>
              </thead>
              <tbody>
                {many.map(({ name, draft: item }) => (
                  <tr key={name}>
                    <td className="oc-name">{name}</td>
                    <td title={item.items.join('\n')}>{item.mode === 'FULL' ? '덤프 전체' : `${item.mode === 'SCHEMA' ? '스키마' : '테이블/파티션'} ${item.items.length}개`}</td>
                    <td>{item.dumpfile ?? '-'}</td>
                    <td>
                      {[...item.unknownKeys.map((key) => `반영 안 됨: ${key}`), ...item.warnings].map((line) => (
                        <div key={line} className="dp-hint-line">
                          {line}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="oc-hint">대상·DUMPFILE·DIRECTORY는 파일마다, REMAP·TABLE_EXISTS_ACTION·CONTENT·PARALLEL 등 옵션은 Import 폼 값으로 만듭니다 (만든 뒤 폼에서 바꾸고 다시 만들 수 있음).</p>
            <div className="oc-actions dp-buttons">
              <button type="button" disabled={loading || !onApplyMany} onClick={applyMany}>
                {loading ? '만드는 중...' : `impdp parfile ${many.length}개 만들기`}
              </button>
            </div>
          </div>
        )}

        {draft && (
          <div className="dp-items-box">
            <p>
              <strong>{draft.source}</strong> · {draft.mode === 'FULL' ? '덤프 전체' : draft.mode === 'SCHEMA' ? `스키마 ${draft.items.length}개` : `테이블/파티션 ${draft.items.length}개`} · DIRECTORY {draft.directory ?? '-'} · DUMPFILE{' '}
              {draft.dumpfile ?? '-'}
              {draft.parallel ? ` · PARALLEL ${draft.parallel}` : ''}
              {draft.content ? ` · CONTENT ${draft.content}` : ''}
            </p>
            {draft.items.length > 0 && <textarea readOnly rows={Math.min(8, draft.items.length + 1)} value={draft.items.join('\n')} aria-label="가져올 항목" />}
            {draft.warnings.map((warning) => (
              <p key={warning} className="pc-warning">
                {warning}
              </p>
            ))}
            {draft.unknownKeys.length > 0 && (
              <div className="pc-warning">
                <strong>반영 안 된 항목 {draft.unknownKeys.length}개</strong> (Import 폼에 채우지 않음)
                <textarea readOnly rows={Math.min(6, draft.unknownKeys.length + 1)} value={draft.unknownKeys.join('\n')} />
              </div>
            )}
            <p className="oc-hint">LOGFILE은 새로 만들고, REMAP_*와 TABLE_EXISTS_ACTION은 Export에 없는 항목이라 채우지 않습니다.</p>
            <div className="oc-actions dp-buttons">
              <button type="button" onClick={apply}>
                Import 폼에 채우기
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
