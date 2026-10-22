import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactElement } from 'react';

interface Props {
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  placeholder?: string;
  // strict: 붙여넣은 이름을 SQL 규칙대로만 맞춘다(따옴표 없으면 대문자, "QTest"는 그대로). 목록에 없는 이름은 버리지 않고
  // unknown으로 들고 있다가 화면이 그걸 보고 진행을 막는다 (Data Pump). 대소문자만 다른 후보는 보여 주되 자동으로 바꾸지 않는다.
  strict?: boolean;
  unknown?: string[];
  onUnknownChange?: (names: string[]) => void;
}

// 너무 많은 항목을 한 번에 그리면 느려지므로 펼친 목록은 이만큼까지만 보여주고, 나머지는 검색으로 좁히게 한다.
const MAX_VISIBLE = 200;

// 붙여넣은 글을 이름 목록으로 나눈다. 쉼표·세미콜론·공백·줄바꿈 어느 것으로 구분해도 되고, 따옴표는 떼어낸다.
function splitPastedNames(text: string, keepDoubleQuotes = false): string[] {
  return text
    .split(/[,;\s]+/)
    .map((token) => (keepDoubleQuotes ? token.replace(/^'+|'+$/g, '') : token.replace(/^["']+|["']+$/g, '')))
    .filter((token) => token !== '');
}

// SQL 표기 → 정확한 이름 (따옴표 없으면 대문자)
function exactOf(token: string): string {
  const quoted = token.match(/^"(.*)"$/);
  return quoted ? quoted[1] : token.toUpperCase();
}

// 검색 가능한 다중 선택 드롭다운. 스키마가 수백 개여도 입력창에서 걸러 고를 수 있게 한다.
export function SchemaMultiSelect({ options, selected, onChange, placeholder, strict = false, unknown = [], onUnknownChange }: Props): ReactElement {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pasteNote, setPasteNote] = useState<string | null>(null); // 붙여넣은 이름 중 목록에 없던 것 안내
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    return keyword ? options.filter((option) => option.toUpperCase().includes(keyword)) : options;
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

  // 쉼표 등으로 구분된 여러 이름을 붙여넣으면 검색어로 넣지 않고 목록에 있는 것을 한 번에 고른다.
  // 이름 하나만 붙여넣으면 평소처럼 검색어로 들어간다.
  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const names = splitPastedNames(event.clipboardData.getData('text'), strict);
    if (names.length < 2) return;
    event.preventDefault();
    if (strict) {
      const next = new Set(selected);
      const notFound = [...unknown];
      for (const token of names) {
        const exact = exactOf(token);
        if (options.includes(exact)) next.add(exact);
        else if (!notFound.includes(token)) notFound.push(token);
      }
      onChange(next);
      setQuery('');
      onUnknownChange?.(notFound);
      return;
    }
    const byUpper = new Map(options.map((option) => [option.toUpperCase(), option]));
    const next = new Set(selected);
    const missing: string[] = [];
    for (const name of names) {
      const option = options.includes(name) ? name : byUpper.get(name.toUpperCase());
      if (option) next.add(option);
      else if (!missing.includes(name)) missing.push(name);
    }
    onChange(next);
    setQuery('');
    setPasteNote(missing.length > 0 ? `목록에 없어 빠진 이름 ${missing.length}개: ${missing.join(', ')}` : null);
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
            setPasteNote(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          title="쉼표로 구분한 이름 목록을 붙여넣으면 한 번에 고릅니다"
          aria-label="스키마 검색"
          aria-expanded={open}
          role="combobox"
        />
      </div>
      {pasteNote && <div className="dp-multiselect-note">{pasteNote}</div>}
      {strict && unknown.length > 0 && (
        <div className="pc-warning dp-unknown-names">
          <strong>목록에 없는 이름 {unknown.length}개</strong> — 지우거나 고칠 때까지 진행할 수 없습니다.
          <div className="dp-table-chips">
            {unknown.map((token) => {
              const exact = exactOf(token);
              const candidates = options.filter((option) => option !== exact && option.toUpperCase() === exact.toUpperCase());
              return (
                <span key={token} className="dp-chip dp-chip-missing">
                  {token}
                  {candidates.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      className="oc-link"
                      title="이 이름으로 고르기"
                      onClick={() => {
                        onChange(new Set([...selected, candidate]));
                        onUnknownChange?.(unknown.filter((item) => item !== token));
                      }}
                    >
                      혹시 &quot;{candidate}&quot;?
                    </button>
                  ))}
                  <button type="button" aria-label={`${token} 지우기`} onClick={() => onUnknownChange?.(unknown.filter((item) => item !== token))}>
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}
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
