// 알림 설정의 순수 로직 (DB/네트워크 없음 — 단위 테스트 대상).
// 저장값(복호화된 상태) + 화면 입력 → 검증/병합, 그리고 실제 발송에 쓸 채널 정보 계산.

export class NotifyValidationError extends Error {}

export interface NotifySettings {
  telegramEnabled: boolean;
  telegramToken: string | null;
  telegramChatId: string | null;
  slackEnabled: boolean;
  slackWebhookUrl: string | null;
  // 사내 메일 (SMTP 릴레이) — 내부망에서 외부 메신저로 못 나갈 때용
  mailEnabled: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean; // true = 접속부터 TLS(보통 465). false면 서버가 STARTTLS를 지원할 때만 올림
  smtpTlsInsecure: boolean; // 사설 인증서라 검증이 실패할 때만 켬
  smtpUser: string | null; // 비우면 인증 없이 (사내 릴레이에 흔함)
  smtpPassword: string | null;
  mailFrom: string | null;
  mailTo: string[];
}

export interface MailChannel {
  host: string;
  port: number;
  secure: boolean;
  tlsInsecure: boolean;
  auth: { user: string; pass: string } | null;
  from: string;
  to: string[];
}

export interface NotifyChannels {
  telegram: { token: string; chatId: string } | null;
  slack: { url: string } | null;
  mail: MailChannel | null;
}

const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,})$/;
const MAX_URL_LENGTH = 1000;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const MAX_RECIPIENTS = 20;
export const DEFAULT_SMTP_PORT = 25;

export const EMPTY_SETTINGS: NotifySettings = {
  telegramEnabled: false,
  telegramToken: null,
  telegramChatId: null,
  slackEnabled: false,
  slackWebhookUrl: null,
  mailEnabled: false,
  smtpHost: null,
  smtpPort: DEFAULT_SMTP_PORT,
  smtpSecure: false,
  smtpTlsInsecure: false,
  smtpUser: null,
  smtpPassword: null,
  mailFrom: null,
  mailTo: [],
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTelegramToken(value: string): boolean {
  return TELEGRAM_TOKEN_RE.test(value);
}

// 받는 사람: 쉼표/세미콜론/공백/줄바꿈 구분, 중복 제거 (형식 검사는 호출부에서).
export function splitRecipients(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(',') : text(value);
  return [...new Set(raw.split(/[\s,;]+/).filter(Boolean))];
}

function parsePort(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_SMTP_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NotifyValidationError('SMTP 포트는 1~65535 사이 숫자여야 합니다.');
  return port;
}

function envFlag(value: string | undefined): boolean {
  return /^(1|y|yes|true)$/i.test(text(value));
}

// .env 값(예전 방식)을 저장값 모양으로 — 화면에서 처음 저장할 때 비밀값을 다시 안 넣어도 되게 기본값으로 쓴다.
export function settingsFromEnv(env: Record<string, string | undefined>): NotifySettings {
  const token = text(env.TELEGRAM_BOT_TOKEN) || null;
  const chatId = text(env.TELEGRAM_CHAT_ID) || null;
  const url = text(env.SLACK_WEBHOOK_URL) || null;
  const smtpHost = text(env.SMTP_HOST) || null;
  const mailFrom = text(env.MAIL_FROM) || null;
  const mailTo = splitRecipients(env.MAIL_TO);
  const smtpUser = text(env.SMTP_USER) || null;
  let smtpPort = DEFAULT_SMTP_PORT;
  try {
    smtpPort = parsePort(text(env.SMTP_PORT));
  } catch {
    // 잘못된 값이면 기본 포트
  }
  return {
    telegramEnabled: !!(token && chatId),
    telegramToken: token,
    telegramChatId: chatId,
    slackEnabled: !!url,
    slackWebhookUrl: url,
    mailEnabled: !!(smtpHost && mailFrom && mailTo.length > 0),
    smtpHost,
    smtpPort,
    smtpSecure: envFlag(env.SMTP_SECURE),
    smtpTlsInsecure: envFlag(env.SMTP_TLS_INSECURE),
    smtpUser,
    smtpPassword: smtpUser ? text(env.SMTP_PASSWORD) || null : null,
    mailFrom,
    mailTo,
  };
}

export function channelsOf(settings: NotifySettings): NotifyChannels {
  const { smtpHost, mailFrom } = settings;
  return {
    telegram: settings.telegramEnabled && settings.telegramToken && settings.telegramChatId ? { token: settings.telegramToken, chatId: settings.telegramChatId } : null,
    slack: settings.slackEnabled && settings.slackWebhookUrl ? { url: settings.slackWebhookUrl } : null,
    mail:
      settings.mailEnabled && smtpHost && mailFrom && settings.mailTo.length > 0
        ? {
            host: smtpHost,
            port: settings.smtpPort,
            secure: settings.smtpSecure,
            tlsInsecure: settings.smtpTlsInsecure,
            auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPassword ?? '' } : null,
            from: mailFrom,
            to: settings.mailTo,
          }
        : null,
  };
}

