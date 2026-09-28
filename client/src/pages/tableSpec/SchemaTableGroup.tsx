import type { ReactElement } from 'react';

interface Props {
  owner: string;
  tables: string[] | 'loading' | 'error';
  checked: Set<string>;
  onToggleTable: (owner: string, table: string) => void;
  onToggleAll: (owner: string, checked: boolean) => void;
}

// public/tableSpec.html의 buildSchemaTableGroup() 포팅 — 스키마별 "테이블 선택" 박스 하나.
export function SchemaTableGroup({ owner, tables, checked, onToggleTable, onToggleAll }: Props): ReactElement {
  return (
    <div className="schema-table-group">
      <div className="schema-table-group-header">
        <strong>{owner}</strong>
        <button type="button" className="btn-secondary" onClick={() => onToggleAll(owner, true)}>
          전체 선택
        </button>
        <button type="button" className="btn-secondary" onClick={() => onToggleAll(owner, false)}>
          전체 해제
        </button>
      </div>
      <div className="checkbox-panel">
        {tables === 'loading' && '불러오는 중...'}
        {tables === 'error' && '조회 실패'}
        {Array.isArray(tables) && tables.length === 0 && '테이블이 없습니다.'}
        {Array.isArray(tables) &&
          tables.map((table) => (
            <label key={table} className="checkbox-row">
              <input
                type="checkbox"
                style={{ marginRight: 8 }}
                checked={checked.has(table)}
                onChange={() => onToggleTable(owner, table)}
              />
              {table}
            </label>
          ))}
      </div>
    </div>
  );
}
