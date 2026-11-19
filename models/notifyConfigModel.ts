import oracledb from 'oracledb';
import * as db from '../db';

// 알림 채널 설정 (메타데이터 DB의 system.notify_config — scripts/add_notify_config.sql). 행은 id=1 하나뿐.
// 토큰/웹훅/SMTP 비밀번호는 호출하는 쪽(services/notifyConfigService.ts)이 암호화한 값 그대로 저장·반환한다.

export interface NotifyConfigRow {
  telegramEnabled: boolean;
  telegramTokenEnc: string | null;
  telegramChatId: string | null;
  slackEnabled: boolean;
  slackWebhookEnc: string | null;
  mailEnabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpTlsInsecure: boolean;
  smtpUser: string | null;
  smtpPasswordEnc: string | null;
  mailFrom: string | null;
  mailTo: string | null; // 쉼표 구분
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
      `SELECT telegram_enabled, telegram_token_enc, telegram_chat_id, slack_enabled, slack_webhook_enc,
              mail_enabled, smtp_host, smtp_port, smtp_secure, smtp_tls_insecure, smtp_user, smtp_password_enc, mail_from, mail_to,
              updatetime, updated_by
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
      mailEnabled: row.MAIL_ENABLED === 'Y',
      smtpHost: row.SMTP_HOST ?? null,
      smtpPort: row.SMTP_PORT ?? null,
      smtpSecure: row.SMTP_SECURE === 'Y',
      smtpTlsInsecure: row.SMTP_TLS_INSECURE === 'Y',
      smtpUser: row.SMTP_USER ?? null,
      smtpPasswordEnc: row.SMTP_PASSWORD_ENC ?? null,
      mailFrom: row.MAIL_FROM ?? null,
      mailTo: row.MAIL_TO ?? null,
      updatetime: row.UPDATETIME ?? null,
      updatedBy: row.UPDATED_BY ?? null,
    };
  });
}

async function saveConfig(row: Omit<NotifyConfigRow, 'updatetime'>): Promise<void> {
  const yn = (value: boolean): string => (value ? 'Y' : 'N');
  await withPool(async (connection) => {
    await connection.execute(
      `MERGE INTO system.notify_config t
        USING (SELECT 1 id FROM dual) s
           ON (t.id = s.id)
         WHEN MATCHED THEN UPDATE SET
              telegram_enabled = :tgEnabled, telegram_token_enc = :tgToken, telegram_chat_id = :tgChatId,
              slack_enabled = :slEnabled, slack_webhook_enc = :slWebhook,
              mail_enabled = :mlEnabled, smtp_host = :smtpHost, smtp_port = :smtpPort, smtp_secure = :smtpSecure,
              smtp_tls_insecure = :smtpTlsInsecure, smtp_user = :smtpUser, smtp_password_enc = :smtpPassword,
              mail_from = :mailFrom, mail_to = :mailTo,
              updatetime = TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'), updated_by = :updatedBy
         WHEN NOT MATCHED THEN INSERT
              (id, telegram_enabled, telegram_token_enc, telegram_chat_id, slack_enabled, slack_webhook_enc,
               mail_enabled, smtp_host, smtp_port, smtp_secure, smtp_tls_insecure, smtp_user, smtp_password_enc, mail_from, mail_to,
               updatetime, updated_by)
              VALUES (1, :tgEnabled, :tgToken, :tgChatId, :slEnabled, :slWebhook,
               :mlEnabled, :smtpHost, :smtpPort, :smtpSecure, :smtpTlsInsecure, :smtpUser, :smtpPassword, :mailFrom, :mailTo,
               TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'), :updatedBy)`,
      {
        tgEnabled: yn(row.telegramEnabled),
        tgToken: row.telegramTokenEnc,
        tgChatId: row.telegramChatId,
        slEnabled: yn(row.slackEnabled),
        slWebhook: row.slackWebhookEnc,
        mlEnabled: yn(row.mailEnabled),
        smtpHost: row.smtpHost,
        smtpPort: row.smtpPort,
        smtpSecure: yn(row.smtpSecure),
        smtpTlsInsecure: yn(row.smtpTlsInsecure),
        smtpUser: row.smtpUser,
        smtpPassword: row.smtpPasswordEnc,
        mailFrom: row.mailFrom,
        mailTo: row.mailTo,
        updatedBy: row.updatedBy,
      }
    );
    await connection.commit();
  });
}

export { getConfig, saveConfig };
