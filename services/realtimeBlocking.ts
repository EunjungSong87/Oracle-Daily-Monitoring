// Real-Time 화면의 Blocking 체인 트리 (GV$SESSION 기준, RAC는 inst_id까지 묶어서 세션을 구분).
// 대상 DB 조회는 models/realtimeModel.ts, 여기는 행 → 트리 변환과 Kill 가능 여부 판단만 한다.

export interface BlockingSession {
  instId: number;
  sid: number;
  serial: number;
  username: string | null;
  machine: string | null;
  program: string | null;
  sqlId: string | null;
  event: string | null;
  status: string | null;
  type: string | null; // USER | BACKGROUND
  waitSec: number | null; // 지금 대기 중일 때만 (V$SESSION.WAIT_TIME_MICRO)
  blockingInstance: number | null;
  blockingSession: number | null;
  rowWaitObj: number | null;
  objectName: string | null; // OWNER.OBJECT_NAME (TYPE) — DBA_OBJECTS를 못 읽으면 null
}

export interface BlockingNode extends BlockingSession {
  killDisabled: string | null; // Kill 버튼을 막는 이유 (백그라운드/SYS)
  waiters: BlockingNode[];
}

export interface BlockingRoot extends BlockingNode {
  blockedSec: number; // 이 최상위 블로커 아래 대기자 중 가장 오래 기다린 시간 = 막고 있는 시간
  waiterCount: number;
}

export function sessionKey(instId: number, sid: number): string {
  return `${instId}:${sid}`;
}

// 백그라운드 프로세스나 SYS 세션은 화면에서 Kill하지 않는다 (서버도 Kill 직전에 같은 조건을 다시 확인).
export function killDisabledReason(session: Pick<BlockingSession, 'type' | 'username'>): string | null {
  if (session.type === 'BACKGROUND' || !session.username) return '백그라운드 프로세스';
  if (session.username.toUpperCase() === 'SYS') return 'SYS 세션';
  return null;
}

// waiters: blocking_session이 있는 세션들, blockers: waiters가 가리키는 블로커 중 waiters에 없는 세션들.
// 블로커가 이미 사라졌거나 상한에 걸려 못 읽었으면 대기자를 최상위로 올리지 않고 자리만 남긴다(세션 정보 없음).
export function buildBlockingTree(waiters: BlockingSession[], blockers: BlockingSession[]): BlockingRoot[] {
  const all = new Map<string, BlockingSession>();
  for (const row of [...blockers, ...waiters]) all.set(sessionKey(row.instId, row.sid), row);

  const children = new Map<string, string[]>();
  for (const row of waiters) {
    if (row.blockingSession === null) continue;
    const parent = sessionKey(row.blockingInstance ?? row.instId, row.blockingSession);
    if (!all.has(parent)) {
      const [instId, sid] = parent.split(':').map(Number);
      all.set(parent, { ...placeholder(), instId, sid });
    }
    children.set(parent, [...(children.get(parent) ?? []), sessionKey(row.instId, row.sid)]);
  }
  const parentOf = new Map<string, string>();
  for (const [parent, kids] of children) for (const kid of kids) parentOf.set(kid, parent);

  const used = new Set<string>();
  const build = (key: string): BlockingNode => {
    used.add(key);
    const row = all.get(key)!;
    const kids = (children.get(key) ?? []).filter((kid) => !used.has(kid)).sort(byWait(all));
    return { ...row, killDisabled: killDisabledReason(row), waiters: kids.map(build) };
  };
  const toRoot = (key: string): BlockingRoot => {
    const node = build(key);
    const stats = { max: 0, count: 0 };
    const walk = (n: BlockingNode) => n.waiters.forEach((w) => (stats.count++, (stats.max = Math.max(stats.max, w.waitSec ?? 0)), walk(w)));
    walk(node);
    return { ...node, blockedSec: stats.max, waiterCount: stats.count };
  };

  const roots = [...children.keys()].filter((key) => !parentOf.has(key)).map(toRoot);
  // 순환(데드락 직전 등)으로 최상위가 없는 묶음은 그중 하나를 최상위로 삼는다
  for (const key of [...children.keys()].sort()) if (!used.has(key)) roots.push(toRoot(key));
  return roots.sort((a, b) => b.blockedSec - a.blockedSec || b.waiterCount - a.waiterCount);
}

function byWait(all: Map<string, BlockingSession>) {
  return (a: string, b: string) => (all.get(b)!.waitSec ?? 0) - (all.get(a)!.waitSec ?? 0) || a.localeCompare(b);
}

function placeholder(): BlockingSession {
  return {
    instId: 0,
    sid: 0,
    serial: 0,
    username: null,
    machine: null,
    program: '(세션 정보 없음)',
    sqlId: null,
    event: null,
    status: null,
    type: null,
    waitSec: null,
    blockingInstance: null,
    blockingSession: null,
    rowWaitObj: null,
    objectName: null,
  };
}
