import type { ReactElement } from 'react';
import type { DataFilter, ObjectFilter } from '../../shared/lib/types';
import { describeFilters } from './filterHelpers';

// 실행 확인창의 필터/옵션 요약 (SQL 조건은 원문 그대로 보여준다)
export function FilterSummary({ objectFilter, dataFilter }: { objectFilter: ObjectFilter; dataFilter: DataFilter }): ReactElement | null {
  const lines = describeFilters(objectFilter, dataFilter);
  if (lines.length === 0) return null;
  return (
    <div className="dp-filter-summary">
      <strong>필터·옵션</strong>
      <ul className="dp-summary">
        {lines.map((line) => (
          <li key={line}>
            <code>{line}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
