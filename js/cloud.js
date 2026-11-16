// Firebase access. The SDK is loaded lazily so the UI paints before it arrives.
import { FIREBASE_CONFIG, FIREBASE_SDK, COLLECTIONS, AUDIT_PATH, SECURITY_DOC } from './constants.js';

let fs = null;      // firestore module
let au = null;      // auth module
let db = null;
let auth = null;
let initPromise = null;

export function initCloud() {
  if (!initPromise) {
    initPromise = (async () => {
      const [appMod, fsMod, auMod] = await Promise.all([
        import(`${FIREBASE_SDK}/firebase-app.js`),
        import(`${FIREBASE_SDK}/firebase-firestore.js`),
        import(`${FIREBASE_SDK}/firebase-auth.js`)
      ]);
      fs = fsMod; au = auMod;
      const app = appMod.initializeApp(FIREBASE_CONFIG);
      try {
        db = fs.initializeFirestore(app, {
          ignoreUndefinedProperties: true,
          localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
        });
      } catch (e) {
        console.warn('Firestore offline cache unavailable, using memory cache:', e);
        db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true });
      }
      auth = au.getAuth(app);
      await auth.authStateReady();
      // A leftover accountant session must not be inherited by whoever opens the page next.
      if (auth.currentUser && !auth.currentUser.isAnonymous) await au.signOut(auth).catch(() => {});
      await ensureAnonymous();
    })().catch((e) => { initPromise = null; throw e; });
  }
  return initPromise;
}
export const cloudReady = () => !!db;

/** Anonymous sign-in for employees. Harmless if the provider is disabled (open rules still work). */
async function ensureAnonymous() {
  if (auth.currentUser) return;
  try { await au.signInAnonymously(auth); } catch (e) { console.info('Anonymous auth not enabled:', e.code); }
}

export async function signInAccountant(email, password) {
  await initCloud();
  const cred = await au.signInWithEmailAndPassword(auth, email, password);
  return cred.user.email;
}
export async function signOutAccountant() {
  if (!auth) return;
  if (auth.currentUser && !auth.currentUser.isAnonymous) await au.signOut(auth).catch(() => {});
  await ensureAnonymous();
}
export const accountantEmail = () => (auth?.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.email : null);

const collRef = (key) => fs.collection(db, COLLECTIONS[key].coll);
const docRef = (key, id) => fs.doc(db, COLLECTIONS[key].coll, String(id));
const imgRef = (shiftId, imgId) => fs.doc(db, COLLECTIONS.shifts.coll, String(shiftId), 'images', String(imgId));

/**
 * Live listener. onChange({changes:[{type,id,data}], serverIds:Set|null, fromCache}).
 * serverIds is only provided for snapshots confirmed by the server.
 */
export function listen(key, { fromDate } = {}, onChange, onError) {
  let q = collRef(key);
  if (key === 'shifts' && fromDate) q = fs.query(q, fs.where('date', '>=', fromDate));
  return fs.onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    const changes = snap.docChanges().map((c) => ({ type: c.type, id: c.doc.id, data: c.type === 'removed' ? null : c.doc.data() }));
    const fromCache = snap.metadata.fromCache;
    onChange({ changes, fromCache, serverIds: fromCache ? null : new Set(snap.docs.map((d) => d.id)) });
  }, onError);
}

export const setItem = (key, id, data) => fs.setDoc(docRef(key, id), data);
export async function updateItem(key, id, fields, fullItem) {
  try {
    await fs.updateDoc(docRef(key, id), fields);
  } catch (e) {
    if (e.code !== 'not-found' || !fullItem) throw e;
    await fs.setDoc(docRef(key, id), fullItem);
  }
}
export const deleteItem = (key, id) => fs.deleteDoc(docRef(key, id));

export const putImage = (shiftId, imgId, payload) => fs.setDoc(imgRef(shiftId, imgId), payload);
export async function getImage(shiftId, imgId) {
  const snap = await fs.getDoc(imgRef(shiftId, imgId));
  return snap.exists() ? snap.data() : null;
}
export const deleteImage = (shiftId, imgId) => fs.deleteDoc(imgRef(shiftId, imgId));

export const addAudit = (entry) => fs.addDoc(fs.collection(db, ...AUDIT_PATH), entry);
export async function listAudit(max = 200) {
  const snap = await fs.getDocs(fs.query(fs.collection(db, ...AUDIT_PATH), fs.orderBy('at', 'desc'), fs.limit(max)));
  return snap.docs.map((d) => d.data());
}

export async function getSecurity() {
  const snap = await fs.getDoc(fs.doc(db, ...SECURITY_DOC));
  return snap.exists() ? snap.data() : {};
}
export const setSecurity = (data) => fs.setDoc(fs.doc(db, ...SECURITY_DOC), data, { merge: true });
