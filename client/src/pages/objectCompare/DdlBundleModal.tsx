import { useState, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { getSourceDiff } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { CompareItem, CompareResponse, SourceDiffLine } from '../../shared/lib/types';
import { bundleDdl, codeDdl } from './ddl';

interface Props {
  open: boolean;
  onClose: () => void;
  items: CompareItem[]; // 지금 목록에 보이는 항목 (이 중 "다름"만 모은다)
  result: CompareResponse;
  diffCache: Map<string, SourceDiffLine[]>; // ItemDetail과 같은 캐시 (키: 기준 스키마 \0 종류 \0 이름)
}

const cacheKeyOf = (item: CompareItem, result: CompareResponse) =>
  `${(item.sourceSchema !== undefined ? item.sourceSchema : result.source.schema) ?? ''}\u0000${item.type}\u0000${item.name}`;

// "다름" 항목들의 DDL을 한 스크립트로. 테이블/인덱스/시퀀스/시노님은 비교 결과에 이미 있고, 뷰/PL/SQL은 소스 diff가 있어야 해서
// 펼쳐 본 것만 바로 들어가고 나머지는 버튼을 눌러야 하나씩 불러온다 (양쪽 DB 조회라 자동으로 하지 않음).
export function DdlBundleModal({ open, onClose, items, result, diffCache }: Props): ReactElement | null {
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [, setVersion] = useState(0); // 캐시가 채워지면 다시 그리기

  const diffItems = items.filter((item) => item.result === 'DIFF');
  const entries = diffItems.map((item) => {
    if (item.ddl) return { item, ddl: item.ddl };
    const lines = item.hasSourceDiff ? diffCache.get(cacheKeyOf(item, result)) : undefined;
    return { item, ddl: lines
        ? codeDdl(
            item,
            lines,
            item.targetSchema !== undefined ? item.targetSchema : result.target.schema,
            item.sourceSchema !== undefined ? item.sourceSchema : result.source.schema
          )
        : null };
  });
  const pending = entries.filter((entry) => entry.ddl === null).map((entry) => entry.item);
  const ready = entries.filter((entry): entry is { item: CompareItem; ddl: string[] } => entry.ddl !== null);
  const text =
    (pending.length > 0 ? `-- 소스를 아직 불러오지 않은 뷰/PL/SQL ${pending.length}개는 빠짐: ${pending.map((item) => item.name).join(', ')}\n\n` : '') +
    bundleDdl(ready);

  async function loadPending(): Promise<void> {
    setLoading({ done: 0, total: pending.length });
    try {
      // 한 번에 하나씩 (대상 DB에 조회를 몰지 않게)
      for (const [index, item] of pending.entries()) {
        const sourceSchema = item.sourceSchema !== undefined ? item.sourceSchema : result.source.schema;
        const targetSchema = item.targetSchema !== undefined ? item.targetSchema : result.target.schema;
        const lines = await getSourceDiff(
          { dbmsid: result.source.dbmsid, schema: sourceSchema ?? '' },
          { dbmsid: result.target.dbmsid, schema: targetSchema ?? '' },
          item.type,
          item.name
        );
        diffCache.set(cacheKeyOf(item, result), lines);
        setLoading({ done: index + 1, total: pending.length });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '소스를 불러오지 못했습니다.', 'error');
    } finally {
      setLoading(null);
      setVersion((version) => version + 1);
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast('DDL을 복사했습니다.');
    } catch {
      showToast('클립보드에 복사하지 못했습니다.', 'error');
    }
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `compare_ddl_${result.target.dbname}.sql`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!open) return null;
  return (
    <Modal open onClose={onClose} title={`차이 DDL — 대상 ${result.target.dbname}을(를) 기준에 맞춤`} wide="xl">
      <div className="modal-body">
        <p className="oc-hint">
          지금 목록에 보이는 "다름" {diffItems.length}개의 DDL입니다 (필터를 바꾸면 범위도 바뀜). 앱은 실행하지 않으니 확인 후 직접 실행하세요. -- 로 시작하는
          줄은 데이터가 지워지거나 오래 걸려서 주석으로 둔 것입니다.
        </p>
        <div className="oc-actions dp-buttons">
          {pending.length > 0 && (
            <button type="button" className="btn-secondary" disabled={loading !== null} onClick={loadPending}>
              {loading ? `소스 불러오는 중 ${loading.done}/${loading.total}` : `뷰/PL/SQL ${pending.length}개 소스도 불러와 넣기 (양쪽 DB 조회)`}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={copy}>
            복사
          </button>
          <button type="button" onClick={download}>
            .sql 다운로드
          </button>
        </div>
        <pre className="rt-sql-text oc-ddl-bundle">{text}</pre>
      </div>
    </Modal>
  );
}
