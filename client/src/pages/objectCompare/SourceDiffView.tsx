import { useMemo, useState, type ReactElement } from 'react';
import type { SourceDiffLine } from '../../shared/lib/types';

// 바뀐 줄 앞뒤로 보여줄 동일 줄 수. 그보다 멀리 떨어진 동일 구간은 "… N줄 동일 …" 한 줄로 접는다.
const CONTEXT_LINES = 3;

type Row = { kind: 'line'; line: SourceDiffLine } | { kind: 'gap'; count: number };

function collapse(lines: SourceDiffLine[]): Row[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.op === 'same') return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(lines.length - 1, index + CONTEXT_LINES);
    for (let i = from; i <= to; i++) keep[i] = true;
  });

  const rows: Row[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (hidden > 0) rows.push({ kind: 'gap', count: hidden });
      hidden = 0;
      rows.push({ kind: 'line', line });
    } else {
      hidden++;
    }
  });
  if (hidden > 0) rows.push({ kind: 'gap', count: hidden });
  return rows;
}

interface Props {
  lines: SourceDiffLine[];
  sourceLabel: string;
  targetLabel: string;
}

// 소스 줄 단위 비교 결과(unified diff 형태). 빨강(-)은 기준에만 있는 줄, 초록(+)은 대상에만 있는 줄.
export function SourceDiffView({ lines, sourceLabel, targetLabel }: Props): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo<Row[]>(
    () => (showAll ? lines.map((line) => ({ kind: 'line', line })) : collapse(lines)),
    [lines, showAll]
  );
  const removed = lines.filter((line) => line.op === 'del').length;
  const added = lines.filter((line) => line.op === 'add').length;

  if (removed === 0 && added === 0) {
    return <p className="oc-detail-note">줄 끝 공백을 제외하면 소스가 같습니다.</p>;
  }

  return (
    <div>
      <div className="oc-diff-toolbar">
        <span>
          <span className="oc-diff-legend oc-diff-del">- {sourceLabel} (기준)에만 있는 줄 {removed}</span>
          <span className="oc-diff-legend oc-diff-add">+ {targetLabel} (대상)에만 있는 줄 {added}</span>
        </span>
        <button type="button" className="btn-secondary" onClick={() => setShowAll((current) => !current)}>
          {showAll ? '바뀐 부분만 보기' : '전체 소스 보기'}
        </button>
      </div>
      <div className="oc-diff">
        <table>
          <tbody>
            {rows.map((row, index) =>
              row.kind === 'gap' ? (
                <tr key={index} className="oc-diff-gap">
                  <td colSpan={4}>… {row.count}줄 동일 …</td>
                </tr>
              ) : (
                <tr key={index} className={row.line.op === 'del' ? 'oc-diff-del' : row.line.op === 'add' ? 'oc-diff-add' : undefined}>
                  <td className="oc-diff-no">{row.line.sourceLine ?? ''}</td>
                  <td className="oc-diff-no">{row.line.targetLine ?? ''}</td>
                  <td className="oc-diff-mark">{row.line.op === 'del' ? '-' : row.line.op === 'add' ? '+' : ''}</td>
                  <td className="oc-diff-text">{row.line.text}</td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
