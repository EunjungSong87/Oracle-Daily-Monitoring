import type { IssueNotification } from '../models/issuesModel';
import { logger } from '../utils/logger';

// 신규/재오픈 이슈를 Telegram/Slack으로 알림. 환경변수가 없는 쪽은 조용히 skip, 둘 다 없으면 아무것도 안 함.
// 점검 파이프라인을 막으면 안 되므로 실패해도 던지지 않고 한 번만 로그.

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram 알림 실패 (HTTP ${res.status})`);
}

async function sendSlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack 알림 실패 (HTTP ${res.status})`);
}

async function sendAlert(text: string): Promise<void> {
  const results = await Promise.allSettled([sendTelegram(text), sendSlack(text)]);
  for (const result of results) {
    if (result.status === 'rejected') logger.warn('Notify', '알림 전송 실패', result.reason);
  }
}

function formatIssueAlerts(dbname: string, notifications: IssueNotification[]): string {
  const lines = notifications.map((n) => {
    const tag = n.kind === 'NEW' ? '신규' : '재오픈';
    const value = n.value !== null ? ` (값: ${n.value})` : '';
    return `[${n.clevel}] ${tag} ${n.taskName}/${n.columnName}: ${n.message ?? ''}${value}`;
  });
  return `🚨 DB Cockpit 알림 — ${dbname}\n${lines.join('\n')}`;
}

export { sendAlert, formatIssueAlerts };
