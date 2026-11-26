import { useMemo, useState, type ReactElement } from 'react';
import type { MonitoringTaskResult } from '../lib/types';

// 점검 결과(일일 점검 실행 결과 / 점검 이력 상세 공통). task별로 제목 + (성공 시) 결과 테이블을 그리고,
// 임계치 위반 셀은 _alerts[column].level 기준으로 cell-{level} 클래스를 붙인다.
// 위에 레벨별 위반 요약을 두고, 위반·실패가 있는 항목만 보거나 항목을 접어 볼 수 있다.

const LEVELS = ['CRITICAL', 'ERROR', 'WARN', 'INFO'] as const;
type Level = (typeof LEVELS)[number];
type LevelCounts = Record<Level, number>;

// 서버 utils/issueKinds.ts의 실패 유형 문구와 같음
const FAILURE_LABELS: Record<string, string> = {
  TIMEOUT: '실행 시간 초과',
  DISCONNECTED: '실행 중 연결 끊김',
  ERROR: 'SQL 실행 오류',
  CONNECT: '대상 DB 접속 실패',
};

// 에러 문자열의 대표 코드 (ORA-00942 등). 없으면 null.
function errorCode(error: string | undefined): string | null {
  const match = /\b(ORA|NJS|DPI|TNS|PLS)-\d{3,5}\b/.exec(error ?? '');
  return match ? match[0] : null;
}

function emptyCounts(): LevelCounts {
  return { CRITICAL: 0, ERROR: 0, WARN: 0, INFO: 0 };
}

// 위반 셀 수를 레벨별로 센다
function countAlerts(result: MonitoringTaskResult): LevelCounts {
  const counts = emptyCounts();
  for (const row of result.rows ?? []) {
    for (const alert of Object.values(row._alerts ?? {})) {
      const level = String(alert.level).toUpperCase() as Level;
      if (level in counts) counts[level]++;
    }
  }
  return counts;
}

function hasProblem(result: MonitoringTaskResult, counts: LevelCounts): boolean {
  return !result.success || counts.CRITICAL + counts.ERROR + counts.WARN > 0;
}

function LevelBadges({ counts }: { counts: LevelCounts }): ReactElement {
  return (
    <>
      {LEVELS.filter((level) => counts[level] > 0).map((level) => (
        <span key={level} className={`issue-badge issue-badge-${level.toLowerCase()}`}>
          {level} {counts[level]}
        </span>
      ))}
    </>
  );
}

export function MonitoringResultTable({ results }: { results: MonitoringTaskResult[] }): ReactElement {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const items = useMemo(() => results.map((result, index) => ({ result, index, counts: countAlerts(result) })), [results]);
  const total = useMemo(() => {
    const counts = emptyCounts();
    for (const item of items) for (const level of LEVELS) counts[level] += item.counts[level];
    return counts;
  }, [items]);
  const failed = items.filter((item) => !item.result.success).length;
  const problemCount = items.filter((item) => hasProblem(item.result, item.counts)).length;
  const visible = problemsOnly ? items.filter((item) => hasProblem(item.result, item.counts)) : items;

  function toggle(index: number): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <>
      <div className="mr-summary">
        <div className="mr-summary-stats">
          <span>
            점검 <strong>{items.length}</strong>개
          </span>
          <span className={problemCount > 0 ? 'mr-stat-bad' : 'mr-stat-ok'}>
            {problemCount > 0 ? (
              <>
                확인 필요 <strong>{problemCount}</strong>개
              </>
            ) : (
              '모두 정상'
            )}
          </span>
          {failed > 0 && <span className="issue-badge issue-badge-error">실행 실패 {failed}</span>}
          <LevelBadges counts={total} />
        </div>
        {failed > 0 && (
          <div className="mr-failed-list">
            <span className="mr-failed-label">실행 실패한 스크립트</span>
            {items
              .filter((item) => !item.result.success)
              .map((item) => (
                <button
                  key={item.index}
                  type="button"
                  className="mr-failed-item"
                  title={item.result.error}
                  onClick={() => {
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      next.delete(item.index);
                      return next;
                    });
                    document.getElementById(`mr-task-${item.index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {item.result.task_name}
                  {errorCode(item.result.error) && <code>{errorCode(item.result.error)}</code>}
                </button>
              ))}
          </div>
        )}
        <div className="mr-summary-actions">
          <label className="mr-toggle">
            <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
            위반·실패 항목만 보기
          </label>
          <button type="button" className="btn-secondary" onClick={() => setCollapsed(new Set())}>
            모두 펼치기
          </button>
          <button type="button" className="btn-secondary" onClick={() => setCollapsed(new Set(items.map((item) => item.index)))}>
            모두 접기
          </button>
        </div>
      </div>

      {visible.length === 0 && <p className="issues-empty">위반이나 실패한 항목이 없습니다.</p>}

      {visible.map(({ result, index, counts }) => {
        const isCollapsed = collapsed.has(index);
        const problem = hasProblem(result, counts);
        return (
          <section key={`${result.task_name}-${index}`} id={`mr-task-${index}`} className={`mr-task${problem ? ' mr-task-problem' : ''}`}>
            <button type="button" className="mr-task-head" onClick={() => toggle(index)} aria-expanded={!isCollapsed}>
              <span className="mr-task-caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="mr-task-name">{result.task_name}</span>
              <span className="mr-task-meta">
                {!result.success ? (
                  <span className="issue-badge issue-badge-error">실행 실패</span>
                ) : (
                  <>
                    <span className="mr-task-rows">{result.rows?.length ?? 0}행</span>
                    <LevelBadges counts={counts} />
                  </>
                )}
              </span>
            </button>

            {!isCollapsed &&
              (!result.success ? (
                <div className="mr-task-error">
                  <div className="issue-failure-head">
                    {errorCode(result.error) && <code className="issue-error-code">{errorCode(result.error)}</code>}
                    <span>{FAILURE_LABELS[result.failureKind ?? 'ERROR'] ?? FAILURE_LABELS.ERROR}</span>
                  </div>
                  <pre className="issue-error issue-error-full">{result.error || '알 수 없는 오류'}</pre>
                </div>
              ) : !result.rows || result.rows.length === 0 ? (
                <p className="mr-task-none">조회된 행이 없습니다.</p>
              ) : (
                <div className="mr-table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        {result.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, rowIndex) => {
                        const alerts = row._alerts || {};
                        return (
                          <tr key={rowIndex}>
                            {result.columns.map((column) => {
                              const alert = alerts[column];
                              return (
                                <td
                                  key={column}
                                  className={alert ? `cell-${alert.level.toLowerCase()}` : undefined}
                                  title={alert?.message || undefined}
                                >
                                  {String(row[column] ?? '')}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
          </section>
        );
      })}
    </>
  );
}
