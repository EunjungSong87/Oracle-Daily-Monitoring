import { useMemo, useState, type ReactElement } from 'react';

// 목록 화면 공통: 검색(모든 열 부분 일치) + 열 머리 클릭 정렬 + 건수 + CSV 내보내기.
// 행은 열 이름 → 값 객체. 화면에 보이는 값과 다르게 정렬/검색하고 싶으면 호출 쪽에서 그 값으로 행을 만들어 넘긴다.

type Row = Record<string, unknown>;
type SortDir = 'asc' | 'desc';

export interface ListView<T extends Row> {
  query: string;
  setQuery: (value: string) => void;
  sortKey: string | null;
  sortDir: SortDir;
  toggleSort: (key: string) => void;
  rows: T[];
  total: number;
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

function compareValues(a: unknown, b: unknown): number {
  const emptyA = a == null || a === '';
  const emptyB = b == null || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1; // 빈 값은 항상 뒤로
  const numA = typeof a === 'number' ? a : Number(a);
  const numB = typeof b === 'number' ? b : Number(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
  return collator.compare(String(a), String(b));
}

export function useListView<T extends Row>(rows: T[] | null | undefined, columns: string[]): ListView<T> {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (rows ?? []).filter((row) => !q || columns.some((column) => String(row[column] ?? '').toLowerCase().includes(q)));
    if (!sortKey) return filtered;
    const sign = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => sign * compareValues(a[sortKey], b[sortKey]));
  }, [rows, columns, query, sortKey, sortDir]);

  // 같은 열을 누르면 오름차순 → 내림차순 → 정렬 해제
  function toggleSort(key: string): void {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortKey(null);
    }
  }

  return { query, setQuery, sortKey, sortDir, toggleSort, rows: visible, total: rows?.length ?? 0 };
}

export function SortableTh<T extends Row>({ column, label, view }: { column: string; label?: string; view: ListView<T> }): ReactElement {
  const active = view.sortKey === column;
  const arrow = active ? (view.sortDir === 'asc' ? '▲' : '▼') : '↕';
  return (
    <th
      className={`th-sortable${active ? ' th-sorted' : ''}`}
      onClick={() => view.toggleSort(column)}
      aria-sort={active ? (view.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      title="눌러서 정렬"
    >
      {label ?? column}
      <span className="th-sort-arrow">{arrow}</span>
    </th>
  );
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Excel에서 한글이 깨지지 않도록 UTF-8 BOM을 붙인다.
export function downloadCsv(filename: string, columns: string[], rows: Row[]): void {
  const lines = [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

interface ToolbarProps<T extends Row> {
  view: ListView<T>;
  placeholder?: string;
  // CSV 파일 이름 앞부분 (날짜가 붙는다). 없으면 내보내기 버튼을 숨긴다.
  exportName?: string;
  exportColumns?: string[];
}

export function ListToolbar<T extends Row>({ view, placeholder = '검색', exportName, exportColumns }: ToolbarProps<T>): ReactElement {
  const filtered = view.query.trim() !== '';
  return (
    <div className="list-toolbar">
      <input
        type="search"
        className="list-search"
        placeholder={placeholder}
        value={view.query}
        onChange={(e) => view.setQuery(e.target.value)}
        aria-label="목록 검색"
      />
      <span className="list-count">
        {filtered ? (
          <>
            <strong>{view.rows.length}</strong>건 / 전체 {view.total}건
          </>
        ) : (
          <>
            전체 <strong>{view.total}</strong>건
          </>
        )}
      </span>
      {exportName && exportColumns && (
        <button
          type="button"
          className="btn-secondary list-export"
          disabled={view.rows.length === 0}
          onClick={() => downloadCsv(`${exportName}_${today()}.csv`, exportColumns, view.rows)}
        >
          CSV 내보내기
        </button>
      )}
    </div>
  );
}
