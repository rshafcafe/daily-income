// Entry point: boot, login/logout, click delegation.
import * as store from './store.js';
import { LEGACY_ACCOUNTANT } from './constants.js';
import { $, session, actions, register, employeeName, syncStatusText } from './ui.js';
import { enterEmployeeApp, refreshEmployee, leaveEmployeeApp } from './employee.js';
import { enterAccountantApp, refreshAccountant, leaveAccountantApp } from './accountant.js';

let pin = '';
let lastPress = 0;
let fails = 0;
let lockedUntil = 0;

const loginError = (id, text) => { const el = $(id); el.textContent = text; el.classList.toggle('show', !!text); };

/* ---------- PIN login ---------- */
function updatePinDisplay() {
  document.querySelectorAll('#pinDisplay .pin-dot').forEach((d, i) => d.classList.toggle('filled', i < pin.length));
}
function debounced() {
  const now = Date.now();
  if (now - lastPress < 80) return true;      // touchstart + click double fire on some phones
  lastPress = now;
  return false;
}
function pinPress(digit) {
  if (debounced() || pin.length >= 5) return;
  pin += digit;
  updatePinDisplay();
  if (pin.length === 5) setTimeout(tryPinLogin, 150);
}
function pinDelete() {
  if (debounced()) return;
  pin = pin.slice(0, -1);
  updatePinDisplay();
}
function pinClear() {
  pin = '';
  updatePinDisplay();
  loginError('loginError', '');
}
async function tryPinLogin() {
  await boot;
  const fail = (text) => { loginError('loginError', text); setTimeout(() => { pin = ''; updatePinDisplay(); }, 800); };
  if (Date.now() < lockedUntil) return fail(`⚠ محاولات كثيرة — انتظر ${Math.ceil((lockedUntil - Date.now()) / 1000)} ثانية / Too many attempts`);
  const emp = store.list('employees').find((e) => e.pin && e.pin === pin);
  if (!emp) {
    if (store.sync.enabled && store.sync.status === 'syncing') return fail('⏳ جاري تحميل البيانات، حاول بعد لحظات / Loading data, try again');
    if (++fails >= 5) { fails = 0; lockedUntil = Date.now() + 30000; }
    return fail('⚠ رقم غير صحيح / Invalid PIN');
  }
  fails = 0;
  session.user = { type: 'employee', ...emp };
  store.setActor({ type: 'employee', id: emp.id, name: employeeName(emp, 'ar') || employeeName(emp, 'en') });
  enterEmployeeApp();
}

/* ---------- accountant login ---------- */
function showAccountantLogin() {
  $('pinLoginView').style.display = 'none';
  $('accLoginView').classList.add('show');
  $('accUsername').focus();
}
function showPinLogin() {
  $('pinLoginView').style.display = 'block';
  $('accLoginView').classList.remove('show');
}
const AUTH_ERRORS = {
  'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة',
  'auth/wrong-password': 'البريد أو كلمة المرور غير صحيحة',
  'auth/user-not-found': 'البريد أو كلمة المرور غير صحيحة',
  'auth/invalid-email': 'صيغة البريد الإلكتروني غير صحيحة',
  'auth/too-many-requests': 'محاولات كثيرة، حاول لاحقاً',
  'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت',
  'auth/operation-not-allowed': 'تسجيل الدخول بالبريد غير مفعّل في Firebase Console (Authentication ← Sign-in method ← Email/Password)'
};
async function handleAccountantLogin() {
  await boot;
  const username = $('accUsername').value.trim();
  const password = $('accPassword').value;
  const btn = $('accLoginBtn');
  loginError('accLoginError', '');
  if (!username || !password) return loginError('accLoginError', '⚠ أدخل بيانات الدخول');

  if (!username.includes('@')) {
    const legacyOk = store.legacyLoginAllowed() && username === LEGACY_ACCOUNTANT.username && password === LEGACY_ACCOUNTANT.password;
    if (!legacyOk) {
      return loginError('accLoginError', store.legacyLoginAllowed() ? '⚠ بيانات الدخول غير صحيحة' : '⚠ الدخول القديم مُقفل — ادخل بالبريد الإلكتروني وكلمة المرور');
    }
    session.user = { type: 'accountant', legacy: true };
    store.setActor({ type: 'accountant' });
    return enterAccountantApp();
  }
  btn.disabled = true;
  try {
    const email = await store.loginAccountant(username, password);
    session.user = { type: 'accountant', email };
    store.setActor({ type: 'accountant', email });
    $('accPassword').value = '';
    enterAccountantApp();
  } catch (e) {
    loginError('accLoginError', '⚠ ' + (AUTH_ERRORS[e.code] || e.message));
  } finally {
    btn.disabled = false;
  }
}

function logout() {
  const wasAccountant = session.user?.type === 'accountant' && !session.user.legacy;
  leaveEmployeeApp();
  leaveAccountantApp();
  session.user = null;
  store.setActor(null);
  if (wasAccountant) store.logoutAccountant();
  document.body.classList.remove('ar');
  document.querySelectorAll('.app').forEach((a) => a.classList.remove('active'));
  $('loginScreen').style.display = 'flex';
  showPinLogin();
  pinClear();
  $('accUsername').value = '';
  $('accPassword').value = '';
  loginError('accLoginError', '');
}

register({ pinPress, pinDelete, pinClear, showAccountantLogin, showPinLogin, handleAccountantLogin, logout });

/* ---------- global events ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset.id, el.dataset.arg, el);
});
document.addEventListener('keydown', (e) => {
  if ($('loginScreen').style.display === 'none') return;
  const accountantView = $('accLoginView').classList.contains('show');
  if (accountantView) { if (e.key === 'Enter') handleAccountantLogin(); return; }
  if (/^[0-9]$/.test(e.key)) { lastPress = 0; pinPress(e.key); } else if (e.key === 'Backspace') { lastPress = 0; pinDelete(); }
});
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled error:', e.reason));

/* ---------- boot ---------- */
const boot = (async () => {
  await store.initStore();
  store.subscribe((what) => {
    refreshEmployee(what);
    refreshAccountant(what);
    if (!session.user) $('loginSyncNote').textContent = store.sync.enabled ? syncStatusText('ar') : '';
  });
  store.startSync();
})();
boot.catch((e) => {
  console.error('Startup failed:', e);
  loginError('loginError', '⚠ تعذر تشغيل النظام: ' + e.message);
});
