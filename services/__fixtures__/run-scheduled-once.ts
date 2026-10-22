// 도커 테스트 DB에 예약 점검을 한 번 돌린다 (용량 수집·예측·이슈 확인용 일회성 도구): npx tsx services/__fixtures__/run-scheduled-once.ts <dbmsid> [MANUAL]
import 'dotenv/config';
import * as dbmsService from '../dbmsService';

dbmsService
  .getMonResult({ dbmsid: Number(process.argv[2] ?? 1) }, process.argv[3] === 'MANUAL' ? 'MANUAL' : 'SCHEDULED')
  .then((results) => {
    const capacity = results.find((task) => task.task_id === -100);
    console.log(`tasks=${results.length}`, capacity ? JSON.stringify(capacity.rows.map((row: Record<string, unknown>) => [row.KIND, row.NAME, row.USED_PCT, row.ESTIMATE, !!row._alerts]), null, 0) : 'no capacity task');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
