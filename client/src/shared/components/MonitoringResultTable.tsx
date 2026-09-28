import type { ReactElement } from 'react';
import type { MonitoringTaskResult } from '../lib/types';

// public/common.js의 renderMonitoringResults() 포팅. task별로 제목 + (성공 시) 결과 테이블을
// 그리고, 임계치 위반 셀은 _alerts[column].level 기준으로 cell-{level} 클래스를 붙인다.
export function MonitoringResultTable({ results }: { results: MonitoringTaskResult[] }): ReactElement {
  return (
    <>
      {results.map((result, index) => (
        <div key={`${result.task_name}-${index}`}>
          <h3>{result.task_name}</h3>

          {!result.success ? (
            <p className="error">실행 실패: {result.error || ''}</p>
          ) : !result.rows || result.rows.length === 0 ? (
            <p>No results found.</p>
          ) : (
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
          )}
        </div>
      ))}
    </>
  );
}
