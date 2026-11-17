import { Fragment, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { analyzeLogReview, downloadLogReviewExcel, type AnalyzeLogReviewRequest } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { LogReviewFinding, LogReviewResult, LogReviewType } from '../../shared/lib/types';
import { prefilterListenerLog } from './prefilter';

// Maintenance > 로그 업로드 검토: alert / 리스너 / CRS 로그 파일(또는 붙여넣은 일부)을 패턴으로 훑어 특이사항을 보여준다.
// 대상 DB에 접속하지 않고, 서버는 받은 텍스트를 그 요청 안에서만 분석한다 (저장 없음).
// Monitoring > Alert Log(V$DIAG_ALERT_EXT 조회)와는 별개 기능.

const LOG_TYPES: [LogReviewType, string][] = [
  ['ALERT', 'Alert 로그'],
  ['LISTENER', '리스너 로그'],
  ['CRS', 'CRS 로그'],
];

// 서버 요청 한도(20mb JSON)를 넘지 않게 큰 파일은 일부만 보낸다 (JSON 이스케이프 여유분 포함).
const CLIENT_MAX_BYTES = 18 * 1024 * 1024;
// 리스너 로그를 골라 보낼 때는 줄 번호 목록(줄마다 최대 10자리 정도)도 같이 가므로 본문 한도를 더 낮춘다.
const PREFILTER_MAX_BYTES = 12 * 1024 * 1024;
const PREFILTER_MAX_LINES = 500_000; // 서버 MAX_LINES와 같음
const RENDER_STEP = 1000;

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function severityBadge(severity: LogReviewFinding['severity']): string {
  return severity === 'CRITICAL' ? 'issue-badge issue-badge-error' : severity === 'WARN' ? 'issue-badge issue-badge-warn' : 'issue-badge lr-badge-info';
}

function findingKey(finding: LogReviewFinding): string {
  return `${finding.line}:${finding.synthetic ? 'S' : 'L'}`;
}

function ContextView({ finding }: { finding: LogReviewFinding }): ReactElement {
  if (finding.contextFrom === null) {
    return <pre className="lr-context">{finding.context.join('\n')}</pre>;
  }
  const from = finding.contextFrom;
  return (
    <pre className="lr-context">
      {finding.context.map((text, index) => {
        const lineNo = from + index;
        return (
          <span key={lineNo} className={lineNo === finding.line ? 'lr-context-hit' : undefined}>
            {`${String(lineNo).padStart(7)}  ${text}\n`}
          </span>
        );
      })}
    </pre>
  );
}

export function App(): ReactElement {
  const { user, loading } = useCurrentUser();
  const canUse = canSee(user, 'logReview');
  const [logType, setLogType] = useState<LogReviewType>('ALERT');
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null); // 대용량 리스너 로그 훑는 중 (0~1)
  const [result, setResult] = useState<LogReviewResult | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(true);
  const [securityOnly, setSecurityOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renderCount, setRenderCount] = useState(RENDER_STEP);

  function pickFile(event: ChangeEvent<HTMLInputElement>): void {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (picked) setFile(picked); // 실제로 읽는 건 "검토" 때 — 읽는 방식이 로그 종류에 따라 다르다
  }

  // 파일 읽기: 작으면 통째로. 크면 리스너 로그는 전체를 훑어 실패/TNS 줄만 원래 줄 번호와 함께,
  // 그 외는 최근 기록이 있는 끝부분만 (잘린 첫 줄 반쪽은 버림).
  async function buildRequest(picked: File): Promise<AnalyzeLogReviewRequest> {
    const base = { logType, fileName: picked.name };
    if (picked.size <= CLIENT_MAX_BYTES) return { ...base, content: await readText(picked) };
    if (logType === 'LISTENER') {
      setProgress(0);
      const filtered = await prefilterListenerLog(picked, PREFILTER_MAX_BYTES, PREFILTER_MAX_LINES, setProgress);
      return { ...base, content: filtered.content, lineNumbers: filtered.lineNumbers, sourceLines: filtered.sourceLines, clientTruncated: filtered.droppedForSize };
    }
    const text = await readText(picked.slice(picked.size - CLIENT_MAX_BYTES));
    return { ...base, content: text.slice(text.indexOf('\n') + 1), clientTruncated: true };
  }

  async function runReview(): Promise<void> {
    if (!file && !pasted.trim()) {
      showToast('파일을 고르거나 로그를 붙여넣어 주세요.', 'error');
      return;
    }
    setBusy(true);
    try {
      const request = file ? await buildRequest(file) : { logType, fileName: '붙여넣은 텍스트', content: pasted };
      setProgress(null);
      if (!request.content.trim()) {
        showToast(request.lineNumbers ? '접속 실패나 TNS 오류 줄이 없습니다.' : '검토할 내용이 없습니다.');
        return;
      }
      const reviewed = await analyzeLogReview(request);
      setResult(reviewed);
      setExpanded(new Set());
      setRenderCount(RENDER_STEP);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '로그를 분석하지 못했습니다.', 'error');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const bigFile = file !== null && file.size > CLIENT_MAX_BYTES;

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const findings = useMemo(
    () => (result ? result.findings.filter((f) => (!problemsOnly || f.severity !== 'INFO') && (!securityOnly || f.category === 'SECURITY')) : []),
    [result, problemsOnly, securityOnly]
  );
  const s = result?.summary;
  const categories = s ? Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]) : [];

  return (
    <>
      <AppHeader active="logReview" />
      <ToastHost />
      <h2 className="page-title">로그 업로드 검토 (alert / 리스너 / CRS 로그 패턴 분석)</h2>
      {!loading && !canUse && <p className="issues-empty">이 화면을 볼 권한이 없습니다.</p>}
      {canUse && (
        <div className="rt-panel">
          <h3>1. 로그 선택</h3>
          <div className="status-tabs lr-tabs">
            {LOG_TYPES.map(([key, label]) => (
              <button key={key} type="button" className={`status-tab${logType === key ? ' status-tab-active' : ''}`} onClick={() => setLogType(key)}>
                {label}
              </button>
            ))}
          </div>
          <p className="oc-hint">
            로그 종류는 직접 고르세요 (자동 판별하지 않음). 대상 DB에 접속하지 않고, 올린 내용은 분석에만 쓰고 저장하지 않습니다.
          </p>
          <div className="dp-row">
            <label htmlFor="lr-file">파일</label>
            <input id="lr-file" type="file" accept=".log,.txt,text/plain" onChange={pickFile} />
            {file && (
              <>
                <span className="oc-hint">
                  {file.name} ({formatSize(file.size)}
                  {bigFile ? (logType === 'LISTENER' ? ' — 전체를 훑어 접속 실패·TNS 줄만 골라 분석' : ` — 끝 ${formatSize(CLIENT_MAX_BYTES)}(최근 기록)만 분석`) : ''})
                </span>
                <button type="button" className="btn-secondary" onClick={() => setFile(null)}>
                  파일 지우기
                </button>
              </>
            )}
          </div>
          <textarea
            className="lr-paste"
            rows={8}
            placeholder={file ? '파일을 골랐습니다 — 붙여넣은 텍스트를 쓰려면 "파일 지우기"를 누르세요.' : '또는 로그 일부를 여기에 붙여넣으세요.'}
            value={pasted}
            disabled={Boolean(file)}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="oc-actions">
            <button type="button" disabled={busy} onClick={runReview}>
              {progress !== null ? `파일 훑는 중 ${Math.round(progress * 100)}%` : busy ? '검토 중...' : '검토'}
            </button>
          </div>
        </div>
      )}

      {canUse && result && s && (
        <div className="rt-panel">
          <div className="rt-panel-header">
            <h3>
              2. 결과 — {result.fileName} · {LOG_TYPES.find(([key]) => key === result.logType)?.[1]} · {result.lineCount.toLocaleString()}줄
            </h3>
            <div className="rt-panel-controls">
              <label className="oc-check">
                <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> 문제만 보기
              </label>
              <label className="oc-check">
                <input type="checkbox" checked={securityOnly} onChange={(e) => setSecurityOnly(e.target.checked)} /> 보안만 보기
              </label>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => downloadLogReviewExcel(result).catch((err) => showToast(err instanceof Error ? err.message : '엑셀을 만들지 못했습니다.', 'error'))}
              >
                엑셀 내보내기
              </button>
            </div>
          </div>
          <div className="dash-summary">
            <div className={s.critical > 0 ? 'dash-summary-bad' : undefined}>
              <span>CRITICAL</span>
              <strong>{s.critical.toLocaleString()}</strong>
            </div>
            <div className={s.warn > 0 ? 'dash-summary-warn' : undefined}>
              <span>WARN</span>
              <strong>{s.warn.toLocaleString()}</strong>
            </div>
            <div>
              <span>INFO</span>
              <strong>{s.info.toLocaleString()}</strong>
            </div>
            <div className={s.security > 0 ? 'dash-summary-bad' : undefined}>
              <span>보안 (SECURITY)</span>
              <strong>{s.security.toLocaleString()}</strong>
            </div>
          </div>
          {categories.length > 0 && <p className="oc-hint">카테고리: {categories.map(([category, count]) => `${category} ${count.toLocaleString()}`).join(' · ')}</p>}
          {result.notes.map((note) => (
            <p key={note} className="pc-warning">
              {note}
            </p>
          ))}
          {result.logType === 'ALERT' && securityOnly && (
            <p className="oc-hint">ORA-01017/ORA-01031 같은 로그인·권한 실패는 unified audit을 켜지 않은 DB에선 alert 로그에 잘 남지 않습니다.</p>
          )}
          {findings.length === 0 ? (
            <p className="issues-empty">{s.total === 0 ? '특이사항이 없습니다.' : '필터 조건에 맞는 항목이 없습니다.'}</p>
          ) : (
            <table className="table oc-items-table">
              <thead>
                <tr>
                  <th>줄</th>
                  <th>시각</th>
                  <th>심각도</th>
                  <th>카테고리</th>
                  <th>내용</th>
                  <th>원문</th>
                </tr>
              </thead>
              <tbody>
                {findings.slice(0, renderCount).map((finding) => {
                  const key = findingKey(finding);
                  const open = expanded.has(key);
                  return (
                    <Fragment key={key}>
                      <tr className="cap-row" onClick={() => toggle(key)} title="클릭하면 전후 줄 보기">
                        <td className="al-nowrap">{finding.line.toLocaleString()}</td>
                        <td className="al-nowrap">{finding.time ?? '-'}</td>
                        <td>
                          <span className={severityBadge(finding.severity)}>{finding.severity}</span>
                        </td>
                        <td className="al-nowrap">{finding.category}</td>
                        <td>{finding.label}</td>
                        <td className="al-msg">{finding.text}</td>
                      </tr>
                      {open && (
                        <tr className="oc-detail-row">
                          <td colSpan={6}>
                            <ContextView finding={finding} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
          {findings.length > renderCount && (
            <div className="oc-actions">
              <span className="oc-hint">
                {renderCount.toLocaleString()} / {findings.length.toLocaleString()}건 표시 중
              </span>
              <button type="button" className="btn-secondary" onClick={() => setRenderCount((n) => n + RENDER_STEP)}>
                더 보기
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
