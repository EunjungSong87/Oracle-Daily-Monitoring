// 예약 실행 결과를 서버 디스크에 저장할 독립 실행형 HTML 리포트로 렌더링합니다.
// dailyMonitoring.html 화면의 결과 표시 방식(컬럼/행 + _alerts 하이라이트)을 그대로 흉내냅니다.

interface TaskResult {
  task_id: number | string;
  task_name: string;
  columns: string[];
  rows: Record<string, any>[];
  success: boolean;
  error?: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderTaskSection(task: TaskResult, index: number): string {
  const heading = `<h3 id="task-${index}">${escapeHtml(task.task_name)}</h3>`;
  if (!task.success) {
    return `${heading}<p class="error">실행 실패: ${escapeHtml(task.error)}</p>`;
  }
  if (!task.rows || task.rows.length === 0) {
    return `${heading}<p>No results found.</p>`;
  }

  const headerHtml = task.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const rowsHtml = task.rows
    .map((row) => {
      const alerts = row._alerts || {};
      const cells = task.columns
        .map((c) => {
          const alert = alerts[c];
          const attrs = alert
            ? ` class="cell-${escapeHtml(String(alert.level).toLowerCase())}" title="${escapeHtml(alert.message || '')}"`
            : '';
          return `<td${attrs}>${escapeHtml(row[c])}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `${heading}<table class="table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

// 리포트 맨 위 요약: 레벨별 위반 셀 수 + 실행에 실패한 스크립트(이름 + 에러 첫 줄, 본문으로 링크)
function renderSummary(results: TaskResult[]): string {
  const counts: Record<string, number> = {};
  for (const task of results) {
    for (const row of task.rows ?? []) {
      for (const alert of Object.values(row._alerts ?? {}) as { level?: string }[]) {
        const level = String(alert.level ?? '').toUpperCase();
        counts[level] = (counts[level] ?? 0) + 1;
      }
    }
  }
  const pills = ['CRITICAL', 'ERROR', 'WARN']
    .filter((level) => counts[level])
    .map((level) => `<span class="pill pill-${level.toLowerCase()}">${level} ${counts[level]}</span>`);
  const failed = results.map((task, index) => ({ task, index })).filter(({ task }) => !task.success);
  const items = failed
    .map(({ task, index }) => `<li><a href="#task-${index}">${escapeHtml(task.task_name)}</a> — ${escapeHtml(String(task.error ?? '').split('\n')[0])}</li>`)
    .join('');
  const failedHtml = failed.length > 0 ? `<div class="summary-fail"><strong>실행 실패한 스크립트 ${failed.length}개</strong><ul>${items}</ul></div>` : '';
  return `<div class="summary">점검 ${results.length}개 · ${pills.length > 0 ? pills.join(' ') : '임계치 위반 없음'}</div>${failedHtml}`;
}

function renderReportHtml(dbname: string, results: TaskResult[], generatedAt: Date): string {
  const sections = results.map(renderTaskSection).join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(dbname)} 일일점검 결과</title>
<style>
  body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 24px; color: #111827; }
  h1 { font-size: 1.4em; }
  h3 { margin-top: 28px; }
  table.table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
  table.table th, table.table td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; font-size: 0.9em; }
  table.table th { background-color: #f3f4f6; }
  .cell-warn { background-color: #fef3c7; }
  .cell-error { background-color: #fecaca; }
  .cell-critical { background-color: #dc2626; color: #ffffff; font-weight: 700; }
  .error { color: #dc2626; }
  .summary { margin: 12px 0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 600; }
  .pill-critical { background-color: #dc2626; color: #ffffff; }
  .pill-error { background-color: #fecaca; color: #991b1b; }
  .pill-warn { background-color: #fef3c7; color: #92400e; }
  .summary-fail { margin: 12px 0 20px; padding: 10px 14px; border-left: 4px solid #dc2626; background-color: #fef2f2; }
  .summary-fail ul { margin: 6px 0 0; padding-left: 20px; }
  .summary-fail a { color: #991b1b; font-weight: 600; }
</style>
</head>
<body>
<h1>${escapeHtml(dbname)} 일일점검 결과</h1>
<p>${escapeHtml(generatedAt.toLocaleString('ko-KR'))}</p>
${renderSummary(results)}
${sections}
</body>
</html>`;
}

export { renderReportHtml };
