import type { ReactElement } from 'react';
import type { DataPumpLogtime } from '../../shared/lib/types';

// METRICS / LOGTIME (expdp·impdp 12c 이상). 12c 미만 DB면 끈 채로 보여 준다 (서버도 막음).
export function LogOptions({
  metrics,
  logtime,
  onMetrics,
  onLogtime,
  versionNumber,
}: {
  metrics: boolean;
  logtime: DataPumpLogtime;
  onMetrics: (value: boolean) => void;
  onLogtime: (value: DataPumpLogtime) => void;
  versionNumber: number;
}): ReactElement {
  const supported = versionNumber >= 12.1;
  return (
    <>
      <label className="oc-check" title={supported ? '로그에 오브젝트 유형별 처리 수와 걸린 시간, 테이블별 수행 시간을 남깁니다.' : '12c 이상에서만'}>
        <input type="checkbox" checked={metrics && supported} disabled={!supported} onChange={(e) => onMetrics(e.target.checked)} />
        작업 통계를 로그에 (METRICS=YES)
      </label>
      <label className="oc-check" title={supported ? '로그/상태 메시지 줄마다 시각을 붙입니다.' : '12c 이상에서만'}>
        시각 표시 (LOGTIME){' '}
        <select aria-label="LOGTIME" value={supported ? logtime : 'NONE'} disabled={!supported} onChange={(e) => onLogtime(e.target.value as DataPumpLogtime)}>
          <option value="NONE">NONE (안 붙임)</option>
          <option value="ALL">ALL (로그·화면 모두)</option>
          <option value="LOGFILE">LOGFILE (로그 파일만)</option>
          <option value="STATUS">STATUS (화면 메시지만)</option>
        </select>
      </label>
    </>
  );
}
