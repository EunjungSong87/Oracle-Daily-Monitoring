import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { PageHeader } from '../../shared/components/PageHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { findTelegramChats, getNotifyConfig, saveNotifyConfig, testNotify } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { NotifyChannelResult, NotifyConfigInput, NotifyConfigView, TelegramChat } from '../../shared/lib/types';

const CHANNEL_LABELS: Record<NotifyChannelResult['channel'], string> = { telegram: 'Telegram', slack: 'Slack', mail: '메일' };

type MailForm = NotifyConfigInput['mail'];

function mailFormOf(view: NotifyConfigView): MailForm {
  const m = view.mail;
  return { enabled: m.enabled, host: m.host ?? '', port: String(m.port), secure: m.secure, tlsInsecure: m.tlsInsecure, user: m.user ?? '', password: '', from: m.from ?? '', to: m.to.join(', ') };
}

function formatDate(s: string | null): string {
  if (!s || s.length < 14) return s || '-';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// 계정 > 알림 설정 (최고관리자 전용). 신규/재오픈 Issues 티켓 알림을 보낼 Telegram/Slack/사내 메일 채널.
// 서버는 비밀값(봇 토큰/웹훅 URL/SMTP 비밀번호)을 내려주지 않는다 — 칸을 비워 두면 저장된 값 유지, 새로 넣으면 교체.
export function App(): ReactElement {
  const { user, loading } = useCurrentUser();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  const [view, setView] = useState<NotifyConfigView | null>(null);
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgToken, setTgToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [slEnabled, setSlEnabled] = useState(false);
  const [slWebhook, setSlWebhook] = useState('');
  const [mail, setMail] = useState<MailForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResults, setTestResults] = useState<NotifyChannelResult[] | null>(null);
  const [chats, setChats] = useState<TelegramChat[] | null>(null);

  const load = useCallback(() => {
    getNotifyConfig()
      .then((next) => {
        setView(next);
        setTgEnabled(next.telegram.enabled);
        setTgChatId(next.telegram.chatId ?? '');
        setTgToken('');
        setSlEnabled(next.slack.enabled);
        setSlWebhook('');
        setMail(mailFormOf(next));
      })
      .catch((error) => showToast(errorMessage(error, '알림 설정 조회 실패'), 'error'));
  }, []);

  useEffect(() => {
    if (isSuperAdmin) load();
  }, [isSuperAdmin, load]);

  function input(): NotifyConfigInput {
    return {
      telegram: { enabled: tgEnabled, token: tgToken.trim(), chatId: tgChatId.trim() },
      slack: { enabled: slEnabled, webhookUrl: slWebhook.trim() },
      mail: mail ?? mailFormOf(view!),
    };
  }

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  const handleSave = (): Promise<void> =>
    run(async () => {
      try {
        await saveNotifyConfig(input());
        showToast('알림 설정을 저장했습니다.');
        setTestResults(null);
        load();
      } catch (error) {
        showToast(errorMessage(error, '알림 설정 저장 실패'), 'error');
      }
    });

  const handleTest = (): Promise<void> =>
    run(async () => {
      setTestResults(null);
      try {
        setTestResults(await testNotify(input()));
      } catch (error) {
        showToast(errorMessage(error, '테스트 발송 실패'), 'error');
      }
    });

  const handleFindChats = (): Promise<void> =>
    run(async () => {
      setChats(null);
      try {
        setChats(await findTelegramChats(tgToken.trim()));
      } catch (error) {
        showToast(errorMessage(error, 'Telegram 대화방 조회 실패'), 'error');
      }
    });

  const setMailField = (patch: Partial<MailForm>): void => setMail((current) => (current ? { ...current, ...patch } : current));

  const canTelegramLookup =!!tgToken.trim() || !!view?.telegram.tokenSet;

  return (
    <>
      <AppHeader active="notify" />
      <ToastHost />
      <PageHeader section="Account" title="알림 설정" description="이슈 티켓이 새로 생기거나 다시 열릴 때 알림을 보낼 Telegram · Slack · 메일 채널을 설정합니다." />

      {!loading && !isSuperAdmin && <p className="issues-empty">최고관리자만 볼 수 있는 화면입니다.</p>}

      {isSuperAdmin && view && (
        <>
          <div className="rt-panel">
            <p className="oc-hint" style={{ marginTop: 0 }}>
              Daily Monitoring 점검에서 Issues 티켓이 새로 생기거나 다시 열리면 켜 둔 채널로 알림을 보냅니다.{' '}
              {view.source === 'db'
                ? `현재 이 화면에서 저장한 값으로 동작합니다 (마지막 저장: ${formatDate(view.updatetime)}${view.updatedBy ? `, ${view.updatedBy}` : ''}).`
                : '아직 저장한 적이 없어 .env 값(TELEGRAM_* / SLACK_WEBHOOK_URL / SMTP_* / MAIL_*)으로 동작합니다. 저장하면 이후로는 이 화면 값이 우선합니다.'}
            </p>
            {!view.available && (
              <p className="pc-warning">
                저장할 수 없습니다 — {view.unavailableReason}. 실행 후 앱 서버를 재시작해야 반영됩니다 (그 전까지는 .env 값으로 동작, 테스트 발송은 가능).
              </p>
            )}
          </div>

          {mail && (
            <div className="rt-panel">
              <h3>
                <label style={{ display: 'inline', fontWeight: 'inherit' }}>
                  <input type="checkbox" checked={mail.enabled} onChange={(e) => setMailField({ enabled: e.target.checked })} /> 사내 메일 (SMTP)
                </label>
              </h3>
              <div className="dp-grid">
                <div>
                  <label htmlFor="nt-ml-host">SMTP 서버</label>
                  <input id="nt-ml-host" type="text" placeholder="mail.company.local 또는 IP" value={mail.host} onChange={(e) => setMailField({ host: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="nt-ml-port">포트</label>
                  <input id="nt-ml-port" type="number" min={1} max={65535} placeholder="25" value={mail.port} onChange={(e) => setMailField({ port: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="nt-ml-user">계정 (인증 없는 릴레이면 비움)</label>
                  <input id="nt-ml-user" type="text" autoComplete="off" value={mail.user} onChange={(e) => setMailField({ user: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="nt-ml-password">비밀번호</label>
                  <input
                    id="nt-ml-password"
                    type="password"
                    autoComplete="new-password"
                    disabled={!mail.user.trim()}
                    placeholder={view.mail.passwordSet && mail.user.trim() === (view.mail.user ?? '') ? '저장됨 — 바꿀 때만 입력' : ''}
                    value={mail.password}
                    onChange={(e) => setMailField({ password: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="nt-ml-from">보내는 사람</label>
                  <input id="nt-ml-from" type="text" placeholder="dbcockpit@company.local" value={mail.from} onChange={(e) => setMailField({ from: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="nt-ml-to">받는 사람 (쉼표로 여러 명, 최대 20)</label>
                  <input id="nt-ml-to" type="text" placeholder="dba1@company.local, dba2@company.local" value={mail.to} onChange={(e) => setMailField({ to: e.target.value })} />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <label style={{ display: 'inline', fontWeight: 'normal' }}>
                  <input type="checkbox" checked={mail.secure} onChange={(e) => setMailField({ secure: e.target.checked })} /> 접속부터 TLS (보통 465 포트)
                </label>{' '}
                <label style={{ display: 'inline', fontWeight: 'normal', marginLeft: 16 }}>
                  <input type="checkbox" checked={mail.tlsInsecure} onChange={(e) => setMailField({ tlsInsecure: e.target.checked })} /> 인증서 검증 생략 (사설 인증서)
                </label>
              </div>
              <p className="oc-hint">
                사내 메일 서버 담당자에게 SMTP 릴레이 주소/포트와, 앱 서버 IP에서 인증 없이 보낼 수 있는지(아니면 발송용 계정)를 확인하세요. 25/587 포트는 TLS 체크를
                끈 채로 두면 서버가 지원할 때만 STARTTLS로 암호화합니다.
              </p>
            </div>
          )}

          <div className="rt-panel">
            <h3>
              <label style={{ display: 'inline', fontWeight: 'inherit' }}>
                <input type="checkbox" checked={tgEnabled} onChange={(e) => setTgEnabled(e.target.checked)} /> Telegram
              </label>
            </h3>
            <div className="dp-grid">
              <div>
                <label htmlFor="nt-tg-token">봇 토큰</label>
                <input
                  id="nt-tg-token"
                  type="password"
                  autoComplete="off"
                  placeholder={view.telegram.tokenSet ? '저장됨 — 바꿀 때만 입력' : '123456789:AA...'}
                  value={tgToken}
                  onChange={(e) => setTgToken(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="nt-tg-chat">chat_id</label>
                <input id="nt-tg-chat" type="text" placeholder="숫자(그룹은 -로 시작) 또는 @채널이름" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} />
              </div>
            </div>
            <div className="oc-actions">
              <button type="button" className="btn-secondary" onClick={handleFindChats} disabled={busy || !canTelegramLookup}>
                chat_id 찾기
              </button>
            </div>
            <p className="oc-hint">
              @BotFather로 봇을 만들어 토큰을 받고, 알림 받을 대화방에서 봇에게 메시지를 보내거나(그룹이면 봇 초대 후 아무 메시지) 한 뒤 &quot;chat_id 찾기&quot;를
              누르세요. 최근 24시간 안에 봇이 받은 메시지 기준입니다.
            </p>
            {chats &&
              (chats.length === 0 ? (
                <p className="issues-empty">찾은 대화방이 없습니다. 봇에게 먼저 메시지를 보낸 뒤 다시 시도하세요.</p>
              ) : (
                <table className="table oc-items-table">
                  <thead>
                    <tr>
                      <th>대화방</th>
                      <th>종류</th>
                      <th>chat_id</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {chats.map((chat) => (
                      <tr key={chat.id}>
                        <td>{chat.name || '-'}</td>
                        <td>{chat.type}</td>
                        <td>{chat.id}</td>
                        <td>
                          <button type="button" className="btn-secondary" onClick={() => setTgChatId(chat.id)}>
                            사용
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
          </div>

          <div className="rt-panel">
            <h3>
              <label style={{ display: 'inline', fontWeight: 'inherit' }}>
                <input type="checkbox" checked={slEnabled} onChange={(e) => setSlEnabled(e.target.checked)} /> Slack
              </label>
            </h3>
            <div className="dp-grid">
              <div>
                <label htmlFor="nt-sl-webhook">Incoming Webhook URL</label>
                <input
                  id="nt-sl-webhook"
                  type="password"
                  autoComplete="off"
                  placeholder={view.slack.webhookSet ? '저장됨 — 바꿀 때만 입력' : 'https://hooks.slack.com/services/...'}
                  value={slWebhook}
                  onChange={(e) => setSlWebhook(e.target.value)}
                />
              </div>
            </div>
            <p className="oc-hint">Slack 앱에서 Incoming Webhooks를 켜고 알림 받을 채널용 URL을 발급받아 넣으세요.</p>
          </div>

          <div className="rt-panel">
            <div className="oc-actions" style={{ marginTop: 0 }}>
              <button type="button" onClick={handleSave} disabled={busy || !view.available}>
                저장
              </button>{' '}
              <button type="button" className="btn-secondary" onClick={handleTest} disabled={busy || (!tgEnabled && !slEnabled && !mail?.enabled)}>
                테스트 발송
              </button>
            </div>
            <p className="oc-hint">테스트 발송은 저장하지 않은 지금 입력값(비워 둔 비밀값은 저장된 값)으로 켜 둔 채널에 보냅니다.</p>
            {testResults && (
              <ul>
                {testResults.map((result) => (
                  <li key={result.channel} style={{ color: result.ok ? undefined : 'var(--danger)' }}>
                    {CHANNEL_LABELS[result.channel]}: {result.ok ? '✅ ' : '❌ '}
                    {result.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  );
}
