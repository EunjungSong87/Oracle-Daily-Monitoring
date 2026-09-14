// common.js — 모든 화면에서 공통으로 쓰는 토스트 알림 유틸

// ── 다크/라이트 모드 ──────────────────────────────────────────────────────
// <script>가 <head>에서 동기 실행되므로, body가 그려지기 전에 곧바로
// data-theme을 세팅해 깜빡임(FOUC) 없이 저장된(또는 OS) 테마로 시작한다.
const THEME_STORAGE_KEY = 'theme';

function getPreferredTheme() {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    updateThemeToggleButton();
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'light' : 'dark');
}

function updateThemeToggleButton() {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.title = isDark ? '라이트 모드로 전환' : '다크 모드로 전환';
}

// nav가 있는 페이지라면 nav 맨 끝에 토글 버튼을 자동으로 붙인다 (각 HTML을
// 일일이 수정할 필요 없이 common.js 한 곳에서 관리).
function injectThemeToggle() {
    const navList = document.querySelector('nav ul');
    if (!navList || document.getElementById('theme-toggle-btn')) return;

    const li = document.createElement('li');
    li.className = 'theme-toggle-item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'theme-toggle-btn';
    btn.className = 'theme-toggle-btn';
    btn.onclick = toggleTheme;

    li.appendChild(btn);
    navList.appendChild(li);
    updateThemeToggleButton();
}

// ── nav 아이콘 스프라이트 ──────────────────────────────────────────────────
// nav 링크마다 쓰는 아이콘들을 <symbol> 없이 <g id="...">로 한 번만 정의해두고,
// 각 페이지의 nav에서는 <svg class="nav-icon"><use href="#ic-xxx"></use></svg>로
// 참조한다 (HTML마다 아이콘 정의를 중복해서 넣지 않아도 됨). currentColor를 써서
// nav 링크 글자색(평소/호버/현재 페이지)을 그대로 따라간다.
const NAV_ICON_SPRITE = `
    <defs>
        <g id="ic-db" fill="none"><ellipse cx="8" cy="4.3" rx="5.2" ry="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.8 4.3v7.4c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V4.3" stroke="currentColor" stroke-width="1.3"/><path d="M2.8 8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2" stroke="currentColor" stroke-width="1.3"/></g>
        <g id="ic-pulse" fill="none"><path d="M1.5 8.4h3l1.4-3.6 2 6.8 1.6-4.6 1.1 1.4h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>
        <g id="ic-play" fill="none"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 5.4l4 2.6-4 2.6z" fill="currentColor"/></g>
        <g id="ic-code" fill="none"><path d="M5.6 4.2L2 8l3.6 3.8M10.4 4.2L14 8l-3.6 3.8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></g>
        <g id="ic-gauge" fill="none"><path d="M3 11 A5.4 5.4 0 1 1 13 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.65"/><line x1="8" y1="9.6" x2="10.8" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="9.6" r="1.05" fill="currentColor"/></g>
        <g id="ic-history" fill="none"><circle cx="8" cy="8.4" r="5.6" stroke="currentColor" stroke-width="1.3"/><path d="M8 5.2v3.4l2.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.6 3.6v2.6h2.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></g>
        <g id="ic-issue" fill="none"><path d="M8 2.4l6.2 10.8H1.8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="8" y1="6.6" x2="8" y2="9.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.3" r="0.85" fill="currentColor"/></g>
        <g id="ic-wrench" fill="none"><path d="M10.3 2.7a3 3 0 0 0-3.9 3.8L2 11l2 2 4.5-4.4a3 3 0 0 0 3.8-3.9l-2 2-1.6-.4-.4-1.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></g>
        <g id="ic-table" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.6" stroke="currentColor" stroke-width="1.3"/><line x1="2" y1="6.6" x2="14" y2="6.6" stroke="currentColor" stroke-width="1.1"/><line x1="7.6" y1="6.6" x2="7.6" y2="13" stroke="currentColor" stroke-width="1.1"/></g>
        <g id="ic-user" fill="none"><circle cx="8" cy="5.3" r="2.6" stroke="currentColor" stroke-width="1.3"/><path d="M2.6 13.2c0-3 2.4-5 5.4-5s5.4 2 5.4 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></g>
        <g id="ic-logout" fill="none"><path d="M6.4 2.6H3.6a1 1 0 0 0-1 1v8.8a1 1 0 0 0 1 1h2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 5.2 12.8 8l-3.3 2.8M12.8 8H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></g>
    </defs>
`;

function injectIconSprite() {
    if (document.getElementById('nav-icon-sprite')) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'nav-icon-sprite';
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    svg.innerHTML = NAV_ICON_SPRITE;
    document.body.appendChild(svg);
}

