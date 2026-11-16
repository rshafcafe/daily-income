// Data layer: in-memory state (fast reads), IndexedDB (offline persistence)
// and Firestore (per-document sync through an outbox).
//
// Why it is built this way — the bugs of the old "rewrite the whole collection
// on every save" approach:
//   * two devices saving at once overwrote each other      -> one write per document
//   * deletes never reached the cloud and came back        -> real deleteDoc + reconciliation
//   * a shift whose push failed was wiped by the listener  -> outbox, nothing unsent is ever dropped
//   * photos inside the shift document broke the 1 MB cap  -> one document per photo (subcollection)
import { idb } from './idb.js';
import {
  COLLECTIONS, CONFIG_COLLECTIONS, DEFAULT_BRANDS, DEFAULT_PAYMENT_METHODS,
  SEED_BRANCHES, SEED_EMPLOYEES, DEFAULT_SHIFT_WINDOW_DAYS, IMAGE_CATS
} from './constants.js';
import { planReconcile } from './logic.js';
import { businessDate, addDays, sid, clone, debounce } from './util.js';
import { compressImage } from './images.js';
import * as cloud from './cloud.js';

const KEYS = Object.keys(COLLECTIONS);
const mem = Object.fromEntries(KEYS.map((k) => [k, new Map()]));
const synced = Object.fromEntries(KEYS.map((k) => [k, new Set()]));   // ids the server is known to have had
const dropIds = Object.fromEntries(KEYS.map((k) => [k, new Set()]));  // pre-sync local config, server wins
const firstServer = {};
const unsub = {};
const subs = new Set();
let outbox = new Map();
let actor = { type: 'system' };
let windowFrom = addDays(businessDate(), -DEFAULT_SHIFT_WINDOW_DAYS);   // null = whole history
let persistOk = true;

export const sync = {
  enabled: true, status: 'disconnected', error: '', lastSync: null,
  get pending() { return outbox.size; }
};

/* ---------------- events ---------------- */
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
let changed = new Set();
const fire = debounce(() => {
  const what = changed; changed = new Set();
  for (const fn of subs) { try { fn(what); } catch (e) { console.error(e); } }
}, 40);
function emit(what) { changed.add(what); fire(); }

/* ---------------- persistence ---------------- */
const ikey = (coll, id) => `${coll}/${id}`;
function persist(ops) {
  if (!persistOk || !ops.length) return Promise.resolve();
  return idb.bulk('items', ops).catch((e) => console.warn('IndexedDB write failed:', e));
}
const saveMeta = debounce(() => {
  if (!persistOk) return;
  const pack = (o) => Object.fromEntries(KEYS.map((k) => [k, [...o[k]]]));
  idb.set('meta', 'state', {
    migrated: true,
    outbox: [...outbox.values()].map(({ handed, error, ...op }) => op),
    synced: pack(synced), dropIds: pack(dropIds)
  }).catch((e) => console.warn('IndexedDB meta write failed:', e));
}, 150);
/** Small collections are mirrored to their old localStorage keys (backward compatibility). */
function mirrorLegacy(coll) {
  if (!CONFIG_COLLECTIONS.includes(coll)) return;
  try { localStorage.setItem(COLLECTIONS[coll].storage, JSON.stringify([...mem[coll].values()])); } catch { /* quota */ }
}

