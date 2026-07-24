// common.js — 모든 화면에서 공통으로 쓰는 토스트 알림 유틸

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
