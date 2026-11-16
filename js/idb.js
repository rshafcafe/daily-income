// Minimal IndexedDB wrapper. Replaces localStorage for the heavy data
// (localStorage is synchronous and capped at ~5 MB, which the photos blew past).
const DB_NAME = 'rashf_daily_income';
const STORES = ['items', 'images', 'meta', 'audit'];
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = t.onabort = () => reject(t.error || new Error('IndexedDB transaction failed'));
    result = fn(t.objectStore(store));
  });
}
const reqValue = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const idb = {
  async get(store, key) {
    const db = await open();
    return reqValue(db.transaction(store).objectStore(store).get(key));
  },
  set: (store, key, value) => tx(store, 'readwrite', (s) => { s.put(value, key); }),
  del: (store, key) => tx(store, 'readwrite', (s) => { s.delete(key); }),
  /** ops: [[key, value]] — value === undefined deletes the key. */
  bulk: (store, ops) => tx(store, 'readwrite', (s) => {
    for (const [k, v] of ops) v === undefined ? s.delete(k) : s.put(v, k);
  }),
  clear: (store) => tx(store, 'readwrite', (s) => { s.clear(); }),
  /** All [key, value] pairs whose key starts with `prefix`. */
  async entries(store, prefix = '') {
    const db = await open();
    const os = db.transaction(store).objectStore(store);
    const range = prefix ? IDBKeyRange.bound(prefix, prefix + '￿') : undefined;
    const [keys, values] = await Promise.all([reqValue(os.getAllKeys(range)), reqValue(os.getAll(range))]);
    return keys.map((k, i) => [k, values[i]]);
  }
};
