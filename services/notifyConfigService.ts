import nodemailer from 'nodemailer';
import * as notifyConfigModel from '../models/notifyConfigModel';
import { decrypt, encrypt } from '../models/cryptoUtils';
import { logger } from '../utils/logger';
import {
  channelsOf,
  chatsFromUpdates,
  DEFAULT_SMTP_PORT,
  mailSubjectOf,
  mergeSettings,
  NotifyValidationError,
  pickTelegramToken,
  settingsFromEnv,
  splitRecipients,
  type MailChannel,
  type NotifyChannels,
  type NotifySettings,
  type TelegramChat,
} from './notifyRules';

// 계정 > 알림 설정. 저장된 행(system.notify_config)이 있으면 그 값, 없거나 테이블이 없으면 .env 값으로 동작.
// 알림은 점검마다 나가므로 매번 DB를 읽지 않게 메모리에 두고, 저장하면 비운다 (프로세스 하나짜리 앱).

export type NotifySource = 'db' | 'env';

interface Loaded {
  settings: NotifySettings;
  source: NotifySource;
  updatetime: string | null;
  updatedBy: string | null;
}

const REQUEST_TIMEOUT_MS = 10000;

let cache: Loaded | null = null;
// 테이블이 없거나(ORA-00942) 메일 컬럼이 없으면(ORA-00904, 예전 버전 스크립트) 저장을 막고 .env 값으로 동작. 사용자에게 보일 안내.
let unavailableReason: string | null = null;

function oraCodeOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const match = current instanceof Error ? /ORA-(00942|00904)/.exec(current.message) : null;
    if (match) return match[1];
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

// 키(DBMS_ENCRYPTION_KEY)가 바뀌어 복호화가 안 되면 그 값만 없는 셈 치고 화면에서 다시 넣게 한다.
function decryptOrNull(value: string | null, label: string): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch (error) {
    logger.warn('Notify', `저장된 ${label} 복호화 실패 — 알림 설정 화면에서 다시 입력하세요`, error);
    return null;
  }
}

async function load(): Promise<Loaded> {
  if (cache) return cache;
  const env: Loaded = { settings: settingsFromEnv(process.env), source: 'env', updatetime: null, updatedBy: null };
  if (unavailableReason) return (cache = env);
  try {
    const row = await notifyConfigModel.getConfig();
    if (!row) return (cache = env);
    return (cache = {
      settings: {
        telegramEnabled: row.telegramEnabled,
        telegramToken: decryptOrNull(row.telegramTokenEnc, 'Telegram 봇 토큰'),
        telegramChatId: row.telegramChatId,
        slackEnabled: row.slackEnabled,
        slackWebhookUrl: decryptOrNull(row.slackWebhookEnc, 'Slack 웹훅 URL'),
        mailEnabled: row.mailEnabled,
        smtpHost: row.smtpHost,
        smtpPort: row.smtpPort ?? DEFAULT_SMTP_PORT,
        smtpSecure: row.smtpSecure,
        smtpTlsInsecure: row.smtpTlsInsecure,
        smtpUser: row.smtpUser,
        smtpPassword: decryptOrNull(row.smtpPasswordEnc, 'SMTP 비밀번호'),
        mailFrom: row.mailFrom,
        mailTo: splitRecipients(row.mailTo),
      },
      source: 'db',
      updatetime: row.updatetime,
      updatedBy: row.updatedBy,
    });
  } catch (error) {
    const code = oraCodeOf(error);
    if (code) {
      unavailableReason =
        code === '00942'
          ? '알림 설정 테이블이 없습니다. 메타데이터 DB에 scripts/add_notify_config.sql을 실행하세요'
          : '알림 설정 테이블에 메일 컬럼이 없습니다. 메타데이터 DB에 scripts/add_notify_config_mail.sql을 실행하세요';
      logger.warn('Notify', `${unavailableReason} (그 전까지 .env 값으로 동작)`);
      return (cache = env);
    }
    throw new Error('알림 설정 조회 실패', { cause: error });
  }
}

// 실제 발송에 쓸 채널. 설정을 못 읽으면 .env 값으로라도 보낸다 (알림이 점검을 막으면 안 됨).
async function getChannels(): Promise<NotifyChannels> {
  try {
    return channelsOf((await load()).settings);
  } catch (error) {
    logger.warn('Notify', '알림 설정 조회 실패 — .env 값으로 발송', error);
    return channelsOf(settingsFromEnv(process.env));
  }
}

// 화면용: 비밀값(토큰/웹훅/SMTP 비밀번호)은 내려주지 않고 저장 여부만.
export interface NotifyConfigView {
  available: boolean;
  unavailableReason: string | null;
  source: NotifySource;
  telegram: { enabled: boolean; tokenSet: boolean; chatId: string | null };
  slack: { enabled: boolean; webhookSet: boolean };
  mail: {
    enabled: boolean;
    host: string | null;
    port: number;
    secure: boolean;
    tlsInsecure: boolean;
    user: string | null;
    passwordSet: boolean;
    from: string | null;
    to: string[];
  };
  updatetime: string | null;
  updatedBy: string | null;
}

