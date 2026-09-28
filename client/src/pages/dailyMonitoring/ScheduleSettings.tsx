import { useEffect, useState, type ReactElement } from 'react';
import { getScheduleConfig, saveScheduleConfig } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';

interface Props {
  checkedIds: Set<string>;
}

// public/dailyMonitoring.html의 #schedule-settings 블록 + loadScheduleConfig/saveScheduleSettings 포팅.
// DBA 이상에게만 보여줘야 하므로, 렌더링 여부는 부모(App)가 role을 보고 결정한다.
export function ScheduleSettings({ checkedIds }: Props): ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [runTime, setRunTime] = useState('07:00');

  useEffect(() => {
    getScheduleConfig()
      .then((config) => {
        setEnabled(config.enabled === 'Y');
        if (config.runTime) setRunTime(config.runTime);
      })
      .catch((error) => console.log('예약 실행 설정 조회 실패:', error));
  }, []);

  async function handleSave(): Promise<void> {
    if (!runTime) {
      showToast('실행 시각을 입력하세요', 'error');
      return;
    }

    const dbmsIds = Array.from(checkedIds);
    try {
      await saveScheduleConfig({ enabled: enabled ? 'Y' : 'N', runTime, dbmsIds });
      showToast(`예약 실행 설정 저장 완료 (대상 ${dbmsIds.length}개, ${runTime})`);
    } catch (error) {
      console.error('예약 실행 설정 저장 실패:', error);
      showToast('예약 실행 설정 저장 실패', 'error');
    }
  }

  return (
    <div id="schedule-settings" className="schedule-settings">
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 매일 자동 실행
      </label>
      <input type="time" value={runTime} onChange={(e) => setRunTime(e.target.value)} />
      <button type="button" className="btn-secondary" onClick={handleSave}>
        자동 실행 대상으로 저장 (아래 체크된 DB)
      </button>
    </div>
  );
}
