import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

interface Props {
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  placeholder?: string;
}

// 너무 많은 항목을 한 번에 그리면 느려지므로 펼친 목록은 이만큼까지만 보여주고, 나머지는 검색으로 좁히게 한다.
const MAX_VISIBLE = 200;

// 검색 가능한 다중 선택 드롭다운. 스키마가 수백 개여도 입력창에서 걸러 고를 수 있게 한다.
export function SchemaMultiSelect({ options, selected, onChange, placeholder }: Props): ReactElement {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    return keyword ? options.filter((option) => option.includes(keyword)) : options;
  }, [options, query]);
  const visible = matches.slice(0, MAX_VISIBLE);

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!open) return;
    function handleDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  function toggle(option: string): void {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    onChange(next);
    inputRef.current?.focus();
  }

  function selectAllMatches(): void {
    onChange(new Set([...selected, ...matches]));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => Math.min(current + 1, visible.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visible[highlight];
      if (open && option) toggle(option);
      else setOpen(true);
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Backspace' && query === '' && selected.size > 0) {
      // 입력이 비었을 때 Backspace = 마지막으로 고른 스키마 빼기
      const last = Array.from(selected).pop()!;
      const next = new Set(selected);
      next.delete(last);
      onChange(next);
    }
  }

  return (
    <div className="dp-multiselect" ref={rootRef}>
      <div className="dp-multiselect-box" onClick={() => inputRef.current?.focus()}>
        {Array.from(selected).map((option) => (
          <span key={option} className="dp-chip dp-chip-selected">
            {option}
            <button type="button" aria-label={`${option} 빼기`} onClick={() => toggle(option)}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={selected.size === 0 ? (placeholder ?? '스키마 검색') : ''}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          aria-label="스키마 검색"
          aria-expanded={open}
          role="combobox"
        />
      </div>
      {open && (
        <div className="dp-multiselect-menu" role="listbox">
          <div className="dp-multiselect-toolbar">
            <span>
              {matches.length}개{query ? ` 일치` : ''} · {selected.size}개 선택
            </span>
            <span>
              {matches.length > 0 && (
                <button type="button" className="oc-link" onClick={selectAllMatches}>
                  {query ? '일치 항목 모두 선택' : '모두 선택'}
                </button>
              )}
              {selected.size > 0 && (
                <button type="button" className="oc-link" onClick={() => onChange(new Set())}>
                  선택 해제
                </button>
              )}
            </span>
          </div>
          {visible.length === 0 && <div className="dp-multiselect-empty">일치하는 스키마가 없습니다.</div>}
          {visible.map((option, index) => (
            <div
              key={option}
              role="option"
              aria-selected={selected.has(option)}
              className={`dp-multiselect-option${index === highlight ? ' dp-multiselect-active' : ''}`}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(option)}
            >
              <input type="checkbox" readOnly checked={selected.has(option)} tabIndex={-1} />
              {option}
            </div>
          ))}
          {matches.length > MAX_VISIBLE && (
            <div className="dp-multiselect-empty">… {matches.length - MAX_VISIBLE}개 더 있음 — 검색어로 좁혀주세요</div>
          )}
        </div>
      )}
    </div>
  );
}
