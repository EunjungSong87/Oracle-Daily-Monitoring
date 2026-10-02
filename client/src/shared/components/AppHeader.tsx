import type { MouseEvent, ReactElement } from 'react';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { useTheme } from '../hooks/useTheme';
import { logout } from '../lib/api';
import { NavIconSprite } from './NavIconSprite';

// 각 vanilla 페이지가 자기 nav 링크에 손으로 붙여놓던 nav-group-active/current를
// active prop 하나로 대체한다. 'users'는 계정 드롭다운 안에서만 등장하고 원본에서도
// 하이라이트되지 않으므로(전 페이지 공통으로 주입되는 링크라 페이지별 강조가 없었다)
// 매칭 조건이 없다 — 타입에는 포함해 users 페이지도 active="users"를 넘길 수 있게 한다.
export type ActivePage =
  | 'databases'
  | 'dailyMonitoring'
  | 'scripts'
  | 'thresholds'
  | 'history'
  | 'issues'
  | 'realtime'
  | 'tableSpec'
  | 'statsJob'
  | 'ilmJob'
  | 'objectCompare'
  | 'parameterCompare'
  | 'dataPump'
  | 'users';

const MAINTENANCE_GROUP: ActivePage[] = ['tableSpec', 'statsJob', 'ilmJob', 'dataPump'];
const COMPARE_GROUP: ActivePage[] = ['objectCompare', 'parameterCompare'];
const MONITORING_GROUP: ActivePage[] = ['dailyMonitoring', 'scripts', 'thresholds', 'history', 'issues', 'realtime'];
const DAILY_MONITORING_CHILDREN: ActivePage[] = ['scripts', 'thresholds', 'history', 'issues'];

interface Props {
  active: ActivePage;
}