type MailFields = Pick<
  NotifySettings,
  'mailEnabled' | 'smtpHost' | 'smtpPort' | 'smtpSecure' | 'smtpTlsInsecure' | 'smtpUser' | 'smtpPassword' | 'mailFrom' | 'mailTo'
>;

function mergeMail(base: NotifySettings, mail: Record<string, unknown>): MailFields {
  const host = text(mail.host);
  if (host && !HOST_RE.test(host)) throw new NotifyValidationError('SMTP 서버는 호스트명 또는 IP여야 합니다 (예: mail.company.local).');
  const from = text(mail.from);
  if (from && !EMAIL_RE.test(from)) throw new NotifyValidationError('보내는 사람 메일 주소 형식이 아닙니다.');
  const to = splitRecipients(mail.to);
  const bad = to.find((address) => !EMAIL_RE.test(address));
  if (bad) throw new NotifyValidationError(`받는 사람 메일 주소 형식이 아닙니다: ${bad}`);
  if (to.length > MAX_RECIPIENTS) throw new NotifyValidationError(`받는 사람은 ${MAX_RECIPIENTS}명까지입니다.`);
  // 계정을 비우면 인증 없이 보내는 것 — 저장된 비밀번호도 버린다. 같은 계정이면 비운 비밀번호 칸은 기존 값 유지.
  const user = text(mail.user) || null;
  const newPassword = typeof mail.password === 'string' ? mail.password : '';
  const password = user ? newPassword || (user === base.smtpUser ? base.smtpPassword : null) : null;
  return {
    mailEnabled: mail.enabled === true,
    smtpHost: host || null,
    smtpPort: parsePort(mail.port),
    smtpSecure: mail.secure === true,
    smtpTlsInsecure: mail.tlsInsecure === true,
    smtpUser: user,
    smtpPassword: password,
    mailFrom: from || null,
    mailTo: to,
  };
}

// 화면 입력을 기존 값 위에 덮는다. 토큰/웹훅/SMTP 비밀번호 칸이 비어 있으면 기존 값 유지 (화면에는 비밀값을 내려주지 않으므로).
// 꺼둔 채널도 값은 남겨 둬서, 다시 켤 때 재입력이 필요 없다. 입력에 mail 블록이 없으면 메일 설정은 기존 값 그대로.
export function mergeSettings(base: NotifySettings, input: unknown): NotifySettings {
  const body = (input ?? {}) as { telegram?: Record<string, unknown>; slack?: Record<string, unknown>; mail?: Record<string, unknown> };
  const tg = body.telegram ?? {};
  const sl = body.slack ?? {};

  const newToken = text(tg.token);
  if (newToken && !isTelegramToken(newToken)) throw new NotifyValidationError('Telegram 봇 토큰 형식이 아닙니다 (예: 123456789:AA...).');
  const chatId = text(tg.chatId);
  if (chatId && !TELEGRAM_CHAT_ID_RE.test(chatId)) throw new NotifyValidationError('Telegram chat_id는 숫자(그룹은 -로 시작) 또는 @채널이름이어야 합니다.');

  const newUrl = text(sl.webhookUrl);
  if (newUrl && (!/^https:\/\/\S+$/.test(newUrl) || newUrl.length > MAX_URL_LENGTH)) throw new NotifyValidationError('Slack 웹훅 URL은 https://로 시작해야 합니다.');

  const merged: NotifySettings = {
    ...base,
    telegramEnabled: tg.enabled === true,
    telegramToken: newToken || base.telegramToken,
    telegramChatId: chatId || null,
    slackEnabled: sl.enabled === true,
    slackWebhookUrl: newUrl || base.slackWebhookUrl,
    ...(body.mail ? mergeMail(base, body.mail) : {}),
  };
  if (merged.telegramEnabled && (!merged.telegramToken || !merged.telegramChatId)) {
    throw new NotifyValidationError('Telegram을 켜려면 봇 토큰과 chat_id가 모두 필요합니다.');
  }
  if (merged.slackEnabled && !merged.slackWebhookUrl) throw new NotifyValidationError('Slack을 켜려면 웹훅 URL이 필요합니다.');
  if (merged.mailEnabled && (!merged.smtpHost || !merged.mailFrom || merged.mailTo.length === 0)) {
    throw new NotifyValidationError('메일을 켜려면 SMTP 서버, 보내는 사람, 받는 사람이 모두 필요합니다.');
  }
  return merged;
}

// 메일 제목/본문: 알림 텍스트의 첫 줄이 제목, 전체가 본문.
export function mailSubjectOf(text: string): string {
  return text.split('\n', 1)[0].slice(0, 200);
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
