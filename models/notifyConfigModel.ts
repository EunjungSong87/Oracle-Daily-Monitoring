import oracledb from 'oracledb';
import * as db from '../db';

// 알림 채널 설정 (메타데이터 DB의 system.notify_config — scripts/add_notify_config.sql). 행은 id=1 하나뿐.
// 토큰/웹훅은 호출하는 쪽(services/notifyConfigService.ts)이 암호화한 값 그대로 저장·반환한다.

export interface NotifyConfigRow {
  telegramEnabled: boolean;
  telegramTokenEnc: string | null;
  telegramChatId: string | null;
  slackEnabled: boolean;
  slackWebhookEnc: string | null;
  updatetime: string | null;
  updatedBy: string | null;
}

async function withPool<T>(work: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
  let connection: oracledb.Connection | undefined;
  try {
    const pool = await db.initializeDB();
    connection = await pool.getConnection();
    return await work(connection);
  } finally {
    if (connection) await connection.close();
  }
}

async function getConfig(): Promise<NotifyConfigRow | null> {
  return withPool(async (connection) => {
    const result = await connection.execute<Record<string, any>>(
      `SELECT telegram_enabled, telegram_token_enc, telegram_chat_id, slack_enabled, slack_webhook_enc, updatetime, updated_by
         FROM system.notify_config
        WHERE id = 1`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const row = result.rows?.[0];
    if (!row) return null;
    return {
      telegramEnabled: row.TELEGRAM_ENABLED === 'Y',
      telegramTokenEnc: row.TELEGRAM_TOKEN_ENC ?? null,
      telegramChatId: row.TELEGRAM_CHAT_ID ?? null,
      slackEnabled: row.SLACK_ENABLED === 'Y',
      slackWebhookEnc: row.SLACK_WEBHOOK_ENC ?? null,
      updatetime: row.UPDATETIME ?? null,
      updatedBy: row.UPDATED_BY ?? null,
    };
  });
}

async function saveConfig(row: Omit<NotifyConfigRow, 'updatetime'>): Promise<void> {
  await withPool(async (connection) => {
    await connection.execute(
      `MERGE INTO system.notify_config t
        USING (SELECT 1 id FROM dual) s
           ON (t.id = s.id)
         WHEN MATCHED THEN UPDATE SET
              telegram_enabled = :tgEnabled, telegram_token_enc = :tgToken, telegram_chat_id = :tgChatId,
              slack_enabled = :slEnabled, slack_webhook_enc = :slWebhook,
              updatetime = TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'), updated_by = :updatedBy
         WHEN NOT MATCHED THEN INSERT
              (id, telegram_enabled, telegram_token_enc, telegram_chat_id, slack_enabled, slack_webhook_enc, updatetime, updated_by)
              VALUES (1, :tgEnabled, :tgToken, :tgChatId, :slEnabled, :slWebhook, TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'), :updatedBy)`,
      {
        tgEnabled: row.telegramEnabled ? 'Y' : 'N',
        tgToken: row.telegramTokenEnc,
        tgChatId: row.telegramChatId,
        slEnabled: row.slackEnabled ? 'Y' : 'N',
        slWebhook: row.slackWebhookEnc,
        updatedBy: row.updatedBy,
      }
    );
    await connection.commit();
  });
}

export { getConfig, saveConfig };
