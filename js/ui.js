// Shared UI helpers: DOM access, alerts, modals, name lookups, lightbox.
import * as store from './store.js';
import { esc } from './util.js';
import { DEFAULT_BRANDS } from './constants.js';

export const $ = (id) => document.getElementById(id);
export const session = { user: null };

/** Handlers callable from static HTML (onclick="...") and from data-act buttons. */
export const actions = {};
export function register(handlers) {
  Object.assign(actions, handlers);
  Object.assign(window, handlers);
}
/** <button data-act="name" data-id="..." data-arg="..."> — values are HTML-escaped, never inlined into JS. */
export const act = (name, id = '', arg = '') => `data-act="${name}" data-id="${esc(id)}" data-arg="${esc(arg)}"`;

const alertTimers = {};
/** `html` must already be safe (escape dynamic text with esc()). */
export function showAlert(elId, html, type, ms = 4500) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${html}</div>`;
  clearTimeout(alertTimers[elId]);
  if (ms) alertTimers[elId] = setTimeout(() => { el.innerHTML = ''; }, ms);
}
export const openModal = (id) => $(id).classList.add('active');
export const closeModal = (id) => $(id).classList.remove('active');

/** In-page replacement for prompt(): resolves with the chosen value, or null. */
export function choose({ title, text, buttons }) {
  return new Promise((resolve) => {
    $('choiceTitle').textContent = title;
    $('choiceText').textContent = text;
    const box = $('choiceButtons');
    box.innerHTML = '';
    const done = (v) => { closeModal('choiceModal'); resolve(v); };
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-block ' + (b.cls || '');
      btn.textContent = b.label;
      btn.onclick = () => done(b.value);
      box.appendChild(btn);
    }
    $('choiceClose').onclick = () => done(null);
    openModal('choiceModal');
  });
}

/* ---------- names ---------- */
export function brandName(brandOrId, lang = 'ar') {
  const b = typeof brandOrId === 'string'
    ? store.list('brands').find((x) => x.id === brandOrId) || DEFAULT_BRANDS.find((x) => x.id === brandOrId)
    : brandOrId;
  if (!b) return typeof brandOrId === 'string' ? brandOrId : '';
  return lang === 'en' ? (b.nameEn || b.nameAr || b.id) : (b.nameAr || b.nameEn || b.id);
}
export function branchName(b, lang = 'ar') {
  if (!b) return '';
  return lang === 'en' ? (b.nameEn || b.nameAr || b.name || '') : (b.nameAr || b.name || b.nameEn || '');
}
export const employeeName = branchName; // same {nameAr, nameEn, name} shape

/* ---------- lightbox ---------- */
let lbItems = [];
let lbIndex = 0;
let lbZoom = 1;

/** items: [{label, thumb, load: () => Promise<dataUrl>}] */
export function openLightbox(items, index = 0) {
  if (!items.length) return;
  lbItems = items; lbIndex = index; lbZoom = 1;
  showLightboxImage();
  $('imageLightbox').classList.add('active');
  document.body.style.overflow = 'hidden';
}
async function showLightboxImage() {
  const item = lbItems[lbIndex];
  const imgEl = $('lightboxImg');
  imgEl.style.transform = `scale(${lbZoom})`;
  imgEl.src = item.full || item.thumb || '';
  $('lightboxCounter').textContent = `${lbIndex + 1} / ${lbItems.length} · ${item.label}`;
  if (item.full) return;
  try {
    item.full = await item.load();
    if (lbItems[lbIndex] === item) imgEl.src = item.full;
  } catch (e) {
    if (lbItems[lbIndex] === item) $('lightboxCounter').textContent += ' · ⚠️ ' + e.message;
  }
}
function closeLightbox(event) {
  if (event?.target && event.target.id !== 'imageLightbox' && !event.target.classList?.contains('lightbox-close')) return;
  $('imageLightbox').classList.remove('active');
  document.body.style.overflow = '';
  lbItems = [];
}
function lightboxNav(delta, event) {
  event?.stopPropagation();
  if (!lbItems.length) return;
  lbIndex = (lbIndex + delta + lbItems.length) % lbItems.length;
  lbZoom = 1;
  showLightboxImage();
}
function lightboxZoom(factor) {
  lbZoom = Math.max(0.5, Math.min(5, lbZoom * factor));
  $('lightboxImg').style.transform = `scale(${lbZoom})`;
}
function lightboxReset() { lbZoom = 1; $('lightboxImg').style.transform = 'scale(1)'; }
function lightboxDownload() {
  const item = lbItems[lbIndex];
  if (!item?.full) return;
  const a = document.createElement('a');
  a.href = item.full;
  a.download = item.label.replace(/\s+/g, '_') + '.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
document.addEventListener('keydown', (e) => {
  if (!$('imageLightbox')?.classList.contains('active')) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxNav(-1);
  else if (e.key === 'ArrowRight') lightboxNav(1);
  else if (e.key === '+' || e.key === '=') lightboxZoom(1.25);
  else if (e.key === '-' || e.key === '_') lightboxZoom(0.8);
  else if (e.key === '0') lightboxReset();
});
register({ closeLightbox, lightboxNav, lightboxZoom, lightboxReset, lightboxDownload });

/** Lightbox items for every photo of a shift, plus the index of (category, i). */
export function shiftLightboxItems(shift, category, i) {
  const labels = { foodics: 'ورقة فودكس', cash: 'صورة الكاش', network: 'ورقة الشبكة' };
  const items = [];
  let start = 0;
  for (const cat of ['foodics', 'cash', 'network']) {
    (shift.images?.[cat] || []).forEach((img, idx) => {
      if (cat === category && idx === i) start = items.length;
      items.push({ label: `${labels[cat]} ${idx + 1}`, thumb: img.thumb || img.data || '', load: () => store.loadImageData(shift.id, img) });
    });
  }
  return { items, start };
}

export function syncStatusText(lang = 'ar') {
  const s = store.sync;
  const t = {
    ar: { disconnected: '⚪ المزامنة متوقفة', syncing: '🟡 جاري المزامنة...', connected: '🟢 متصل ومتزامن', offline: '🟠 بدون إنترنت — يُحفظ محلياً', error: '🔴 خطأ في المزامنة' },
    en: { disconnected: '⚪ Sync off', syncing: '🟡 Syncing...', connected: '🟢 Synced', offline: '🟠 Offline — saved on this device', error: '🔴 Sync error' }
  }[lang];
  let text = t[s.status] || '';
  if (s.enabled && s.pending) text += lang === 'ar' ? ` · ${s.pending} بانتظار الرفع` : ` · ${s.pending} waiting to upload`;
  if (s.status === 'error' && s.error) text += ` (${s.error})`;
  return text;
}
