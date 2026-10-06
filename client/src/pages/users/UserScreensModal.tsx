import { useEffect, useState, type ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { getUserScreens, saveUserScreens } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { Role, ScreenKey, UserScreenSetting, UserSummary } from '../../shared/lib/types';

interface Props {
  user: UserSummary | null;
  onClose: () => void;
}

type Choice = 'DEFAULT' | 'SHOW' | 'HIDE';

const ROLE_SHORT: Record<Role, string> = { VIEWER: 'Viewer', DBA: 'DBA', SUPER_ADMIN: 'Super Admin' };

function toChoice(override: boolean | null): Choice {
  return override === null ? 'DEFAULT' : override ? 'SHOW' : 'HIDE';
}

// 화면 권한: 역할이 정한 기본값 위에 이 사용자만 보이게/숨김. 숨긴 화면은 메뉴/페이지/API 모두 막힌다.
// 저장하면 바로 적용된다 (그 사용자가 다음에 화면을 열 때부터, 다시 로그인할 필요 없음).
export function UserScreensModal({ user, onClose }: Props): ReactElement | null {
  const [screens, setScreens] = useState<UserScreenSetting[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [choices, setChoices] = useState<Partial<Record<ScreenKey, Choice>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setScreens(null);
    getUserScreens(user.id)
      .then((result) => {
        if (cancelled) return;
        setScreens(result.screens);
        setAvailable(result.available);
        setChoices(Object.fromEntries(result.screens.map((screen) => [screen.key, toChoice(screen.override)])));
      })
      .catch((error) => {
        console.error('Error loading screen access:', error);
        showToast(error instanceof Error ? error.message : '화면 권한 조회 실패', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) return null;

  function effective(screen: UserScreenSetting): boolean {
    const choice = choices[screen.key] ?? 'DEFAULT';
    return choice === 'DEFAULT' ? screen.roleDefault : choice === 'SHOW';
  }

  async function save(): Promise<void> {
    if (!user || !screens) return;
    setSaving(true);
    try {
      const payload = Object.fromEntries(
        screens.map((screen) => {
          const choice = choices[screen.key] ?? 'DEFAULT';
          return [screen.key, choice === 'DEFAULT' ? null : choice === 'SHOW'];
        })
      );
      await saveUserScreens(user.id, payload);
      showToast(`${user.username}의 화면 권한을 저장했습니다.`);
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '화면 권한 저장 실패', 'error');
    } finally {
      setSaving(false);
    }
  }

  const visibleCount = screens?.filter(effective).length ?? 0;

  return (
    <Modal open onClose={onClose} title={`화면 권한 — ${user.username} (${ROLE_SHORT[user.role]})`} wide="xl">
      <div className="modal-body">
        <p className="oc-hint">
          기본은 역할이 정합니다. 이 사용자만 다르게 둘 화면을 "보이기"/"숨기기"로 바꾸세요. 숨긴 화면은 메뉴에서 빠지고 주소로 들어와도
          막힙니다. 저장하면 다시 로그인하지 않아도 다음 화면 이동부터 적용됩니다. 계정 관리(Users)는 항상 Super Admin 전용입니다.
        </p>
        {!available && (
          <p className="pc-warning">화면 권한 테이블이 없어 저장할 수 없습니다. 메타데이터 DB에 scripts/add_user_screen_access.sql을 실행하세요.</p>
        )}
        {!screens && <p className="oc-detail-note">읽는 중...</p>}
        {screens && (
          <table className="table oc-items-table">
            <thead>
              <tr>
                <th>메뉴</th>
                <th>화면</th>
                <th>역할 기본</th>
                <th>이 사용자</th>
                <th>결과</th>
              </tr>
            </thead>
            <tbody>
              {screens.map((screen) => {
                const visible = effective(screen);
                const widened = visible && !screen.roleDefault;
                return (
                  <tr key={screen.key}>
                    <td className="oc-subtle">{screen.group}</td>
                    <td>{screen.label}</td>
                    <td>
                      {screen.roleDefault ? '보임' : '숨김'}
                      <div className="dp-hint-line">{ROLE_SHORT[screen.defaultRole]} 이상</div>
                    </td>
                    <td>
                      <select
                        value={choices[screen.key] ?? 'DEFAULT'}
                        disabled={!available}
                        onChange={(e) => setChoices((current) => ({ ...current, [screen.key]: e.target.value as Choice }))}
                      >
                        <option value="DEFAULT">역할 기본값</option>
                        <option value="SHOW">보이기</option>
                        <option value="HIDE">숨기기</option>
                      </select>
                    </td>
                    <td>
                      <span className={`issue-badge ${visible ? 'oc-badge-SAME' : 'oc-badge-DIFF'}`}>{visible ? '보임' : '숨김'}</span>
                      {widened && (
                        <span className="oc-info-tag" title="역할 기본으로는 안 보이는 화면을 이 사용자에게 엽니다 (그 화면의 기능을 모두 쓸 수 있음).">
                          역할보다 넓음
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="rt-modal-toolbar">
          <span className="rt-modal-meta">
            보이는 화면 {visibleCount}개 / {screens?.length ?? 0}개
          </span>
          <div>
            <button type="button" disabled={!screens || !available || saving} onClick={save}>
              {saving ? '저장 중...' : '저장'}
            </button>{' '}
            <button type="button" className="btn-secondary" onClick={onClose}>
              취소
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
