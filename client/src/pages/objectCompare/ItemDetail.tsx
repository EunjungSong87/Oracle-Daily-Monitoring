import { useEffect, useState, type ReactElement } from 'react';
import { getSourceDiff } from '../../shared/lib/api';
import type { CompareItem, CompareResponse, SourceDiffLine } from '../../shared/lib/types';
import { SourceDiffView } from './SourceDiffView';
import { codeDdl } from './ddl';
import { showToast } from '../../shared/lib/toastStore';

interface Props {
  item: CompareItem;
  result: CompareResponse;
  // 같은 오브젝트를 다시 펼칠 때 재조회하지 않도록 부모가 들고 있는 캐시.
  diffCache: Map<string, SourceDiffLine[]>;
}

// 항목의 스키마(여러 스키마 비교면 그 짝의 스키마)를 붙인 이름. TABLESPACE·계정·권한 비교는 스키마가 없어 DB 이름만.
function sideLabel(dbname: string, schema: string | null | undefined): string {
  return schema ? `${dbname}.${schema}` : dbname;
}

// 목록에서 한 줄을 펼쳤을 때 보이는 상세: 속성/컬럼 차이 표, 그리고 소스가 다른 오브젝트는 줄 단위 diff.
export function ItemDetail({ item, result, diffCache }: Props): ReactElement {
  // 항목에 스키마가 있으면 그 짝, 없으면(예전 응답) 응답의 스키마
  const sourceSchema = item.sourceSchema !== undefined ? item.sourceSchema : result.source.schema;
  const targetSchema = item.targetSchema !== undefined ? item.targetSchema : result.target.schema;
  const cacheKey = `${sourceSchema ?? ''}\u0000${item.type}\u0000${item.name}`;
  const [lines, setLines] = useState<SourceDiffLine[] | null>(diffCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item.hasSourceDiff || diffCache.has(cacheKey)) return;
    let cancelled = false;
    getSourceDiff(
      { dbmsid: result.source.dbmsid, schema: sourceSchema ?? '' },
      { dbmsid: result.target.dbmsid, schema: targetSchema ?? '' },
      item.type,
      item.name
    )
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
  }, [item, result, diffCache, cacheKey, sourceSchema, targetSchema]);

  const sourceLabel = sideLabel(result.source.dbname, sourceSchema);
  const targetLabel = sideLabel(result.target.dbname, targetSchema);

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

      {item.result === 'DIFF' && (
        <DdlBlock ddl={item.ddl ?? (item.hasSourceDiff && lines ? codeDdl(item, lines, targetSchema, sourceSchema) : null)} targetLabel={targetLabel} />
      )}
    </div>
  );
}

// 대상을 기준과 같게 맞추는 DDL. 실행은 직접 (앱이 대상 DB에 실행하지 않음).
function DdlBlock({ ddl, targetLabel }: { ddl: string[] | null; targetLabel: string }): ReactElement | null {
  if (ddl === null) return null;
  const text = ddl.join('\n');
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast('DDL을 복사했습니다.');
    } catch {
      showToast('클립보드에 복사하지 못했습니다.', 'error');
    }
  }
  return (
    <div className="oc-ddl">
      <div className="oc-ddl-header">
        <span className="dp-label">
          대상({targetLabel})을 기준과 같게 맞추는 DDL <span className="oc-subtle">— 확인 후 직접 실행, -- 줄은 위험해서 주석으로 둔 것</span>
        </span>
        {ddl.length > 0 && (
          <button type="button" className="btn-secondary" onClick={copy}>
            복사
          </button>
        )}
      </div>
      {ddl.length > 0 ? <pre className="rt-sql-text">{text}</pre> : <p className="oc-detail-note">ALTER로 맞출 수 있는 차이가 없습니다.</p>}
    </div>
  );
}