// public/dailyMonitoring.html의 <header class="app-header"> 마크업 + common.js의
// injectAccountNav/injectThemeToggle을 React로 이식. 다른 vanilla 페이지들과 동일한
// 클래스명/구조를 그대로 써서 시각적으로 구분되지 않도록 한다.
export function AppHeader({ active }: Props): ReactElement {
  const { user } = useCurrentUser();
  const { theme, toggleTheme } = useTheme();

  const monitoringGroupActive = MONITORING_GROUP.includes(active);
  const dailyMonitoringExtra =
    active === 'dailyMonitoring' ? ' current' : DAILY_MONITORING_CHILDREN.includes(active) ? ' nav-group-active' : '';

  async function handleLogout(event: MouseEvent): Promise<void> {
    event.preventDefault();
    await logout();
    window.location.href = 'login.html';
  }

  return (
    <>
      <NavIconSprite />
      <header className="app-header">
        <a href="index.html" className="brand">
          <span className="brand-mark">
            <svg className="brand-icon" viewBox="0 0 32 32" aria-hidden="true">
              <ellipse cx={16} cy={11} rx={8.5} ry={3.2} fill="#fff" />
              <path
                d="M8 11v11.5c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V11"
                stroke="#fff"
                strokeWidth={2.3}
                opacity={0.6}
                fill="none"
              />
              <path
                d="M7 19.6h4.6l1.8-3.6 2.3 6 1.8-2.4h5.7"
                stroke="#fff"
                strokeWidth={2.3}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </span>
          DB Cockpit
        </a>

        <nav>
          <ul>
            <li>
              <a href="index.html" className={`nav-accent-1${active === 'databases' ? ' current' : ''}`}>
                <svg className="nav-icon" viewBox="0 0 16 16">
                  <use href="#ic-db" />
                </svg>
                Databases
              </a>
            </li>

            <li className="nav-dropdown">
              <a
                href="dailyMonitoring.html"
                className={`nav-accent-2 nav-dropdown-trigger${monitoringGroupActive ? ' nav-group-active' : ''}`}
              >
                <svg className="nav-icon" viewBox="0 0 16 16">
                  <use href="#ic-pulse" />
                </svg>
                Monitoring <span className="nav-caret">&#9662;</span>
              </a>
              <ul className="nav-dropdown-menu">
                <li className="nav-dropdown">
                  <a href="dailyMonitoring.html" className={`nav-accent-2 nav-dropdown-trigger${dailyMonitoringExtra}`}>
                    <span className="nav-label">
                      <svg className="nav-icon" viewBox="0 0 16 16">
                        <use href="#ic-play" />
                      </svg>
                      Daily Monitoring
                    </span>{' '}
                    <span className="nav-caret-sub">&#9656;</span>
                  </a>
                  <ul className="nav-dropdown-menu">
                    <li>
                      <a href="monitoringScript.html" className={`nav-accent-3${active === 'scripts' ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-code" />
                        </svg>
                        Scripts
                      </a>
                    </li>
                    <li>
                      <a
                        href="monitoringThresholds.html"
                        className={`nav-accent-4${active === 'thresholds' ? ' current' : ''}`}
                      >
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-gauge" />
                        </svg>
                        Thresholds
                      </a>
                    </li>
                    <li>
                      <a href="history.html" className={`nav-accent-5${active === 'history' ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-history" />
                        </svg>
                        Run History
                      </a>
                    </li>
                    <li>
                      <a href="issues.html" className={`nav-accent-6${active === 'issues' ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-issue" />
                        </svg>
                        Issues
                      </a>
                    </li>
                  </ul>
                </li>
                <li>
                  <a href="realtimeMonitoring.html" className={`nav-accent-9${active === 'realtime' ? ' current' : ''}`}>
                    <svg className="nav-icon" viewBox="0 0 16 16">
                      <use href="#ic-realtime" />
                    </svg>
                    Real-Time
                  </a>
                </li>
              </ul>
            </li>

            <li className="nav-dropdown">
              <a
                href="tableSpec.html"
                className={`nav-accent-7 nav-dropdown-trigger${MAINTENANCE_GROUP.includes(active) ? ' nav-group-active' : ''}`}
              >
                <svg className="nav-icon" viewBox="0 0 16 16">
                  <use href="#ic-wrench" />
                </svg>
                Maintenance <span className="nav-caret">&#9662;</span>
              </a>
              <ul className="nav-dropdown-menu">
                <li>
                  <a href="tableSpec.html" className={`nav-accent-7${active === 'tableSpec' ? ' current' : ''}`}>
                    <svg className="nav-icon" viewBox="0 0 16 16">
                      <use href="#ic-table" />
                    </svg>
                    Table Spec
                  </a>
                </li>
                {user?.role === 'SUPER_ADMIN' && (
                  <>
                    <li>
                      <a href="statsJob.html" className={`nav-accent-7${active === 'statsJob' ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-stats" />
                        </svg>
                        Stats Job Status
                      </a>
                    </li>
                    <li>
                      <a href="ilmJob.html" className={`nav-accent-7${active === 'ilmJob' ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-archive" />
                        </svg>
                        ILM Partition Retention
                      </a>
                    </li>
                    <li>
                      <a href="dataPump.html" className={`nav-accent-7${active === 'dataPump' ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-transfer" />
                        </svg>
                        Data Pump
                      </a>
                    </li>
                  </>
                )}
              </ul>
            </li>

            {/* 두 DB를 나란히 놓고 비교하는 화면 모음 — 전부 최고관리자 전용이라 메뉴 자체를 숨긴다. */}
            {user?.role === 'SUPER_ADMIN' && (
              <li className="nav-dropdown">
                <a
                  href="objectCompare.html"
                  className={`nav-accent-10 nav-dropdown-trigger${COMPARE_GROUP.includes(active) ? ' nav-group-active' : ''}`}
                >
                  <svg className="nav-icon" viewBox="0 0 16 16">
                    <use href="#ic-compare" />
                  </svg>
                  Compare <span className="nav-caret">&#9662;</span>
                </a>
                <ul className="nav-dropdown-menu">
                  <li>
                    <a href="objectCompare.html" className={`nav-accent-10${active === 'objectCompare' ? ' current' : ''}`}>
                      <svg className="nav-icon" viewBox="0 0 16 16">
                        <use href="#ic-table" />
                      </svg>
                      Object Compare
                    </a>
                  </li>
                  <li>
                    <a href="parameterCompare.html" className={`nav-accent-10${active === 'parameterCompare' ? ' current' : ''}`}>
                      <svg className="nav-icon" viewBox="0 0 16 16">
                        <use href="#ic-sliders" />
                      </svg>
                      Parameter Compare
                    </a>
                  </li>
                </ul>
              </li>
            )}

            {user && (
              <li className="nav-dropdown" id="account-nav-item">
                <a href="#" className="nav-accent-8 nav-dropdown-trigger" onClick={(e) => e.preventDefault()}>
                  <svg className="nav-icon" viewBox="0 0 16 16">
                    <use href="#ic-user" />
                  </svg>
                  {user.username} <span className="nav-caret">&#9662;</span>
                </a>
                <ul className="nav-dropdown-menu">
                  {user.role === 'SUPER_ADMIN' && (
                    <li>
                      <a className="nav-accent-8" href="users.html">
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-user" />
                        </svg>
                        Users
                      </a>
                    </li>
                  )}
                  <li>
                    <a className="nav-accent-8" href="#" onClick={handleLogout}>
                      <svg className="nav-icon" viewBox="0 0 16 16">
                        <use href="#ic-logout" />
                      </svg>
                      로그아웃
                    </a>
                  </li>
                </ul>
              </li>
            )}

            <li className="theme-toggle-item">
              <button
                type="button"
                id="theme-toggle-btn"
                className="theme-toggle-btn"
                onClick={toggleTheme}
                title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              >
                {theme === 'dark' ? '☀️' : '🌙'}
              </button>
            </li>
          </ul>
        </nav>
      </header>
    </>
  );
}