function readLegacy(key) {
  try {
    const v = JSON.parse(localStorage.getItem(COLLECTIONS[key].storage) || 'null');
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** First run of the new version: copy everything out of localStorage (it is left untouched). */
async function migrateFromLocalStorage() {
  const wasMirror = localStorage.getItem('rashf_firebase_enabled') === 'true';
  const legacy = { shifts: readLegacy('shifts') || [] };
  const builtIn = {};   // collections filled from the app's defaults, not from real user data
  const fallback = { employees: SEED_EMPLOYEES, branches: SEED_BRANCHES, brands: DEFAULT_BRANDS, paymentMethods: DEFAULT_PAYMENT_METHODS };
  for (const coll of CONFIG_COLLECTIONS) {
    const stored = readLegacy(coll);
    const usable = stored && (stored.length || coll === 'employees' || coll === 'branches');
    legacy[coll] = usable ? stored : clone(fallback[coll]);
    builtIn[coll] = !usable;
  }
  const ops = [];
  for (const coll of KEYS) {
    for (const item of legacy[coll]) {
      if (!item || item.id === undefined || item.id === null || item.id === '') continue;
      const id = sid(item.id);
      mem[coll].set(id, item);
      ops.push([ikey(coll, id), item]);
      // Built-in defaults are never uploaded and give way to real cloud data.
      // Config that was a mirror of the cloud counts as synced. Everything else
      // (real local data the cloud lacks, and every shift) gets uploaded — that
      // is how data stuck on a device is recovered.
      if (builtIn[coll]) dropIds[coll].add(id);
      else if (wasMirror && CONFIG_COLLECTIONS.includes(coll)) synced[coll].add(id);
    }
  }
  await persist(ops);
  saveMeta();
}

export async function initStore() {
  let state = null;
  try {
    state = await idb.get('meta', 'state');
  } catch (e) {
    persistOk = false;
    console.warn('IndexedDB unavailable — running from memory only:', e);
  }
  if (state?.migrated) {
    for (const [key, item] of await idb.entries('items')) {
      const i = key.indexOf('/');
      const coll = key.slice(0, i);
      if (mem[coll]) mem[coll].set(key.slice(i + 1), item);
    }
    outbox = new Map((state.outbox || []).map((op) => [op.key, op]));
    for (const k of KEYS) {
      synced[k] = new Set(state.synced?.[k] || []);
      dropIds[k] = new Set(state.dropIds?.[k] || []);
    }
  } else {
    await migrateFromLocalStorage();
  }
  sync.enabled = localStorage.getItem('rashf_firebase_enabled') !== 'false';
  window.addEventListener('online', () => {
    if (!sync.enabled) return;
    if (!cloud.cloudReady() || sync.status === 'error') startSync();
    else { flush(); refreshStatus(); }
  });
  window.addEventListener('offline', refreshStatus);
}

/* ---------------- reads ---------------- */
export function list(coll) {
  const items = [...mem[coll].values()];
  if (!items.length && coll === 'paymentMethods') return clone(DEFAULT_PAYMENT_METHODS);
  if (!items.length && coll === 'brands') return clone(DEFAULT_BRANDS);
  return items;
}
export const get = (coll, id) => mem[coll].get(sid(id));
export function setActor(a) { actor = a || { type: 'system' }; }

/* ---------------- outbox ---------------- */
function enqueue(op) {
  outbox.set(op.key, op);
  saveMeta();
  flush();
  refreshStatus();
}
function dropOps(coll, id) {
  for (const [k, op] of outbox) if (op.coll === coll && op.id === id && op.type !== 'del') outbox.delete(k);
}
/** ids with a local change the Firestore SDK has not been given yet (snapshots must not overwrite them). */
function unsentIds(coll) {
  const s = new Set();
  for (const op of outbox.values()) if (op.coll === coll && !op.handed) s.add(op.id);
  return s;
}
function pendingIds(coll) {
  const s = new Set();
  for (const op of outbox.values()) if (op.coll === coll) s.add(op.id);
  return s;
}

async function run(op) {
  switch (op.type) {
    case 'set': {
      const item = mem[op.coll].get(op.id);
      return item ? cloud.setItem(op.coll, op.id, item) : undefined;
    }
    case 'patch':
      return cloud.updateItem(op.coll, op.id, op.fields, mem[op.coll].get(op.id));
    case 'del':
      await cloud.deleteItem(op.coll, op.id);
      for (const imgId of op.images || []) cloud.deleteImage(op.id, imgId).catch(() => {});
      return undefined;
    case 'img': {
      const data = await idb.get('images', `${op.shiftId}/${op.imgId}`);
      return data ? cloud.putImage(op.shiftId, op.imgId, { data, cat: op.cat || '', name: op.name || '' }) : undefined;
    }
    default: return undefined;
  }
}

function flush() {
  if (!sync.enabled || !cloud.cloudReady()) return;
  for (const op of [...outbox.values()]) {
    if (op.handed) continue;
    op.handed = true;
    op.error = '';
    run(op).then(() => {
      if (outbox.get(op.key) === op) outbox.delete(op.key);
      if (op.type === 'set') synced[op.coll].add(op.id);
      if (op.type === 'del') synced[op.coll].delete(op.id);
      sync.lastSync = Date.now();
      saveMeta();
      refreshStatus();
    }).catch((e) => {
      op.handed = false;
      op.error = e?.code || e?.message || String(e);
      console.error('Sync write failed:', op.key, e);
      refreshStatus();
    });
  }
}

/* ---------------- writes ---------------- */
function recordAudit(info, coll, id) {
  if (!info) return;
  const entry = {
    at: new Date().toISOString(), actor, action: info.action, coll, itemId: sid(id),
    summary: info.summary || '', changes: info.changes || null
  };
  if (persistOk) idb.set('audit', `${entry.at}_${Math.random().toString(36).slice(2, 8)}`, entry).catch(() => {});
  if (sync.enabled && cloud.cloudReady()) cloud.addAudit(clone(entry)).catch((e) => console.warn('Audit write failed:', e));
}

/**
 * The built-in defaults stay local until the accountant changes configuration.
 * From that moment they are real data: upload all of them together, so the
 * cloud never holds a half set that would make other devices drop the rest.
 */
function adoptDefaults() {
  let any = false;
  for (const coll of CONFIG_COLLECTIONS) {
    for (const id of dropIds[coll]) {
      if (mem[coll].has(id)) { outbox.set(`s:${coll}/${id}`, { key: `s:${coll}/${id}`, type: 'set', coll, id }); any = true; }
    }
    dropIds[coll] = new Set();
  }
  if (any) { saveMeta(); flush(); }
}

/** Create or fully replace one document. */
export async function put(coll, item, auditInfo) {
  const id = sid(item.id);
  if (auditInfo && CONFIG_COLLECTIONS.includes(coll)) adoptDefaults();
  dropIds[coll].delete(id);
  mem[coll].set(id, item);
  await persist([[ikey(coll, id), item]]);
  mirrorLegacy(coll);
  dropOps(coll, id);
  enqueue({ key: `s:${coll}/${id}`, type: 'set', coll, id });
  recordAudit(auditInfo, coll, id);
  emit(coll);
  return item;
}

/** Update only some fields (use null to clear one). Other devices' edits to other fields survive. */
export async function patch(coll, id, fields, auditInfo) {
  id = sid(id);
  const cur = mem[coll].get(id);
  if (!cur) return null;
  if (auditInfo && CONFIG_COLLECTIONS.includes(coll)) adoptDefaults();
  const next = { ...cur, ...fields };
  mem[coll].set(id, next);
  await persist([[ikey(coll, id), next]]);
  mirrorLegacy(coll);
  const fullSetWaiting = [...outbox.values()].some((op) => op.type === 'set' && op.coll === coll && op.id === id && !op.handed);
  if (!fullSetWaiting) {
    enqueue({ key: `p:${coll}/${id}:${Date.now()}${Math.random().toString(36).slice(2, 6)}`, type: 'patch', coll, id, fields: clone(fields) });
  }
  recordAudit(auditInfo, coll, id);
  emit(coll);
  return next;
}

export async function remove(coll, id, auditInfo) {
  id = sid(id);
  const cur = mem[coll].get(id);
  if (!cur) return;
  if (auditInfo && CONFIG_COLLECTIONS.includes(coll)) adoptDefaults();
  mem[coll].delete(id);
  await persist([[ikey(coll, id), undefined]]);
  mirrorLegacy(coll);
  dropOps(coll, id);
  const images = coll === 'shifts'
    ? IMAGE_CATS.flatMap((c) => (cur.images?.[c] || []).filter((i) => i.ref).map((i) => sid(i.id)))
    : undefined;
  enqueue({ key: `d:${coll}/${id}`, type: 'del', coll, id, images });
  recordAudit(auditInfo, coll, id);
  emit(coll);
}

/* ---------------- images ---------------- */
export const newImageId = () => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function storeImageData(shiftId, img, cat, data) {
  const key = `${sid(shiftId)}/${sid(img.id)}`;
  if (persistOk) await idb.set('images', key, data);
  enqueue({ key: `i:${key}`, type: 'img', coll: '_img', id: key, shiftId: sid(shiftId), imgId: sid(img.id), cat, name: img.name || '' });
}

/**
 * Moves full-size photo data out of the shift document. Each photo becomes
 * {id, name, thumb, ref:true}; its data goes to IndexedDB + its own cloud document.
 */
export async function externalizeImages(shift) {
  const images = {};
  for (const cat of IMAGE_CATS) {
    images[cat] = [];
    for (const img of shift.images?.[cat] || []) {
      if (!img?.data || !persistOk) { if (img) images[cat].push(img); continue; }
      let data = img.data;
      let thumb = img.thumb;
      if (!img.compressed) {
        try { ({ data, thumb } = await compressImage(img.data)); } catch (e) { console.warn('Image compression failed, keeping original:', e); }
      }
      if (data.length > 1000000) { images[cat].push({ ...img, compressed: undefined }); continue; } // cannot be split safely
      const id = img.id ?? newImageId();
      await storeImageData(shift.id, { id, name: img.name }, cat, data);
      images[cat].push({ id, name: img.name || '', thumb: thumb || '', ref: true });
    }
  }
  return { ...shift, images };
}

/** Full-size data URL of a photo (inline legacy data, local cache, or the cloud). */
export async function loadImageData(shiftId, img) {
  if (img.data) return img.data;
  const key = `${sid(shiftId)}/${sid(img.id)}`;
  if (persistOk) {
    const cached = await idb.get('images', key).catch(() => null);
    if (cached) return cached;
  }
  if (sync.enabled) {
    await cloud.initCloud();
    const doc = await cloud.getImage(shiftId, img.id);
    if (doc?.data) {
      if (persistOk) idb.set('images', key, doc.data).catch(() => {});
      return doc.data;
    }
  }
  throw new Error('الصورة غير متوفرة على هذا الجهاز (تحتاج اتصالاً بالإنترنت)');
}

/** Saves a shift, splitting its photos out first. */
export async function saveShift(shift, auditInfo) {
  return put('shifts', await externalizeImages(shift), auditInfo);
}

/* ---------------- cloud sync ---------------- */
function refreshStatus(forced) {
  const failed = [...outbox.values()].find((op) => op.error);
  let status;
  if (!sync.enabled) status = 'disconnected';
  else if (forced) status = forced;
  else if (failed) status = 'error';
  else if (!navigator.onLine) status = 'offline';
  else if (KEYS.every((k) => firstServer[k])) status = 'connected';
  else status = sync.status === 'error' ? 'error' : 'syncing';
  if (failed) sync.error = failed.error;
  else if (status !== 'error') sync.error = '';
  if (status !== sync.status || failed) { sync.status = status; }
  emit('sync');
}

function applySnapshot(coll, { changes, fromCache, serverIds }) {
  const blocked = unsentIds(coll);
  const ops = [];
  for (const ch of changes) {
    if (blocked.has(ch.id)) continue;
    if (ch.type === 'removed') {
      const cur = mem[coll].get(ch.id);
      if (!cur) continue;
      if (coll === 'shifts' && windowFrom && (cur.date || '') < windowFrom) continue; // just left the window
      mem[coll].delete(ch.id);
      synced[coll].delete(ch.id);
      ops.push([ikey(coll, ch.id), undefined]);
    } else {
      mem[coll].set(ch.id, ch.data);
      ops.push([ikey(coll, ch.id), ch.data]);
    }
  }
  if (serverIds) {
    if (!firstServer[coll]) {
      firstServer[coll] = true;
      const inWindow = (id) => coll !== 'shifts' || !windowFrom || (mem.shifts.get(id)?.date || '') >= windowFrom;
      const plan = planReconcile({
        localIds: [...mem[coll].keys()].filter(inWindow),
        serverIds, syncedIds: synced[coll], pendingIds: pendingIds(coll),
        dropIds: CONFIG_COLLECTIONS.includes(coll) ? dropIds[coll] : null,
        serverEmpty: serverIds.size === 0
      });
      for (const id of plan.toDelete) {
        mem[coll].delete(id);
        synced[coll].delete(id);
        ops.push([ikey(coll, id), undefined]);
      }
      for (const id of plan.toPush) pushLocal(coll, id);
      if (serverIds.size) dropIds[coll] = new Set();   // cloud has real data: the defaults are gone
    }
    for (const id of serverIds) synced[coll].add(id);
    sync.lastSync = Date.now();
    saveMeta();
  }
  if (ops.length) {
    persist(ops);
    mirrorLegacy(coll);
    emit(coll);
  }
  if (!fromCache) refreshStatus();
}

async function pushLocal(coll, id) {
  try {
    const item = mem[coll].get(id);
    if (!item) return;
    if (coll === 'shifts') await saveShift(item); else await put(coll, item);
  } catch (e) { console.error('Upload of local item failed:', coll, id, e); }
}

function attach(coll) {
  unsub[coll]?.();
  firstServer[coll] = false;
  unsub[coll] = cloud.listen(coll, { fromDate: windowFrom }, (snap) => applySnapshot(coll, snap), (err) => {
    console.error('Firestore listener error:', coll, err);
    sync.error = err?.code || err?.message || String(err);
    refreshStatus('error');
  });
}
function detachAll() {
  for (const k of KEYS) { unsub[k]?.(); delete unsub[k]; firstServer[k] = false; }
}

let starting = null;
export function startSync() {
  if (!sync.enabled) return Promise.resolve();
  if (starting) return starting;
  refreshStatus('syncing');
  starting = (async () => {
    try {
      await cloud.initCloud();
    } catch (e) {
      sync.error = 'تعذر الاتصال بـ Firebase: ' + (e?.message || e);
      refreshStatus(navigator.onLine ? 'error' : 'offline');
      return;
    }
    sync.status = 'syncing';
    for (const k of KEYS) attach(k);
    flush();
    cloud.getSecurity().then((s) => {
      if (s.legacyLoginDisabled) localStorage.setItem('rashf_legacy_login_disabled', '1');
    }).catch(() => {});
  })().finally(() => { starting = null; });
  return starting;
}

export function setSyncEnabled(enabled) {
  sync.enabled = !!enabled;
  localStorage.setItem('rashf_firebase_enabled', enabled ? 'true' : 'false');
  if (enabled) startSync();
  else { detachAll(); for (const op of outbox.values()) op.handed = false; refreshStatus(); }
}

/** Retry everything that has not reached the cloud yet. */
export function retrySync() {
  for (const op of outbox.values()) { op.handed = false; op.error = ''; }
  if (sync.status === 'error' || !cloud.cloudReady()) { detachAll(); return startSync(); }
  flush();
  refreshStatus();
  return Promise.resolve();
}

/** Make sure shifts dated `from` and later are loaded ('' = whole history). */
export function ensureShiftWindow(from) {
  const want = from || null;
  if (windowFrom === null || (want !== null && want >= windowFrom)) return Promise.resolve();
  windowFrom = want;
  if (!sync.enabled || !cloud.cloudReady()) return Promise.resolve();
  attach('shifts');
  refreshStatus('syncing');
  // Resolves once the server answered for the wider range (or after 15 s offline).
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (firstServer.shifts || Date.now() - started > 15000) { clearInterval(timer); resolve(); }
    }, 150);
  });
}
export const shiftWindowFrom = () => windowFrom;

