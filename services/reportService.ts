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

function renderTaskSection(task: TaskResult): string {
  if (!task.success) {
    return `<h3>${escapeHtml(task.task_name)}</h3><p class="error">실행 실패: ${escapeHtml(task.error)}</p>`;
  }
  if (!task.rows || task.rows.length === 0) {
    return `<h3>${escapeHtml(task.task_name)}</h3><p>No results found.</p>`;
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

  return `<h3>${escapeHtml(task.task_name)}</h3><table class="table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
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
  .error { color: #dc2626; }
</style>
</head>
<body>
<h1>${escapeHtml(dbname)} 일일점검 결과</h1>
<p>${escapeHtml(generatedAt.toLocaleString('ko-KR'))}</p>
${sections}
</body>
</html>`;
}

export { renderReportHtml };
