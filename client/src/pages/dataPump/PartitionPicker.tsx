import { useState, type ReactElement } from 'react';
import type { PartitionRange } from '../../shared/lib/types';
import { formatBytes } from './helpers';

// 서버(services/dataPumpPartitionService.ts의 overlaps)와 같은 규칙: 파티션 [low, high)가 기간 [from, toExclusive)와 겹치면 고른다.
function overlaps(range: PartitionRange, from: string, toExclusive: string): boolean {
  if (!range.known) return false;
  return (range.low === null || range.low < toExclusive) && (range.high === null || range.high > from);
}

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function rangeText(range: PartitionRange): string {
  if (!range.known) return `알 수 없음 (${range.highValue})`;
  const short = (value: string) => (value.endsWith(' 00:00:00') ? value.slice(0, 10) : value);
  return `${range.low ? short(range.low) : '처음'} ~ ${range.high ? `${short(range.high)} 전` : 'MAXVALUE'}`;
}

interface Props {
  partitions: PartitionRange[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

// 날짜 기간으로 파티션을 한 번에 고르고, 표에서 하나씩 더하거나 뺄 수 있다.
// 파티션 단위라 기간 경계에 걸친 파티션은 기간 밖 날짜 데이터도 같이 들어간다.
export function PartitionPicker({ partitions, selected, onChange }: Props): ReactElement {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function selectByPeriod(): void {
    if (!from || !to || from > to) return;
    const start = `${from} 00:00:00`;
    const end = `${nextDay(to)} 00:00:00`;
    onChange(new Set(partitions.filter((range) => overlaps(range, start, end)).map((range) => range.name)));
  }

  function toggle(name: string): void {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  }

  const unknown = partitions.filter((range) => !range.known).length;
  const selectedBytes = partitions.filter((range) => selected.has(range.name)).reduce((sum, range) => sum + range.bytes, 0);

  return (
    <>
      <div className="dp-source-row">
        <label htmlFor="dp-part-from">기간</label>
        <input id="dp-part-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>~</span>
        <input id="dp-part-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button type="button" className="btn-secondary" disabled={!from || !to || from > to} onClick={selectByPeriod}>
          기간으로 고르기
        </button>
        <button type="button" className="btn-secondary" onClick={() => onChange(new Set())}>
          선택 해제
        </button>
        <span className="oc-subtle">
          {selected.size}개 선택 · 약 {formatBytes(selectedBytes)}
        </span>
      </div>
      <p className="oc-hint">
        기간과 겹치는 파티션을 고릅니다 (양쪽 날짜 포함). 파티션 단위라 기간 경계에 걸친 파티션은 기간 밖 날짜의 데이터도 같이 들어갑니다.
        {unknown > 0 && ` 범위를 날짜로 해석하지 못한 파티션 ${unknown}개는 기간 선택에서 빠지고, 표에서 직접 체크할 수 있습니다.`}
      </p>
      <div className="dp-part-list">
        <table className="table oc-items-table">
          <thead>
            <tr>
              <th></th>
              <th>파티션</th>
              <th>범위</th>
              <th>행 수(통계)</th>
              <th>크기</th>
            </tr>
          </thead>
          <tbody>
            {partitions.map((range) => (
              <tr key={range.name} className={selected.has(range.name) ? 'dp-part-selected' : undefined} onClick={() => toggle(range.name)}>
                <td>
                  <input type="checkbox" checked={selected.has(range.name)} readOnly />
                </td>
                <td className="oc-name">{range.name}</td>
                <td className={range.known ? undefined : 'oc-none'}>{rangeText(range)}</td>
                <td>{range.numRows === null ? '-' : range.numRows.toLocaleString()}</td>
                <td>{formatBytes(range.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
