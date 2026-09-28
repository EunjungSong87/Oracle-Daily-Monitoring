import type { ReactElement } from 'react';
import type { DbmsRow } from '../../shared/lib/types';

interface Props {
  columns: string[];
  rows: DbmsRow[];
  checkedIds: Set<string>;
  onToggleRow: (id: string) => void;
}

export function DbmsListTable({ columns, rows, checkedIds, onToggleRow }: Props): ReactElement {
  return (
    <table id="dbmses-list" className="table">
      <thead>
        <tr>
          <th>CHECK</th>
          {columns.map((column) => (
            <th key={column}>{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const id = String(row.ID);
          return (
            <tr key={id}>
              <td>
                <input
                  type="checkbox"
                  className="row-check"
                  checked={checkedIds.has(id)}
                  onChange={() => onToggleRow(id)}
                />
              </td>
              {columns.map((column) => (
                <td key={column}>{String(row[column] ?? '')}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
