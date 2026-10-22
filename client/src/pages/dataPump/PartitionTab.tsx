import type { ReactElement } from 'react';
import type { DataPumpMeta, DbmsRow } from '../../shared/lib/types';
import { PartitionImport } from './PartitionImport';

interface Props {
  dbmsId: string;
  meta: DataPumpMeta;
  sqlAllowed: boolean;
  dbmsRows: DbmsRow[];
}

// Range 파티션 덤프 가져오기. Export는 Export 탭의 "Range 파티션 (기간)" 대상으로 하고, 거기서 남긴 매니페스트를 여기서 읽는다.
export function PartitionTab({ dbmsId, meta, sqlAllowed, dbmsRows }: Props): ReactElement {
  return (
    <>
      <div className="rt-panel">
        <p className="oc-hint" style={{ margin: 0 }}>
          Export 탭에서 파티션 단위로 내보낸 덤프를 가져옵니다. 파티션 범위는 Export 이력(메타 DB)에서 읽고, 덤프만 다른 망으로 넘긴 경우는 매니페스트(.json) 파일에서 읽습니다. 대상 DB의 파티션 이름이 달라도
          (INTERVAL의 SYS_P…) 같은 기간의 파티션에 들어갑니다. "비우고 넣기"를 고르면 같은 범위의 대상 파티션을 먼저 비웁니다.
        </p>
      </div>
      <PartitionImport dbmsId={dbmsId} meta={meta} sqlAllowed={sqlAllowed} dbmsRows={dbmsRows} />
    </>
  );
}
