import { describe, expect, it } from 'vitest';
import {
  channelsOf,
  chatsFromUpdates,
  EMPTY_SETTINGS,
  mailSubjectOf,
  mergeSettings,
  NotifyValidationError,
  pickTelegramToken,
  settingsFromEnv,
  splitRecipients,
} from './notifyRules';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnn';
const SAVED = {
  ...EMPTY_SETTINGS,
  telegramEnabled: true,
  telegramToken: TOKEN,
  telegramChatId: '-1001',
  slackEnabled: true,
  slackWebhookUrl: 'https://hooks.slack.com/x',
};
const SAVED_MAIL = {
  ...EMPTY_SETTINGS,
  mailEnabled: true,
  smtpHost: 'mail.corp.local',
  smtpPort: 587,
  smtpUser: 'dbcockpit',
  smtpPassword: 'secret',
  mailFrom: 'dbcockpit@corp.local',
  mailTo: ['dba@corp.local'],
};

describe('settingsFromEnv', () => {
  it('값이 있는 채널만 켠다', () => {
    expect(settingsFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: ' 42 ' })).toEqual({
      ...EMPTY_SETTINGS,
      telegramEnabled: true,
      telegramToken: TOKEN,
      telegramChatId: '42',
    });
    expect(settingsFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toMatchObject({ telegramEnabled: false });
    expect(settingsFromEnv({})).toEqual(EMPTY_SETTINGS);
  });

  it('메일: 서버·보내는 사람·받는 사람이 다 있어야 켜짐, 계정 없으면 비밀번호 무시', () => {
    expect(
      settingsFromEnv({ SMTP_HOST: 'mail.corp.local', SMTP_PORT: '587', SMTP_SECURE: 'Y', MAIL_FROM: 'a@corp.local', MAIL_TO: 'b@corp.local; c@corp.local', SMTP_PASSWORD: 'x' })
    ).toMatchObject({ mailEnabled: true, smtpPort: 587, smtpSecure: true, smtpUser: null, smtpPassword: null, mailTo: ['b@corp.local', 'c@corp.local'] });
    expect(settingsFromEnv({ SMTP_HOST: 'mail.corp.local', SMTP_PORT: 'abc' })).toMatchObject({ mailEnabled: false, smtpPort: 25 });
  });
});