// nav 맨 끝에 "로그인 사용자명 ▾ (로그아웃, 관리자면 Users)" 드롭다운을 붙인다.
// nav가 없는 페이지(로그인 페이지)에서는 조용히 아무 것도 하지 않는다.
function buildAccountMenuLink(iconId, label, href, onClick) {
    const itemLi = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'nav-accent-8';
    link.href = href || '#';

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'nav-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + iconId);
    icon.appendChild(use);
    link.appendChild(icon);
    link.appendChild(document.createTextNode(label));

    if (onClick) link.onclick = onClick;
    itemLi.appendChild(link);
    return itemLi;
}

async function logoutAndRedirect(event) {
    event.preventDefault();
    try {
        await fetch('/auth/logout', { method: 'POST' });
    } catch (error) {
        console.error('로그아웃 실패:', error);
    }
    window.location.href = 'login.html';
}

async function injectAccountNav() {
    const navList = document.querySelector('nav ul');
    if (!navList || document.getElementById('account-nav-item')) return;

    let me;
    try {
        const response = await fetch('/auth/me');
        if (!response.ok) return;
        me = await response.json();
    } catch (error) {
        console.error('로그인 사용자 정보 조회 실패:', error);
        return;
    }

    const li = document.createElement('li');
    li.id = 'account-nav-item';
    li.className = 'nav-dropdown';

    const trigger = document.createElement('a');
    trigger.href = '#';
    trigger.className = 'nav-accent-8 nav-dropdown-trigger';
    trigger.onclick = (event) => event.preventDefault();

    const triggerIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    triggerIcon.setAttribute('class', 'nav-icon');
    triggerIcon.setAttribute('viewBox', '0 0 16 16');
    const triggerUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    triggerUse.setAttribute('href', '#ic-user');
    triggerIcon.appendChild(triggerUse);
    trigger.appendChild(triggerIcon);
    trigger.appendChild(document.createTextNode(me.username + ' '));

    const caret = document.createElement('span');
    caret.className = 'nav-caret';
    caret.innerHTML = '&#9662;';
    trigger.appendChild(caret);

    li.appendChild(trigger);

    const menu = document.createElement('ul');
    menu.className = 'nav-dropdown-menu';

    if (me.isAdmin) {
        menu.appendChild(buildAccountMenuLink('ic-user', 'Users', 'users.html'));
    }
    menu.appendChild(buildAccountMenuLink('ic-logout', '로그아웃', '#', logoutAndRedirect));

    li.appendChild(menu);
    navList.appendChild(li);
}

document.documentElement.setAttribute('data-theme', getPreferredTheme());
document.addEventListener('DOMContentLoaded', async () => {
    injectIconSprite();
    // 계정 메뉴를 먼저 붙이고 나서 테마 토글을 붙여야, 테마 토글이 nav 맨 오른쪽 끝에 온다
    // (injectAccountNav는 /auth/me를 fetch해야 해서 비동기라, await 없이 순서만 바꾸면 안 됨).
    await injectAccountNav();
    injectThemeToggle();
});

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    setTimeout(() => {
        toast.classList.remove('toast-visible');
        setTimeout(() => toast.remove(), 300);
    }, 2600);
}

// 페이지 이동(리로드) 직전에 메시지를 남겨두고, 도착한 페이지에서
// showFlashMessageIfAny()로 꺼내 토스트로 보여줍니다.
function setFlashMessage(message, type = 'success') {
    sessionStorage.setItem('flashMessage', message);
    sessionStorage.setItem('flashType', type);
}

function showFlashMessageIfAny() {
    const message = sessionStorage.getItem('flashMessage');
    if (!message) return;
    const type = sessionStorage.getItem('flashType') || 'success';
    sessionStorage.removeItem('flashMessage');
    sessionStorage.removeItem('flashType');
    showToast(message, type);
}

// ── 다운로드 위치 지정 (File System Access API) ─────────────────────────────
// 사용자가 한 번 폴더를 선택해두면, 이후 다운로드는 그 폴더 밑에
// YYYY-MM-DD 하위 폴더를 자동으로 만들어서 저장한다. Chrome/Edge 등
// File System Access API를 지원하는 브라우저에서만 동작하고, 그 외에는
// 기존 방식(브라우저 기본 다운로드 폴더로 저장)으로 자동 대체된다.

const DOWNLOAD_DIR_DB_NAME = 'oracle-monitoring';
const DOWNLOAD_DIR_STORE = 'handles';
const DOWNLOAD_DIR_KEY = 'downloadDir';

function isFileSystemAccessSupported() {
    return typeof window.showDirectoryPicker === 'function';
}

function openHandleDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DOWNLOAD_DIR_DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(DOWNLOAD_DIR_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveDownloadDirHandle(handle) {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(DOWNLOAD_DIR_STORE, 'readwrite');
        tx.objectStore(DOWNLOAD_DIR_STORE).put(handle, DOWNLOAD_DIR_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

async function getSavedDownloadDirHandle() {
    const db = await openHandleDB();
    const handle = await new Promise((resolve, reject) => {
        const tx = db.transaction(DOWNLOAD_DIR_STORE, 'readonly');
        const req = tx.objectStore(DOWNLOAD_DIR_STORE).get(DOWNLOAD_DIR_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
}

// 폴더 선택 다이얼로그를 띄우고, 선택 결과를 저장한다. 버튼 onclick 등에서 호출.
async function chooseDownloadFolder() {
    if (!isFileSystemAccessSupported()) {
        showToast('이 브라우저는 다운로드 폴더 지정을 지원하지 않습니다 (Chrome/Edge 권장)', 'error');
        return;
    }
    try {
        const handle = await window.showDirectoryPicker();
        await saveDownloadDirHandle(handle);
        showToast(`다운로드 위치가 "${handle.name}"(으)로 설정되었습니다`);
        updateDownloadFolderLabel();
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('폴더 선택 실패:', err);
            showToast('다운로드 위치 설정 실패', 'error');
        }
    }
}

async function ensureReadWritePermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function todayDirName() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// 지정된 폴더가 있으면 그 밑에 YYYY-MM-DD 폴더를 만들어 저장하고,
// 없거나(미설정) 지원 안 되는 브라우저면 기존 Blob 다운로드로 대체한다.
async function saveHtmlToFolder(htmlString, filename) {
    const rootHandle = isFileSystemAccessSupported() ? await getSavedDownloadDirHandle() : null;

    if (!rootHandle) {
        downloadHtmlFallback(htmlString, filename);
        return;
    }

    try {
        if (!(await ensureReadWritePermission(rootHandle))) {
            showToast('다운로드 폴더 접근 권한이 없어 기본 다운로드로 저장합니다', 'error');
            downloadHtmlFallback(htmlString, filename);
            return;
        }

        const dayHandle = await rootHandle.getDirectoryHandle(todayDirName(), { create: true });
        const fileHandle = await dayHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(htmlString);
        await writable.close();

        showToast(`${rootHandle.name}/${todayDirName()}/${filename} 저장 완료`);
    } catch (err) {
        console.error('폴더에 저장 실패:', err);
        showToast('지정 폴더에 저장 실패, 기본 다운로드로 대체합니다', 'error');
        downloadHtmlFallback(htmlString, filename);
    }
}

function downloadHtmlFallback(htmlString, filename) {
    const blob = new Blob([htmlString], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// 모니터링/이력 조회 결과(task별 columns/rows, _alerts 포함)를 컨테이너에 렌더링합니다.
// dailyMonitoring.html, history.html에서 공용으로 사용합니다.
function renderMonitoringResults(container, results) {
    results.forEach((result) => {
        const heading = document.createElement('h3');
        heading.textContent = result.task_name;
        container.appendChild(heading);

        if (!result.success) {
            const errEl = document.createElement('p');
            errEl.className = 'error';
            errEl.textContent = `실행 실패: ${result.error || ''}`;
            container.appendChild(errEl);
            return;
        }

        if (!result.rows || result.rows.length === 0) {
            const noResult = document.createElement('p');
            noResult.textContent = 'No results found.';
            container.appendChild(noResult);
            return;
        }

        const table = document.createElement('table');
        table.className = 'table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        result.columns.forEach((column) => {
            const th = document.createElement('th');
            th.textContent = column;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        result.rows.forEach((row) => {
            const tr = document.createElement('tr');
            const alerts = row._alerts || {};
            result.columns.forEach((column) => {
                const td = document.createElement('td');
                td.textContent = row[column];
                if (alerts[column]) {
                    td.classList.add('cell-' + alerts[column].level.toLowerCase());
                    td.title = alerts[column].message || '';
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        container.appendChild(table);
    });
}

// ── 모달(Add/Modify 팝업) 공용 유틸 ──────────────────────────────────────
// 배경 클릭 또는 Esc 키로 닫히도록 한 번만 연결해두고, 열고 닫는 건
// openModal/closeModal로 각 화면에서 호출한다.

function openModal(overlayId) {
    document.getElementById(overlayId).classList.remove('hidden');
}

function closeModal(overlayId) {
    document.getElementById(overlayId).classList.add('hidden');
}

function setupModalDismiss(overlayId) {
    const overlay = document.getElementById(overlayId);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeModal(overlayId);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !overlay.classList.contains('hidden')) {
            closeModal(overlayId);
        }
    });
}

// 현재 설정된 다운로드 폴더 이름을 화면에 표시 (id="download-folder-label" 요소가 있을 때만).
async function updateDownloadFolderLabel() {
    const label = document.getElementById('download-folder-label');
    if (!label) return;
    if (!isFileSystemAccessSupported()) {
        label.textContent = '(이 브라우저는 미지원)';
        return;
    }
    const handle = await getSavedDownloadDirHandle();
    label.textContent = handle ? `저장 위치: ${handle.name}` : '(미설정 — 기본 다운로드 폴더 사용)';
}
