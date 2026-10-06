import type { MouseEvent, ReactElement } from 'react';
import { canSee, useCurrentUser } from '../hooks/useCurrentUser';
import { useTheme } from '../hooks/useTheme';
import { logout } from '../lib/api';
import type { ScreenKey } from '../lib/types';
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

interface NavItem {
  key: ScreenKey;
  href: string;
  label: string;
  icon: string;
  accent: string;
}

const DAILY_MONITORING_ITEMS: NavItem[] = [
  { key: 'scripts', href: 'monitoringScript.html', label: 'Scripts', icon: '#ic-code', accent: 'nav-accent-3' },
  { key: 'thresholds', href: 'monitoringThresholds.html', label: 'Thresholds', icon: '#ic-gauge', accent: 'nav-accent-4' },
  { key: 'history', href: 'history.html', label: 'Run History', icon: '#ic-history', accent: 'nav-accent-5' },
  { key: 'issues', href: 'issues.html', label: 'Issues', icon: '#ic-issue', accent: 'nav-accent-6' },
];

const MAINTENANCE_ITEMS: NavItem[] = [
  { key: 'tableSpec', href: 'tableSpec.html', label: 'Table Spec', icon: '#ic-table', accent: 'nav-accent-7' },
  { key: 'statsJob', href: 'statsJob.html', label: 'Stats Job Status', icon: '#ic-stats', accent: 'nav-accent-7' },
  { key: 'ilmJob', href: 'ilmJob.html', label: 'ILM Partition Retention', icon: '#ic-archive', accent: 'nav-accent-7' },
  { key: 'dataPump', href: 'dataPump.html', label: 'Data Pump', icon: '#ic-transfer', accent: 'nav-accent-7' },
];

const COMPARE_ITEMS: NavItem[] = [
  { key: 'objectCompare', href: 'objectCompare.html', label: 'Object Compare', icon: '#ic-table', accent: 'nav-accent-10' },
  { key: 'parameterCompare', href: 'parameterCompare.html', label: 'Parameter Compare', icon: '#ic-sliders', accent: 'nav-accent-10' },
];

interface Props {
  active: ActivePage;
}

// public/dailyMonitoring.html의 <header class="app-header"> 마크업 + common.js의
// injectAccountNav/injectThemeToggle을 React로 이식. 다른 vanilla 페이지들과 동일한
// 클래스명/구조를 그대로 써서 시각적으로 구분되지 않도록 한다.
export function AppHeader({ active }: Props): ReactElement {
  const { user } = useCurrentUser();
  const { theme, toggleTheme } = useTheme();

  // 메뉴는 이 사용자에게 보이는 화면만 (역할 기본 + 계정 관리의 사용자별 예외). 그룹은 보이는 항목이 하나도 없으면
  // 통째로 빠지고, 그룹 머리의 링크는 그 안에서 처음 보이는 화면으로 간다. 사용자 정보를 읽기 전에는 비워 둔다.
  const show = (key: ScreenKey): boolean => canSee(user, key);
  const visibleItems = (items: NavItem[]): NavItem[] => items.filter((item) => show(item.key));
  const dailyChildren = visibleItems(DAILY_MONITORING_ITEMS);
  const maintenanceItems = visibleItems(MAINTENANCE_ITEMS);
  const compareItems = visibleItems(COMPARE_ITEMS);
  const dailyHref = show('dailyMonitoring') ? 'dailyMonitoring.html' : dailyChildren[0]?.href;
  const monitoringHref = dailyHref ?? (show('realtime') ? 'realtimeMonitoring.html' : undefined);

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
            {show('databases') && (
              <li>
                <a href="index.html" className={`nav-accent-1${active === 'databases' ? ' current' : ''}`}>
                  <svg className="nav-icon" viewBox="0 0 16 16">
                    <use href="#ic-db" />
                  </svg>
                  Databases
                </a>
              </li>
            )}

            {monitoringHref && (
              <li className="nav-dropdown">
                <a href={monitoringHref} className={`nav-accent-2 nav-dropdown-trigger${monitoringGroupActive ? ' nav-group-active' : ''}`}>
                  <svg className="nav-icon" viewBox="0 0 16 16">
                    <use href="#ic-pulse" />
                  </svg>
                  Monitoring <span className="nav-caret">&#9662;</span>
                </a>
                <ul className="nav-dropdown-menu">
                  {dailyHref && (
                    <li className={dailyChildren.length > 0 ? 'nav-dropdown' : undefined}>
                      <a
                        href={dailyHref}
                        className={`nav-accent-2${dailyChildren.length > 0 ? ' nav-dropdown-trigger' : ''}${dailyMonitoringExtra}`}
                      >
                        <span className="nav-label">
                          <svg className="nav-icon" viewBox="0 0 16 16">
                            <use href="#ic-play" />
                          </svg>
                          Daily Monitoring
                        </span>{' '}
                        {dailyChildren.length > 0 && <span className="nav-caret-sub">&#9656;</span>}
                      </a>
                      {dailyChildren.length > 0 && (
                        <ul className="nav-dropdown-menu">
                          {dailyChildren.map((item) => (
                            <li key={item.key}>
                              <a href={item.href} className={`${item.accent}${active === item.key ? ' current' : ''}`}>
                                <svg className="nav-icon" viewBox="0 0 16 16">
                                  <use href={item.icon} />
                                </svg>
                                {item.label}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )}
                  {show('realtime') && (
                    <li>
                      <a href="realtimeMonitoring.html" className={`nav-accent-9${active === 'realtime' ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href="#ic-realtime" />
                        </svg>
                        Real-Time
                      </a>
                    </li>
                  )}
                </ul>
              </li>
            )}

            {maintenanceItems.length > 0 && (
              <li className="nav-dropdown">
                <a
                  href={maintenanceItems[0].href}
                  className={`nav-accent-7 nav-dropdown-trigger${MAINTENANCE_GROUP.includes(active) ? ' nav-group-active' : ''}`}
                >
                  <svg className="nav-icon" viewBox="0 0 16 16">
                    <use href="#ic-wrench" />
                  </svg>
                  Maintenance <span className="nav-caret">&#9662;</span>
                </a>
                <ul className="nav-dropdown-menu">
                  {maintenanceItems.map((item) => (
                    <li key={item.key}>
                      <a href={item.href} className={`${item.accent}${active === item.key ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href={item.icon} />
                        </svg>
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            )}

            {/* 두 DB를 나란히 놓고 비교하는 화면 모음 — 기본은 최고관리자 화면. */}
            {compareItems.length > 0 && (
              <li className="nav-dropdown">
                <a
                  href={compareItems[0].href}
                  className={`nav-accent-10 nav-dropdown-trigger${COMPARE_GROUP.includes(active) ? ' nav-group-active' : ''}`}
                >
                  <svg className="nav-icon" viewBox="0 0 16 16">
                    <use href="#ic-compare" />
                  </svg>
                  Compare <span className="nav-caret">&#9662;</span>
                </a>
                <ul className="nav-dropdown-menu">
                  {compareItems.map((item) => (
                    <li key={item.key}>
                      <a href={item.href} className={`${item.accent}${active === item.key ? ' current' : ''}`}>
                        <svg className="nav-icon" viewBox="0 0 16 16">
                          <use href={item.icon} />
                        </svg>
                        {item.label}
                      </a>
                    </li>
                  ))}
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
