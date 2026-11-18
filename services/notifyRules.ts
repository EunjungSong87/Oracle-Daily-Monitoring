// 알림 설정의 순수 로직 (DB/네트워크 없음 — 단위 테스트 대상).
// 저장값(복호화된 상태) + 화면 입력 → 검증/병합, 그리고 실제 발송에 쓸 채널 정보 계산.

export class NotifyValidationError extends Error {}

export interface NotifySettings {
  telegramEnabled: boolean;
  telegramToken: string | null;
  telegramChatId: string | null;
  slackEnabled: boolean;
  slackWebhookUrl: string | null;
}

export interface NotifyChannels {
  telegram: { token: string; chatId: string } | null;
  slack: { url: string } | null;
}

const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,})$/;
const MAX_URL_LENGTH = 1000;

export const EMPTY_SETTINGS: NotifySettings = { telegramEnabled: false, telegramToken: null, telegramChatId: null, slackEnabled: false, slackWebhookUrl: null };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTelegramToken(value: string): boolean {
  return TELEGRAM_TOKEN_RE.test(value);
}

// .env 값(예전 방식)을 저장값 모양으로 — 화면에서 처음 저장할 때 토큰을 다시 안 넣어도 되게 기본값으로 쓴다.
export function settingsFromEnv(env: Record<string, string | undefined>): NotifySettings {
  const token = text(env.TELEGRAM_BOT_TOKEN) || null;
  const chatId = text(env.TELEGRAM_CHAT_ID) || null;
  const url = text(env.SLACK_WEBHOOK_URL) || null;
  return { telegramEnabled: !!(token && chatId), telegramToken: token, telegramChatId: chatId, slackEnabled: !!url, slackWebhookUrl: url };
}

export function channelsOf(settings: NotifySettings): NotifyChannels {
  return {
    telegram: settings.telegramEnabled && settings.telegramToken && settings.telegramChatId ? { token: settings.telegramToken, chatId: settings.telegramChatId } : null,
    slack: settings.slackEnabled && settings.slackWebhookUrl ? { url: settings.slackWebhookUrl } : null,
  };
}

// 화면 입력을 기존 값 위에 덮는다. 토큰/웹훅 칸이 비어 있으면 기존 값 유지 (화면에는 비밀값을 내려주지 않으므로).
// 꺼둔 채널도 값은 남겨 둬서, 다시 켤 때 재입력이 필요 없다.
export function mergeSettings(base: NotifySettings, input: unknown): NotifySettings {
  const body = (input ?? {}) as { telegram?: Record<string, unknown>; slack?: Record<string, unknown> };
  const tg = body.telegram ?? {};
  const sl = body.slack ?? {};

  const newToken = text(tg.token);
  if (newToken && !isTelegramToken(newToken)) throw new NotifyValidationError('Telegram 봇 토큰 형식이 아닙니다 (예: 123456789:AA...).');
  const chatId = text(tg.chatId);
  if (chatId && !TELEGRAM_CHAT_ID_RE.test(chatId)) throw new NotifyValidationError('Telegram chat_id는 숫자(그룹은 -로 시작) 또는 @채널이름이어야 합니다.');

  const newUrl = text(sl.webhookUrl);
  if (newUrl && (!/^https:\/\/\S+$/.test(newUrl) || newUrl.length > MAX_URL_LENGTH)) throw new NotifyValidationError('Slack 웹훅 URL은 https://로 시작해야 합니다.');

  const merged: NotifySettings = {
    telegramEnabled: tg.enabled === true,
    telegramToken: newToken || base.telegramToken,
    telegramChatId: chatId || null,
    slackEnabled: sl.enabled === true,
    slackWebhookUrl: newUrl || base.slackWebhookUrl,
  };
  if (merged.telegramEnabled && (!merged.telegramToken || !merged.telegramChatId)) {
    throw new NotifyValidationError('Telegram을 켜려면 봇 토큰과 chat_id가 모두 필요합니다.');
  }
  if (merged.slackEnabled && !merged.slackWebhookUrl) throw new NotifyValidationError('Slack을 켜려면 웹훅 URL이 필요합니다.');
  return merged;
}

// chat_id 찾기용: 화면에서 새 토큰을 넣었으면 그것, 아니면 저장된 토큰
export function pickTelegramToken(base: NotifySettings, input: unknown): string {
  const token = text((input as { token?: unknown } | null)?.token) || base.telegramToken || '';
  if (!token) throw new NotifyValidationError('Telegram 봇 토큰을 먼저 입력하세요.');
  if (!isTelegramToken(token)) throw new NotifyValidationError('Telegram 봇 토큰 형식이 아닙니다 (예: 123456789:AA...).');
  return token;
}

export interface TelegramChat {
  id: string;
  type: string;
  name: string;
}

// getUpdates 응답에서 대화방 목록 (중복 제거, 최근 것이 앞)
export function chatsFromUpdates(body: unknown): TelegramChat[] {
  const updates = Array.isArray((body as { result?: unknown })?.result) ? ((body as { result: unknown[] }).result as Record<string, any>[]) : [];
  const seen = new Map<string, TelegramChat>();
  for (const update of [...updates].reverse()) {
    const holder = update.message ?? update.edited_message ?? update.channel_post ?? update.my_chat_member ?? update.chat_member;
    const chat = holder?.chat;
    if (!chat || chat.id === undefined) continue;
    const id = String(chat.id);
    if (seen.has(id)) continue;
    const person = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    seen.set(id, { id, type: String(chat.type ?? ''), name: chat.title ?? (chat.username ? `@${chat.username}` : '') });
    if (!seen.get(id)!.name) seen.get(id)!.name = person;
  }
  return [...seen.values()];
}
