import type { ReactElement } from 'react';
import type { DataPumpMeta } from '../../shared/lib/types';
import { PartitionImport } from './PartitionImport';

interface Props {
  dbmsId: string;
  meta: DataPumpMeta;
}

// Range 파티션 덤프 가져오기. Export는 Export 탭의 "Range 파티션 (기간)" 대상으로 하고, 거기서 남긴 매니페스트를 여기서 읽는다.
export function PartitionTab({ dbmsId, meta }: Props): ReactElement {
  return (
    <>
      <div className="rt-panel">
        <p className="oc-hint" style={{ margin: 0 }}>
          Export 탭에서 "Range 파티션 (기간)"으로 내보낸 덤프를 가져옵니다. 덤프 옆에 남긴 매니페스트(.json)로 파티션 범위를 맞추므로, 대상 DB의 파티션 이름이 달라도
          (INTERVAL의 SYS_P…) 같은 기간의 파티션에 들어갑니다. "비우고 넣기"를 고르면 같은 범위의 대상 파티션을 먼저 비웁니다.
        </p>
      </div>
      <PartitionImport dbmsId={dbmsId} meta={meta} />
    </>
  );
}
