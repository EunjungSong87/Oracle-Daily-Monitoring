// Data Pump 분할 계획용 크기/파티션 정보의 짧은 메모리 캐시.
// 옵션(분할 크기, 접두어 등)만 바꿔 계획을 다시 만들 때마다 대상 DB 딕셔너리를 다시 읽지 않게 한다 — 대상 DB 부하를 줄이는 게 목적.
// 값은 앱 서버 메모리에만 있고(프로세스 하나짜리 앱), TTL이 지나거나 화면에서 "크기 새로 읽기"를 누르면 다시 읽는다.

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

interface Entry {
  at: number; // 대상 DB에서 읽은 시각
  value: unknown;
}

const cache = new Map<string, Entry>();
// 같은 키를 동시에 두 번 읽지 않게 (화면에서 연달아 눌러도 대상 DB 조회는 한 번).
const pending = new Map<string, Promise<Entry>>();

async function cached<T>(key: string, load: () => Promise<T>, refresh = false): Promise<{ value: T; readAt: Date }> {
  const now = Date.now();
  const hit = cache.get(key);
  if (!refresh && hit && now - hit.at < TTL_MS) return { value: hit.value as T, readAt: new Date(hit.at) };

  let inFlight = pending.get(key);
  if (!inFlight) {
    inFlight = load()
      .then((value) => {
        const entry = { at: Date.now(), value };
        cache.set(key, entry);
        // 오래된 것부터 지워 크기를 제한한다 (Map은 넣은 순서를 지킨다).
        while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
        return entry;
      })
      .finally(() => pending.delete(key));
    pending.set(key, inFlight);
  }
  const entry = await inFlight;
  return { value: entry.value as T, readAt: new Date(entry.at) };
}

// 캐시 키: 대상 DB + 종류 + 정렬한 대상 목록
function cacheKey(dbmsid: number | string, kind: string, parts: (string | null | undefined)[]): string {
  return [String(dbmsid), kind, ...parts.map((part) => part ?? '')].join('\u0001');
}

export { cached, cacheKey, TTL_MS };
