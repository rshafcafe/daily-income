// Pure helpers (no DOM, no storage) — safe to import from tests.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

export function formatNum(n) {
  return round2(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const pad = (n) => String(n).padStart(2, '0');
/** YYYY-MM-DD from the device's LOCAL calendar (never UTC). */
export function isoLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Business day: the day ends at 02:30, so earlier times belong to the previous date. */
export function businessDate(now = new Date()) {
  const d = new Date(now.getTime());
  if (d.getHours() < 2 || (d.getHours() === 2 && d.getMinutes() < 30)) d.setDate(d.getDate() - 1);
  return isoLocal(d);
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoLocal(new Date(y, m - 1, d + n, 12));
}
/** {from,to} for the quick-filter buttons, relative to a business date. */
export function periodRange(period, today = businessDate()) {
  switch (period) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case 'week': return { from: addDays(today, -6), to: today };
    case 'month': return { from: today.slice(0, 8) + '01', to: today };
    default: return { from: '', to: '' };
  }
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export function formatArabicDate(iso) {
  const p = String(iso || '').split('-');
  const mi = parseInt(p[1], 10) - 1;
  if (p.length !== 3 || !(mi >= 0 && mi <= 11)) return iso || '';
  return `${parseInt(p[2], 10)} ${AR_MONTHS[mi]} ${p[0]}`;
}
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function formatDateEN(iso) {
  const p = String(iso || '').split('-').map(Number);
  if (p.length !== 3 || p.some(Number.isNaN)) return iso || '';
  return `${iso} · ${EN_DAYS[new Date(p[0], p[1] - 1, p[2], 12).getDay()]}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Numeric, time-ordered, collision-safe across devices (stays below 2^53). */
export function newNumericId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}
export const sid = (id) => String(id);

/** Filesystem-safe name for ZIP folders/files. */
export function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').trim() || 'unnamed';
}

/** Deep clone of plain JSON data. */
export const clone = (o) => JSON.parse(JSON.stringify(o));