async function getView(): Promise<NotifyConfigView> {
  const { settings: s, source, updatetime, updatedBy } = await load();
  return {
    available: !unavailableReason,
    unavailableReason,
    source,
    telegram: { enabled: s.telegramEnabled, tokenSet: !!s.telegramToken, chatId: s.telegramChatId },
    slack: { enabled: s.slackEnabled, webhookSet: !!s.slackWebhookUrl },
    mail: {
      enabled: s.mailEnabled,
      host: s.smtpHost,
      port: s.smtpPort,
      secure: s.smtpSecure,
      tlsInsecure: s.smtpTlsInsecure,
      user: s.smtpUser,
      passwordSet: !!s.smtpPassword,
      from: s.mailFrom,
      to: s.mailTo,
    },
    updatetime,
    updatedBy,
  };
}

async function save(input: unknown, updatedBy: string | null): Promise<void> {
  const base = (await load()).settings;
  if (unavailableReason) throw new NotifyValidationError(unavailableReason);
  const merged = mergeSettings(base, input);
  try {
    await notifyConfigModel.saveConfig({
      telegramEnabled: merged.telegramEnabled,
      telegramTokenEnc: merged.telegramToken ? encrypt(merged.telegramToken) : null,
      telegramChatId: merged.telegramChatId,
      slackEnabled: merged.slackEnabled,
      slackWebhookEnc: merged.slackWebhookUrl ? encrypt(merged.slackWebhookUrl) : null,
      mailEnabled: merged.mailEnabled,
      smtpHost: merged.smtpHost,
      smtpPort: merged.smtpPort,
      smtpSecure: merged.smtpSecure,
      smtpTlsInsecure: merged.smtpTlsInsecure,
      smtpUser: merged.smtpUser,
      smtpPasswordEnc: merged.smtpPassword ? encrypt(merged.smtpPassword) : null,
      mailFrom: merged.mailFrom,
      mailTo: merged.mailTo.length > 0 ? merged.mailTo.join(',') : null,
      updatedBy,
    });
  } catch (error) {
    throw new Error('알림 설정 저장 실패', { cause: error });
  } finally {
    cache = null;
  }
}

// ── 발송 ─────────────────────────────────────────────────────────────────────
// 에러 메시지에 토큰이 들어간 URL을 넣지 않는다.

async function describeFailure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { description?: unknown } | null;
  const detail = typeof body?.description === 'string' ? ` — ${body.description}` : '';
  return `HTTP ${res.status}${detail}`;
}

async function sendTelegram(channel: { token: string; chatId: string }, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${channel.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channel.chatId, text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Telegram 알림 실패 (${await describeFailure(res)})`);
}

async function sendSlack(channel: { url: string }, text: string): Promise<void> {
  const res = await fetch(channel.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Slack 알림 실패 (HTTP ${res.status})`);
}

// 사내 SMTP 릴레이. secure=false면 서버가 STARTTLS를 지원할 때만 TLS로 올린다 (nodemailer 기본 동작).
async function sendMail(channel: MailChannel, text: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: channel.host,
    port: channel.port,
    secure: channel.secure,
    auth: channel.auth ?? undefined,
    tls: channel.tlsInsecure ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: REQUEST_TIMEOUT_MS,
    greetingTimeout: REQUEST_TIMEOUT_MS,
    socketTimeout: REQUEST_TIMEOUT_MS * 2,
  });
  try {
    await transport.sendMail({ from: channel.from, to: channel.to, subject: mailSubjectOf(text), text });
  } catch (error) {
    throw new Error(`메일 알림 실패 (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  } finally {
    transport.close();
  }
}

export interface ChannelResult {
  channel: 'telegram' | 'slack' | 'mail';
  ok: boolean;
  message: string;
}

async function sendTo(channels: NotifyChannels, text: string): Promise<ChannelResult[]> {
  const jobs: Promise<ChannelResult>[] = [];
  const run = (channel: ChannelResult['channel'], send: () => Promise<void>): Promise<ChannelResult> =>
    send().then(
      () => ({ channel, ok: true, message: '발송 성공' }),
      (error: unknown) => ({ channel, ok: false, message: error instanceof Error ? error.message : String(error) })
    );
  const { telegram, slack, mail } = channels;
  if (telegram) jobs.push(run('telegram', () => sendTelegram(telegram, text)));
  if (slack) jobs.push(run('slack', () => sendSlack(slack, text)));
  if (mail) jobs.push(run('mail', () => sendMail(mail, text)));
  return Promise.all(jobs);
}

// 화면의 "테스트 발송": 저장 전 입력값(비운 비밀값은 저장된 값)으로 켜진 채널에 보낸다.
async function sendTest(input: unknown, requestedBy: string | null): Promise<ChannelResult[]> {
  const channels = channelsOf(mergeSettings((await load()).settings, input));
  if (!channels.telegram && !channels.slack && !channels.mail) throw new NotifyValidationError('켜진 채널이 없습니다.');
  return sendTo(channels, `✅ DB Cockpit 알림 테스트${requestedBy ? ` (by ${requestedBy})` : ''}\n이 메시지가 보이면 알림 설정이 정상입니다.`);
}

// chat_id 찾기: 봇에게 먼저 메시지를 보낸(또는 봇을 초대한) 대화방 목록.
async function findTelegramChats(input: unknown): Promise<TelegramChat[]> {
  const token = pickTelegramToken((await load()).settings, input);
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new NotifyValidationError(`Telegram 조회 실패 (${await describeFailure(res)})`);
  return chatsFromUpdates(await res.json());
}

export { getChannels, getView, save, sendTo, sendTest, findTelegramChats };
