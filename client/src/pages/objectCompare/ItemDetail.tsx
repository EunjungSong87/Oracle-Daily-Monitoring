import { useEffect, useState, type ReactElement } from 'react';
import { getSourceDiff } from '../../shared/lib/api';
import type { CompareItem, CompareResponse, SourceDiffLine } from '../../shared/lib/types';
import { SourceDiffView } from './SourceDiffView';

interface Props {
  item: CompareItem;
  result: CompareResponse;
  // 같은 오브젝트를 다시 펼칠 때 재조회하지 않도록 부모가 들고 있는 캐시.
  diffCache: Map<string, SourceDiffLine[]>;
}

function sideLabel(side: CompareResponse['source']): string {
  return `${side.dbname}.${side.schema}`;
}

// 목록에서 한 줄을 펼쳤을 때 보이는 상세: 속성/컬럼 차이 표, 그리고 소스가 다른 오브젝트는 줄 단위 diff.
export function ItemDetail({ item, result, diffCache }: Props): ReactElement {
  const cacheKey = `${item.type}\u0000${item.name}`;
  const [lines, setLines] = useState<SourceDiffLine[] | null>(diffCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item.hasSourceDiff || diffCache.has(cacheKey)) return;
    let cancelled = false;
    getSourceDiff(result.source, result.target, item.type, item.name)
      .then((fetched) => {
        diffCache.set(cacheKey, fetched);
        if (!cancelled) setLines(fetched);
      })
      .catch((err) => {
        console.error('Error loading source diff:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : '소스 비교 조회 실패');
      });
    return () => {
      cancelled = true;
    };
  }, [item, result, diffCache, cacheKey]);

  const sourceLabel = sideLabel(result.source);
  const targetLabel = sideLabel(result.target);

  return (
    <div className="oc-detail">
      {item.result === 'ONLY_SOURCE' && (
        <p className="oc-detail-note">
          <strong>{sourceLabel}</strong> (기준)에만 있고 <strong>{targetLabel}</strong> (대상)에는 없는 오브젝트입니다.
        </p>
      )}
      {item.result === 'ONLY_TARGET' && (
        <p className="oc-detail-note">
          <strong>{targetLabel}</strong> (대상)에만 있고 <strong>{sourceLabel}</strong> (기준)에는 없는 오브젝트입니다.
        </p>
      )}
      {item.result === 'SAME' && item.diffs.length === 0 && <p className="oc-detail-note">양쪽 정의가 같습니다.</p>}

      {item.diffs.length > 0 && (
        <table className="table oc-detail-table">
          <thead>
            <tr>
              <th>항목</th>
              <th>속성</th>
              <th>기준 — {sourceLabel}</th>
              <th>대상 — {targetLabel}</th>
            </tr>
          </thead>
          <tbody>
            {item.diffs.map((diff, index) => (
              <tr key={index} className={diff.info ? 'oc-info-row' : undefined}>
                <td>{diff.item}</td>
                <td>
                  {diff.attribute}
                  {diff.info && <span className="oc-info-tag">참고</span>}
                </td>
                <td className="oc-value">{diff.source ?? <span className="oc-none">(없음)</span>}</td>
                <td className="oc-value">{diff.target ?? <span className="oc-none">(없음)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {item.hasSourceDiff && (
        <>
          {error && <p className="oc-detail-note">소스 비교를 불러오지 못했습니다: {error}</p>}
          {!error && lines === null && <p className="oc-detail-note">소스 비교 중...</p>}
          {lines && <SourceDiffView lines={lines} sourceLabel={sourceLabel} targetLabel={targetLabel} />}
        </>
      )}
    </div>
  );
}