describe('splitRecipients / mailSubjectOf', () => {
  it('구분자 여러 종류, 중복 제거', () => {
    expect(splitRecipients(' a@x.com, b@x.com;a@x.com\nc@x.com ')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(splitRecipients(['a@x.com', 'b@x.com'])).toEqual(['a@x.com', 'b@x.com']);
    expect(splitRecipients(undefined)).toEqual([]);
  });

  it('제목은 첫 줄', () => {
    expect(mailSubjectOf('🚨 DB Cockpit 알림 — PROD\n[ERROR] ...')).toBe('🚨 DB Cockpit 알림 — PROD');
  });
});

describe('channelsOf', () => {
  it('켜져 있고 값이 다 있는 채널만', () => {
    expect(channelsOf(SAVED)).toEqual({ telegram: { token: TOKEN, chatId: '-1001' }, slack: { url: 'https://hooks.slack.com/x' }, mail: null });
    expect(channelsOf({ ...SAVED, telegramEnabled: false, slackWebhookUrl: null })).toEqual({ telegram: null, slack: null, mail: null });
  });

  it('메일: 계정이 있으면 auth, 없으면 null', () => {
    expect(channelsOf(SAVED_MAIL).mail).toEqual({
      host: 'mail.corp.local',
      port: 587,
      secure: false,
      tlsInsecure: false,
      auth: { user: 'dbcockpit', pass: 'secret' },
      from: 'dbcockpit@corp.local',
      to: ['dba@corp.local'],
    });
    expect(channelsOf({ ...SAVED_MAIL, smtpUser: null }).mail?.auth).toBeNull();
    expect(channelsOf({ ...SAVED_MAIL, mailTo: [] }).mail).toBeNull();
  });
});

describe('mergeSettings', () => {
  it('비밀값 칸이 비면 기존 값 유지, 끈 채널도 값은 남긴다', () => {
    const merged = mergeSettings(SAVED, { telegram: { enabled: false, token: '', chatId: '-1001' }, slack: { enabled: true, webhookUrl: '' } });
    expect(merged).toEqual({ ...SAVED, telegramEnabled: false });
  });

  it('새 값이 있으면 덮어쓴다', () => {
    const merged = mergeSettings(EMPTY_SETTINGS, { telegram: { enabled: true, token: ` ${TOKEN} `, chatId: '@my_channel' } });
    expect(merged).toMatchObject({ telegramEnabled: true, telegramToken: TOKEN, telegramChatId: '@my_channel', slackEnabled: false });
  });

  it('형식 오류와 켰는데 값이 없는 경우는 거부', () => {
    expect(() => mergeSettings(EMPTY_SETTINGS, { telegram: { token: 'nope' } })).toThrow(NotifyValidationError);
    expect(() => mergeSettings(EMPTY_SETTINGS, { telegram: { chatId: 'abc' } })).toThrow(NotifyValidationError);
    expect(() => mergeSettings(EMPTY_SETTINGS, { slack: { webhookUrl: 'http://insecure' } })).toThrow(NotifyValidationError);
    expect(() => mergeSettings(EMPTY_SETTINGS, { telegram: { enabled: true, token: TOKEN } })).toThrow(/chat_id/);
    expect(() => mergeSettings(EMPTY_SETTINGS, { slack: { enabled: true } })).toThrow(/웹훅/);
  });

  it('메일 블록이 없으면 메일 설정은 그대로', () => {
    expect(mergeSettings(SAVED_MAIL, { telegram: {}, slack: {} })).toEqual(SAVED_MAIL);
  });

  it('메일: 같은 계정이면 빈 비밀번호는 기존 값, 계정을 바꾸거나 비우면 버린다', () => {
    const mail = { enabled: true, host: 'mail.corp.local', port: '587', user: 'dbcockpit', password: '', from: 'dbcockpit@corp.local', to: 'dba@corp.local' };
    expect(mergeSettings(SAVED_MAIL, { mail })).toEqual(SAVED_MAIL);
    expect(mergeSettings(SAVED_MAIL, { mail: { ...mail, user: 'other' } }).smtpPassword).toBeNull();
    expect(mergeSettings(SAVED_MAIL, { mail: { ...mail, user: '' } })).toMatchObject({ smtpUser: null, smtpPassword: null });
    expect(mergeSettings(SAVED_MAIL, { mail: { ...mail, password: 'new' } }).smtpPassword).toBe('new');
    expect(mergeSettings(SAVED_MAIL, { mail: { ...mail, port: '' } }).smtpPort).toBe(25);
  });

  it('메일: 형식 오류와 필수값 누락 거부', () => {
    const mail = { enabled: true, host: 'mail.corp.local', from: 'a@corp.local', to: 'b@corp.local' };
    expect(() => mergeSettings(EMPTY_SETTINGS, { mail: { ...mail, host: 'bad host' } })).toThrow(/SMTP 서버/);
    expect(() => mergeSettings(EMPTY_SETTINGS, { mail: { ...mail, port: '70000' } })).toThrow(/포트/);
    expect(() => mergeSettings(EMPTY_SETTINGS, { mail: { ...mail, from: 'nope' } })).toThrow(/보내는 사람/);
    expect(() => mergeSettings(EMPTY_SETTINGS, { mail: { ...mail, to: 'b@corp.local, nope' } })).toThrow(/nope/);
    expect(() => mergeSettings(EMPTY_SETTINGS, { mail: { ...mail, to: '' } })).toThrow(/받는 사람이 모두/);
  });
});

describe('pickTelegramToken', () => {
  it('입력 토큰 우선, 없으면 저장된 토큰', () => {
    expect(pickTelegramToken(SAVED, {})).toBe(TOKEN);
    expect(pickTelegramToken(EMPTY_SETTINGS, { token: TOKEN })).toBe(TOKEN);
    expect(() => pickTelegramToken(EMPTY_SETTINGS, {})).toThrow(NotifyValidationError);
  });
});

describe('chatsFromUpdates', () => {
  it('대화방 중복 제거, 최근 것이 앞, 이름은 제목 > @username > 사람 이름', () => {
    const body = {
      result: [
        { message: { chat: { id: 42, type: 'private', first_name: 'Kim', last_name: 'DBA' } } },
        { my_chat_member: { chat: { id: -1001, type: 'supergroup', title: 'DB 알림방' } } },
        { channel_post: { chat: { id: -1002, type: 'channel', username: 'db_alerts' } } },
        { message: { chat: { id: 42, type: 'private', first_name: 'Kim' } } },
      ],
    };
    expect(chatsFromUpdates(body)).toEqual([
      { id: '42', type: 'private', name: 'Kim' },
      { id: '-1002', type: 'channel', name: '@db_alerts' },
      { id: '-1001', type: 'supergroup', name: 'DB 알림방' },
    ]);
    expect(chatsFromUpdates(null)).toEqual([]);
  });
});
