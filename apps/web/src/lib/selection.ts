/**
 * Hands a picked list of ids to another page (print, export) without stuffing thousands of uuids
 * into the URL: the ids go to sessionStorage under a random key and only `sel=<key>` travels.
 */
const PREFIX = 'somar-sel:';
// fallback for the current tab when storage is blocked (private mode, quota)
const memory = new Map<string, string[]>();

function randomKey(): string {
  try {
    return crypto.randomUUID().slice(0, 12);
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}

const ORDER_KEY = 'somar-sel-order';
// a select-all can be thousands of ids; keep only the latest few so the tab's quota never fills
const KEEP = 5;

/** Drops stored selections beyond the newest `keep`, oldest first. */
function prune(keep: number): string[] {
  let order: string[] = [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(ORDER_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) order = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    order = [];
  }
  // keys written before the order list existed are dropped too
  const known = new Set(order);
  for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
    const name = sessionStorage.key(i);
    if (name?.startsWith(PREFIX) && !known.has(name.slice(PREFIX.length))) sessionStorage.removeItem(name);
  }
  const drop = order.slice(0, Math.max(0, order.length - keep));
  for (const key of drop) sessionStorage.removeItem(PREFIX + key);
  return order.slice(drop.length);
}

/** Saves the ids and returns the key to put in the link. */
export function storeSelection(ids: string[]): string {
  const key = randomKey();
  memory.set(key, [...ids]);
  const value = JSON.stringify(ids);
  try {
    const order = prune(KEEP - 1);
    try {
      sessionStorage.setItem(PREFIX + key, value);
    } catch {
      // quota: keep only this selection and try once more
      prune(0);
      order.length = 0;
      sessionStorage.setItem(PREFIX + key, value);
    }
    sessionStorage.setItem(ORDER_KEY, JSON.stringify([...order, key]));
  } catch {
    // the in-memory copy still serves this tab
  }
  return key;
}

/** The ids saved under `key`, or null when the key is unknown (expired tab, opened elsewhere). */
export function readSelection(key: string | null): string[] | null {
  if (!key) return null;
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const ids = JSON.parse(raw) as unknown;
    if (!Array.isArray(ids)) return null;
    const clean = ids.filter((id): id is string => typeof id === 'string');
    memory.set(key, clean);
    return clean;
  } catch {
    return null;
  }
}
