// public/common.js의 다운로드 폴더 지정(File System Access API + IndexedDB 핸들 저장) 로직 포팅.
// 다른 vanilla 페이지와 동일한 IndexedDB 스토어/키를 그대로 사용하므로, 한 번 설정해두면
// 이 페이지와 vanilla 페이지 양쪽에서 같은 다운로드 위치를 공유한다.

const DOWNLOAD_DIR_DB_NAME = 'oracle-monitoring';
const DOWNLOAD_DIR_STORE = 'handles';
const DOWNLOAD_DIR_KEY = 'downloadDir';

export function isFileSystemAccessSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DOWNLOAD_DIR_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DOWNLOAD_DIR_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDownloadDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_DIR_STORE, 'readwrite');
    tx.objectStore(DOWNLOAD_DIR_STORE).put(handle, DOWNLOAD_DIR_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getSavedDownloadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDB();
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_DIR_STORE, 'readonly');
    const req = tx.objectStore(DOWNLOAD_DIR_STORE).get(DOWNLOAD_DIR_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return handle;
}

export async function chooseDownloadFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemAccessSupported()) {
    return null;
  }
  const picker = (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  const handle = await picker();
  await saveDownloadDirHandle(handle);
  return handle;
}

async function ensureReadWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const };
  const fsHandle = handle as FileSystemDirectoryHandle & {
    queryPermission(o: typeof opts): Promise<PermissionState>;
    requestPermission(o: typeof opts): Promise<PermissionState>;
  };
  if ((await fsHandle.queryPermission(opts)) === 'granted') return true;
  return (await fsHandle.requestPermission(opts)) === 'granted';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function todayDirName(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function downloadHtmlFallback(htmlString: string, filename: string): void {
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

// 지정된 폴더가 있으면 그 밑에 YYYY-MM-DD 폴더를 만들어 저장하고,
// 없거나(미설정) 지원 안 되는 브라우저면 기존 Blob 다운로드로 대체한다.
// 성공/실패 메시지를 호출부(토스트)로 전달할 수 있도록 결과를 반환한다.
export async function saveHtmlToFolder(
  htmlString: string,
  filename: string
): Promise<{ message: string; type: 'success' | 'error' }> {
  const rootHandle = isFileSystemAccessSupported() ? await getSavedDownloadDirHandle() : null;

  if (!rootHandle) {
    downloadHtmlFallback(htmlString, filename);
    return { message: `${filename} 다운로드 완료`, type: 'success' };
  }

  try {
    if (!(await ensureReadWritePermission(rootHandle))) {
      downloadHtmlFallback(htmlString, filename);
      return { message: '다운로드 폴더 접근 권한이 없어 기본 다운로드로 저장합니다', type: 'error' };
    }

    const dayHandle = await rootHandle.getDirectoryHandle(todayDirName(), { create: true });
    const fileHandle = await dayHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(htmlString);
    await writable.close();

    return { message: `${rootHandle.name}/${todayDirName()}/${filename} 저장 완료`, type: 'success' };
  } catch (err) {
    console.error('폴더에 저장 실패:', err);
    downloadHtmlFallback(htmlString, filename);
    return { message: '지정 폴더에 저장 실패, 기본 다운로드로 대체합니다', type: 'error' };
  }
}