/* ---------------- accountant auth ---------------- */
export const legacyLoginAllowed = () => localStorage.getItem('rashf_legacy_login_disabled') !== '1';
export async function loginAccountant(email, password) {
  const signedIn = await cloud.signInAccountant(email, password);
  localStorage.setItem('rashf_legacy_login_disabled', '1');
  cloud.setSecurity({ legacyLoginDisabled: true, updatedAt: new Date().toISOString() }).catch(() => {});
  if (sync.enabled) await retrySync();
  return signedIn;
}
export const logoutAccountant = () => cloud.signOutAccountant().catch(() => {});

/* ---------------- audit log ---------------- */
export async function loadAudit(max = 200) {
  if (sync.enabled && cloud.cloudReady()) {
    try { return await cloud.listAudit(max); } catch (e) { console.warn('Cloud audit read failed, showing local log:', e); }
  }
  if (!persistOk) return [];
  return (await idb.entries('audit')).map(([, v]) => v).reverse().slice(0, max);
}

/* ---------------- bulk operations ---------------- */
/** Import a JSON backup: replaces the given collections (deletes what is not in the file). */
export async function importData(data, onProgress) {
  for (const coll of KEYS) {
    const items = data[coll];
    if (!Array.isArray(items)) continue;
    const keep = new Set(items.filter((i) => i && i.id !== undefined && i.id !== null).map((i) => sid(i.id)));
    for (const id of [...mem[coll].keys()]) if (!keep.has(id)) await remove(coll, id);
    let n = 0;
    for (const item of items) {
      if (!keep.has(sid(item?.id))) continue;
      if (coll === 'shifts') await saveShift(item); else await put(coll, item);
      onProgress?.(coll, ++n, items.length);
    }
  }
  recordAudit({ action: 'import', summary: 'استيراد نسخة احتياطية' }, 'all', '-');
}

/** Old shifts that still carry full-size photos inside the document. */
export const legacyImageShifts = () =>
  [...mem.shifts.values()].filter((s) => IMAGE_CATS.some((c) => (s.images?.[c] || []).some((i) => i.data)));

export async function migrateLegacyImages(onProgress) {
  const todo = legacyImageShifts();
  let done = 0;
  for (const s of todo) {
    await saveShift(s);
    onProgress?.(++done, todo.length);
  }
  if (done) recordAudit({ action: 'migrate-images', summary: `ترحيل صور ${done} شفت` }, 'shifts', '-');
  return done;
}

/** Wipes this device's local copy only. The cloud is not touched. */
export async function wipeLocal() {
  detachAll();
  if (persistOk) for (const s of ['items', 'images', 'meta', 'audit']) await idb.clear(s);
  for (const k of KEYS) localStorage.removeItem(COLLECTIONS[k].storage);
  localStorage.removeItem('rashf_foodics');
}
