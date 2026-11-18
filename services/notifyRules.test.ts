import { describe, expect, it } from 'vitest';
import { channelsOf, chatsFromUpdates, EMPTY_SETTINGS, mergeSettings, NotifyValidationError, pickTelegramToken, settingsFromEnv } from './notifyRules';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnn';
const SAVED = { telegramEnabled: true, telegramToken: TOKEN, telegramChatId: '-1001', slackEnabled: true, slackWebhookUrl: 'https://hooks.slack.com/x' };

describe('settingsFromEnv', () => {
  it('값이 있는 채널만 켠다', () => {
    expect(settingsFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: ' 42 ' })).toEqual({
      telegramEnabled: true,
      telegramToken: TOKEN,
      telegramChatId: '42',
      slackEnabled: false,
      slackWebhookUrl: null,
    });
    expect(settingsFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toMatchObject({ telegramEnabled: false });
    expect(settingsFromEnv({})).toEqual(EMPTY_SETTINGS);
  });
});

describe('channelsOf', () => {
  it('켜져 있고 값이 다 있는 채널만', () => {
    expect(channelsOf(SAVED)).toEqual({ telegram: { token: TOKEN, chatId: '-1001' }, slack: { url: 'https://hooks.slack.com/x' } });
    expect(channelsOf({ ...SAVED, telegramEnabled: false, slackWebhookUrl: null })).toEqual({ telegram: null, slack: null });
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
