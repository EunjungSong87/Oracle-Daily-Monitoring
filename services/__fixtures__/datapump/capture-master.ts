// 도커 테스트 DB에서 외부(expdp/impdp 직접 실행) 작업의 마스터 테이블 메타 행과 세션 정보를 픽스처로 저장 (테스트용 일회성 도구).
// 사용: 작업을 docker exec로 띄운 뒤  npx tsx services/__fixtures__/datapump/capture-master.ts <OWNER> <JOB_NAME> <파일이름>
import 'dotenv/config';
import { writeFileSync } from 'fs';
import path from 'path';
import * as dataPumpModel from '../../../models/dataPumpModel';

async function main(): Promise<void> {
  const [owner, jobName, out] = process.argv.slice(2);
  const rows = await dataPumpModel.getMasterRows({ dbmsid: 1 }, owner, jobName);
  const sessions = await dataPumpModel.getJobSessions({ dbmsid: 1 }, [{ owner, jobName }]);
  writeFileSync(path.join(__dirname, `${out}.json`), JSON.stringify({ rows, sessions }, null, 2));
  console.log(`${rows.length} rows, ${sessions.length} sessions → ${out}.json`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
