import type { IssueNotification } from '../models/issuesModel';
import { logger } from '../utils/logger';
import { CONNECT_COLUMN, EXEC_ERROR_COLUMN } from '../utils/issueKinds';
import * as notifyConfigService from './notifyConfigService';

// 신규/재오픈 이슈를 Telegram/Slack으로 알림. 채널 설정은 계정 > 알림 설정(없으면 .env) — services/notifyConfigService.ts.
// 켜진 채널이 없으면 아무것도 안 함. 점검 파이프라인을 막으면 안 되므로 실패해도 던지지 않고 한 번만 로그.

async function sendAlert(text: string): Promise<void> {
  const results = await notifyConfigService.sendTo(await notifyConfigService.getChannels(), text);
  for (const result of results) {
    if (!result.ok) logger.warn('Notify', `알림 전송 실패: ${result.message}`);
  }
}

function formatIssueAlerts(dbname: string, notifications: IssueNotification[]): string {
  const lines = notifications.map((n) => {
    const tag = n.kind === 'NEW' ? '신규' : '재오픈';
    // 실패 티켓은 message에 실패 유형과 에러 첫 줄이 이미 들어 있다
    if (n.columnName === CONNECT_COLUMN) return `[${n.clevel}] ${tag} 대상 DB 접속 실패 — ${n.message ?? ''}`;
    if (n.columnName === EXEC_ERROR_COLUMN) return `[${n.clevel}] ${tag} 스크립트 실행 실패: ${n.taskName} — ${n.message ?? ''}`;
    const value = n.value !== null ? ` (값: ${n.value})` : '';
    return `[${n.clevel}] ${tag} ${n.taskName}/${n.columnName}: ${n.message ?? ''}${value}`;
  });
  return `🚨 DB Cockpit 알림 — ${dbname}\n${lines.join('\n')}`;
}

export { sendAlert, formatIssueAlerts };
