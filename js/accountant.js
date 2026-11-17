// Accountant app (Arabic, RTL): dashboard, shifts review, OCR, management, exports.
import * as store from './store.js';
import { SHIFT_NAMES, SHIFT_TYPES, IMAGE_CATS } from './constants.js';
import {
  sortMethods, methodsInUse, methodLabel, sumPayments, imageCount, countsAsIncome,
  filterShifts, computeComparisons, diffFields
} from './logic.js';
import { esc, num, round2, formatNum, periodRange, sanitizeName, sid, isoLocal } from './util.js';
import * as ocr from './ocr.js';
import { exportExcel, loadScript } from './excel.js';
import { dataUrlParts } from './images.js';
import {
  $, session, register, act, showAlert, openModal, closeModal, brandName, branchName, employeeName,
  openLightbox, shiftLightboxItems, syncStatusText
} from './ui.js';

const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const PAGE = 100;

let activeTab = 'dashboard';
let shiftsLimit = PAGE;
let editingShiftId = null;
let editingEmployeeId = null;
let editingBranchId = null;
let editingBrandId = null;
let editingPmId = null;
let batchRunning = false;
let batchCancelled = false;

const allMethods = () => store.list('paymentMethods');
const shiftAr = (code) => SHIFT_NAMES[code]?.ar || code || '—';
const val = (id) => $(id).value;
const empty = (cols, icon, text) => `<tr><td colspan="${cols}"><div class="empty-state"><div class="icon">${icon}</div>${text}</div></td></tr>`;
const signed = (n) => (n >= 0 ? '+' : '') + formatNum(n);
const diffClass = (n, tol = 0.005) => (Math.abs(n) < tol ? 'diff-zero' : n > 0 ? 'diff-positive' : 'diff-negative');

/* ================= entering / refreshing ================= */
export function enterAccountantApp() {
  document.body.classList.add('ar');
  $('loginScreen').style.display = 'none';
  $('accountantApp').classList.add('active');
  const u = session.user;
  $('accUserLabel').textContent = u.email || 'المحاسب';
  $('accSecurityBanner').innerHTML = u.legacy ? `
    <div class="alert alert-danger" style="flex-direction: column; align-items: stretch; line-height: 1.8;">
      <strong>⚠️ أنت داخل بكلمة المرور القديمة المكتوبة داخل الكود (غير آمنة).</strong>
      <span style="font-size: 12px;">أنشئ حساب المحاسب من Firebase Console ← Authentication ← Email/Password، ثم ادخل بالبريد وكلمة المرور.
      بعد أول دخول ناجح بالحساب الجديد يُقفل الدخول القديم تلقائياً على كل الأجهزة. التفاصيل في ملف README.</span>
    </div>` : '';
  refreshDropdowns();
  if (!val('filterDateFrom') && !val('filterDateTo')) setRange('filter', 'month');
  shiftsLimit = PAGE;
  switchTab('dashboard', document.querySelector('#accountantApp .tab'));   // always start on the dashboard
  updateSyncUI();
  updateApiKeyUI();
}

/** Store subscriber: redraw only what is visible. */
export function refreshAccountant(what) {
  if (session.user?.type !== 'accountant') return;
  if (['brands', 'branches', 'employees', 'paymentMethods'].some((k) => what.has(k))) refreshDropdowns();
  if (what.has('sync')) updateSyncUI();
  if ([...what].some((k) => k !== 'sync')) renderActive();
}

function renderActive() {
  switch (activeTab) {
    case 'dashboard': renderDashboard(); break;
    case 'shifts': renderShiftsTable(); break;
    case 'summary': renderBranchSummary(); break;
    case 'employees': renderEmployeesTable(); renderBranchesTable(); break;
    case 'payments': renderPaymentMethodsTable(); break;
    case 'brands': renderBrandsTable(); break;
    default: break;
  }
}

function switchTab(name, btn) {
  document.querySelectorAll('#accountantApp .tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('#accountantApp .tab-content').forEach((c) => { c.style.display = 'none'; });
  btn?.classList.add('active');
  $('tab' + name.charAt(0).toUpperCase() + name.slice(1)).style.display = 'block';
  activeTab = name;
  renderActive();
  if (name === 'audit') renderAudit();
}

function fillSelect(id, options, firstLabel) {
  const sel = $(id);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = (firstLabel ? `<option value="">${firstLabel}</option>` : '') +
    options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}
function refreshDropdowns() {
  const brands = store.list('brands').map((b) => [b.id, brandName(b)]);
  const branches = store.list('branches').map((b) => [b.id, branchName(b)]);
  fillSelect('filterBrand', brands, 'كل البراندات');
  fillSelect('empFormBrand', brands);
  fillSelect('branchFormBrand', brands);
  for (const id of ['filterBranch', 'batchBranch', 'exportBranch']) fillSelect(id, branches, 'كل الفروع');
}

/* ================= filters ================= */
const filters = () => ({ from: val('filterDateFrom'), to: val('filterDateTo'), brand: val('filterBrand'), branch: val('filterBranch') });
const filtered = () => filterShifts(store.list('shifts'), filters());

function setRange(prefix, period) {
  const { from, to } = periodRange(period);
  $(prefix + 'DateFrom').value = from;
  $(prefix + 'DateTo').value = to;
}
async function applyFilters() {
  shiftsLimit = PAGE;
  renderActive();
  await store.ensureShiftWindow(val('filterDateFrom'));   // loads older shifts from the cloud when needed
  renderActive();
}
function resetFilters() {
  for (const id of ['filterDateFrom', 'filterDateTo', 'filterBrand', 'filterBranch']) $(id).value = '';
  applyFilters();
}
function quickFilter(period) { setRange('filter', period); applyFilters(); }
const setBatchDate = (period) => setRange('batch', period);
const setExportDate = (period) => setRange('export', period);

/* ================= dashboard / tables ================= */
function renderDashboard() {
  const shifts = filtered();
  const income = shifts.filter(countsAsIncome);
  const total = (list) => formatNum(list.reduce((s, x) => s + num(x.total), 0));
  const kinds = ['success', 'warning', '', 'info'];
  const cards = [
    `<div class="stat-card info"><div class="stat-label">إجمالي الدخل</div><div class="stat-value">${total(income)}</div><div class="stat-extra">ريال</div></div>`,
    ...store.list('brands').map((b, i) => `<div class="stat-card ${kinds[i % kinds.length]}"><div class="stat-label">دخل ${esc(brandName(b))}</div>
      <div class="stat-value">${total(income.filter((s) => s.brand === b.id))}</div><div class="stat-extra">ريال</div></div>`),
    `<div class="stat-card"><div class="stat-label">عدد الشفتات</div><div class="stat-value">${shifts.length}</div>
      <div class="stat-extra">شفت${shifts.length - income.length ? ` · منها ${shifts.length - income.length} جرد مفاجئ (لا يُحسب في الدخل)` : ''}</div></div>`
  ];
  $('statsGrid').innerHTML = cards.join('');
  const from = store.shiftWindowFrom();
  $('loadedRangeNote').textContent = store.sync.enabled && from
    ? `الشفتات المحمّلة من السحابة: من ${from} حتى اليوم. اختر تاريخاً أقدم أو "الكل" لتحميل ما قبلها.` : '';
}

function statusBadge(s, cmp) {
  if (cmp.hasOcr) {
    return cmp.alerts.length === 0 ? '<span class="badge badge-success">✓ مطابق</span>' : `<span class="badge badge-danger">⚠️ ${cmp.alerts.length}</span>`;
  }
  return imageCount(s) > 0 ? '<span class="badge badge-warning">يحتاج مراجعة</span>' : '<span class="badge badge-neutral">—</span>';
}

function renderShiftsTable() {
  const shifts = filtered().sort((a, b) => b.date.localeCompare(a.date) || String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  const tbody = $('shiftsTableBody');
  const more = $('shiftsMore');
  if (!shifts.length) {
    tbody.innerHTML = empty(9, '📭', 'لا توجد شفتات');
    more.innerHTML = '';
    return;
  }
  const methods = allMethods();
  tbody.innerHTML = shifts.slice(0, shiftsLimit).map((s) => `
    <tr>
      <td>${esc(s.date)}</td>
      <td><span class="badge badge-accent">${esc(brandName(s.brand))}</span></td>
      <td>${esc(s.branchNameAr || s.branchName || '')}</td>
      <td><span class="badge badge-info">${esc(shiftAr(s.shift))}</span>${s.isSurprise ? ' <span class="badge badge-warning">🔍 جرد مفاجئ</span>' : ''}</td>
      <td>${esc(s.employeeNameAr || s.employeeName || '')}</td>
      <td class="num">${formatNum(s.total)} ر.س</td>
      <td><span class="badge badge-neutral">${imageCount(s)} 📷</span></td>
      <td>${statusBadge(s, computeComparisons(s, methods))}</td>
      <td><button class="btn btn-sm" ${act('openShiftModal', s.id)}>عرض</button></td>
    </tr>`).join('');
  more.innerHTML = shifts.length > shiftsLimit
    ? `<button class="btn btn-secondary btn-sm" ${act('showMoreShifts')}>عرض المزيد (${shifts.length - shiftsLimit} متبقي)</button>` : '';
}
function showMoreShifts() { shiftsLimit += PAGE; renderShiftsTable(); }

function renderBranchSummary() {
  const shifts = filtered().filter(countsAsIncome);
  const container = $('branchSummary');
  if (!shifts.length) {
    container.innerHTML = '<div class="empty-state"><div class="icon">📭</div>لا توجد بيانات</div>';
    return;
  }
  const methods = methodsInUse(allMethods(), shifts.map((s) => s.payments));
  const by = new Map();
  for (const s of shifts) {
    if (!by.has(s.branchId)) {
      by.set(s.branchId, { name: s.branchNameAr || s.branchName || '', brand: s.brand, shifts: { morning: 0, evening: 0, saudi: 0 }, total: 0, count: 0, payments: {} });
    }
    const b = by.get(s.branchId);
    b.shifts[s.shift] = (b.shifts[s.shift] || 0) + num(s.total);
    b.total += num(s.total);
    b.count++;
    for (const m of methods) b.payments[m.id] = (b.payments[m.id] || 0) + num(s.payments?.[m.id]);
  }
  const rows = [...by.values()].sort((a, b) => b.total - a.total);
  const grand = rows.reduce((s, b) => s + b.total, 0);
  container.innerHTML = `
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>الفرع</th><th>البراند</th><th>صباحي</th><th>مسائي</th><th>سعودي</th><th>الإجمالي</th><th>عدد الشفتات</th></tr></thead>
      <tbody>
        ${rows.map((b) => `<tr>
          <td><strong>${esc(b.name)}</strong></td>
          <td><span class="badge badge-accent">${esc(brandName(b.brand))}</span></td>
          <td class="num">${formatNum(b.shifts.morning)}</td><td class="num">${formatNum(b.shifts.evening)}</td><td class="num">${formatNum(b.shifts.saudi)}</td>
          <td class="num"><strong>${formatNum(b.total)}</strong></td><td>${b.count}</td>
        </tr>`).join('')}
        <tr style="background: var(--bg-3); font-weight: 800;"><td colspan="5"><strong>الإجمالي الكلي</strong></td>
          <td class="num"><strong>${formatNum(grand)}</strong></td><td></td></tr>
      </tbody>
    </table></div>
    <div class="card" style="margin-top: 16px;">
      <div class="card-title"><span class="icon">💳</span> توزيع المدفوعات حسب الفرع</div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>الفرع</th>${methods.map((m) => `<th>${esc(methodLabel(m, 'ar'))}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((b) => `<tr><td><strong>${esc(b.name)}</strong></td>${methods.map((m) => `<td class="num">${formatNum(b.payments[m.id])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

/* ================= shift modal ================= */
function cashDetailsHtml(details) {
  return (details || []).map((d, i) => {
    const parts = [];
    for (const n of [500, 200, 100, 50, 20, 10, 5, 1]) if (d['count_' + n]) parts.push(`${d['count_' + n]}×${n}`);
    if (d.coins_1sar) parts.push(`${d.coins_1sar}×عملة1ر`);
    if (d.coins_2sar) parts.push(`${d.coins_2sar}×عملة2ر`);
    if (d.coins_halala) parts.push(`هللة=${d.coins_halala}ر`);
    if (!d.coins_1sar && !d.coins_2sar && !d.coins_halala && d.coins_total) parts.push(`عملات=${d.coins_total}`);
    const color = d.confidence === 'high' ? 'var(--success)' : d.confidence === 'medium' ? 'var(--warning)' : 'var(--danger)';
    const items = d.items_seen?.length
      ? `<div style="font-size:10px;color:var(--text-3);margin-top:4px;padding-inline-start:14px;">📋 ${d.items_seen.map(esc).join(' · ')}</div>` : '';
    return `<div style="font-size:11px;color:var(--text-2);margin-top:8px;">
      <span style="color:${color};">●</span> صورة ${i + 1}: ${esc(parts.join(' + ') || 'لم يتم التعرف')} = <strong>${formatNum(d.total)}</strong> ريال (دقة: ${esc(d.confidence)})${items}</div>`;
  }).join('');
}

function threeWayRow(label, c, photoTol) {
  if (!c) return '';
  const cell = (v, tol) => {
    if (v === null) return '<td class="num">—</td>';
    const ok = Math.abs(v) < tol;
    return `<td class="num ${ok ? 'diff-zero' : v > 0 ? 'diff-positive' : 'diff-negative'}">${signed(v)}
      <span class="badge ${ok ? 'badge-success">✓' : 'badge-danger">⚠️'}</span></td>`;
  };
  return `<tr><td><strong>${label}</strong></td>
    <td class="num">${c.foodics !== null ? formatNum(c.foodics) : '—'}</td>
    <td class="num">${c.photo > 0 ? formatNum(c.photo) : '—'}</td>
    <td class="num">${formatNum(c.written)}</td>
    ${cell(c.foodicsVsWritten, 1)}${cell(c.photoVsWritten, photoTol)}</tr>`;
}

function ocrSectionHtml(shift, cmp) {
  if (!cmp.hasOcr) {
    return `<div class="card" style="background: var(--bg-3); border-color: var(--info);">
      <div class="card-title"><span class="icon">🤖</span> قراءة الصور بالذكاء الاصطناعي</div>
      <p style="color: var(--text-2); font-size: 13px; margin-bottom: 12px;">لم يتم قراءة الصور بعد. اضغط الزر لاستخراج الأرقام من الصور تلقائياً ومقارنتها بما كتبه الموظف.</p>
      <button class="btn" ${act('runOcrOnShift')}>🔍 قراءة الصور وعمل المقارنة</button>
      <button class="btn btn-secondary" ${act('openOcrEditModal')}>✏️ إدخال أرقام البرنامج يدوياً</button>
      <div id="ocrStatus" style="margin-top: 10px;"></div></div>`;
  }
  const ocrData = shift.ocrData;
  const c2 = cmp.programVsActual;
  const threeWay = `<div class="card" style="background: var(--bg-3);">
      <div class="card-title"><span class="icon">🔍</span> المقارنة الثلاثية: فودكس vs الصورة vs المكتوب</div>
      <div class="table-wrap"><table class="data-table" style="margin: 0;">
        <thead><tr><th>البند</th><th>فودكس (المرجع)</th><th>الصورة</th><th>كتب الموظف</th><th>فودكس vs المكتوب</th><th>الصورة vs المكتوب</th></tr></thead>
        <tbody>${threeWayRow('الكاش 💵', cmp.threeWayCash, 10)}${threeWayRow('الشبكة 💳', cmp.threeWayMada, 1)}</tbody>
      </table></div>
      ${cmp.threeWayCash?.cashDetails?.length ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
        <div style="font-size:12px;color:var(--text-2);font-weight:600;margin-bottom:6px;">📊 تفاصيل عد الفلوس من الصور:</div>${cashDetailsHtml(cmp.threeWayCash.cashDetails)}</div>` : ''}
    </div>`;
  const programTable = c2 ? `<div class="card" style="background: var(--bg-3);">
      <div class="card-title"><span class="icon">⚖️</span> البرنامج (فودكس) vs الفعلي (الموظف)</div>
      <div class="table-wrap"><table class="data-table" style="margin: 0;">
        <thead><tr><th>البند</th><th>البرنامج</th><th>الفعلي</th><th>الفرق</th><th>الحالة</th></tr></thead>
        <tbody>
          ${c2.fields.map((f) => `<tr><td>${esc(methodLabel(f.method, 'ar'))}</td>
            <td class="num">${formatNum(f.program)}</td><td class="num">${formatNum(f.actual)}</td>
            <td class="num ${diffClass(f.diff)}">${signed(f.diff)}</td>
            <td>${f.match ? '<span class="badge badge-success">✓</span>' : '<span class="badge badge-warning">⚠️</span>'}</td></tr>`).join('')}
          <tr style="background: var(--bg); font-weight: 800;"><td><strong>الإجمالي</strong></td>
            <td class="num"><strong>${formatNum(c2.programTotal)}</strong></td><td class="num"><strong>${formatNum(c2.actualTotal)}</strong></td>
            <td class="num ${diffClass(c2.diff)}"><strong>${signed(c2.diff)}</strong></td>
            <td>${c2.match ? '<span class="badge badge-success">مطابق</span>' : `<span class="badge ${c2.diff > 0 ? 'badge-success">زيادة' : 'badge-danger">عجز'}</span>`}</td></tr>
        </tbody>
      </table></div>
      ${ocrData.foodicsTotal ? `<div style="font-size:11px;color:var(--text-3);margin-top:8px;">Total Payments المطبوع على الورقة: ${formatNum(ocrData.foodicsTotal)}</div>` : ''}
    </div>` : '';
  const errors = ocrData.errors?.length
    ? `<div class="alert alert-danger" style="font-size:12px;flex-direction:column;align-items:stretch;">تعذرت قراءة بعض الصور:<ul style="margin:4px 0;padding-inline-start:20px;">${ocrData.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '';
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 12px;">
      <h3 style="font-size:15px;margin:0;">🔍 نتائج قراءة الصور ${ocrData.manuallyEdited ? '<span class="badge badge-info">معدّلة يدوياً</span>' : ''}</h3>
      <button class="btn btn-sm btn-secondary" ${act('runOcrOnShift')}>🔄 إعادة القراءة</button>
    </div>
    ${errors}${threeWay}${programTable}
    <div style="margin-top:12px;"><button class="btn btn-sm btn-secondary" ${act('openOcrEditModal')}>✏️ تعديل قراءات الصور يدوياً</button></div>
    <div id="ocrStatus" style="margin-top:10px;"></div>`;
}

function galleryHtml(shift, cat, label) {
  const imgs = shift.images?.[cat] || [];
  if (!imgs.length) return `<div class="image-gallery-section"><h4>${label}</h4><div style="color:var(--text-3);font-size:12px;">لا توجد صور</div></div>`;
  return `<div class="image-gallery-section"><h4>${label} (${imgs.length})</h4><div class="image-gallery">
    ${imgs.map((img, i) => `<img src="${esc(img.thumb || img.data || '')}" alt="" loading="lazy" style="cursor:zoom-in;" ${act('openShiftLightbox', cat, i)}>`).join('')}
  </div></div>`;
}

function openShiftModal(id) {
  const shift = store.get('shifts', id);
  if (!shift) return;
  editingShiftId = sid(id);
  const methods = allMethods();
  const cmp = computeComparisons(shift, methods);
  const editable = methodsInUse(methods, [shift.payments]);
  const alerts = cmp.alerts.length
    ? `<div class="alert alert-danger" style="flex-direction:column;align-items:stretch;"><div style="font-weight:700;margin-bottom:8px;">⚠️ تنبيهات عدم تطابق:</div>
        <ul style="margin:0;padding-inline-start:20px;">${cmp.alerts.map((a) => `<li style="margin-bottom:4px;">${esc(a)}</li>`).join('')}</ul></div>`
    : cmp.hasOcr ? '<div class="alert alert-success">✓ كل البيانات مطابقة - لا توجد فروقات</div>' : '';

  $('shiftModalBody').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px;">
      <div><strong>التاريخ:</strong> ${esc(shift.date)}</div>
      <div><strong>البراند:</strong> ${esc(brandName(shift.brand))}</div>
      <div><strong>الفرع:</strong> ${esc(shift.branchNameAr || shift.branchName || '')}</div>
      <div><strong>الشفت:</strong> ${esc(shiftAr(shift.shift))}${shift.isSurprise ? ' <span class="badge badge-warning">🔍 جرد مفاجئ</span>' : ''}</div>
      <div style="grid-column:1/-1;"><strong>الموظف:</strong> ${esc(shift.employeeNameAr || shift.employeeName || '')}</div>
      <div style="grid-column:1/-1;font-size:11px;color:var(--text-3);">أُرسل: ${esc(fmtTime(shift.submittedAt))}${shift.updatedAt ? ' · آخر تعديل: ' + esc(fmtTime(shift.updatedAt)) : ''}</div>
    </div>
    ${alerts}
    <div class="card" style="background: var(--bg-3);">
      <div class="card-title"><span class="icon">💰</span> المدفوعات (قابلة للتعديل)</div>
      <div class="payments-grid" id="modalPayments">
        ${editable.map((m) => `<div class="pay-input"><label>${esc(methodLabel(m, 'ar'))}${m.active === false ? ' (معطّلة)' : ''}</label>
          <input type="number" step="0.01" data-payment-id="${esc(m.id)}" value="${num(shift.payments?.[m.id])}"></div>`).join('')}
      </div>
      <div class="total-card"><div class="label">الإجمالي</div>
        <div><span class="value" id="modalTotal">${formatNum(shift.total)}</span> <span class="currency">ريال</span></div></div>
    </div>
    ${ocrSectionHtml(shift, cmp)}
    <div style="margin-top:20px;">${galleryHtml(shift, 'foodics', '🧾 ورقة فودكس')}${galleryHtml(shift, 'cash', '💵 الكاش')}${galleryHtml(shift, 'network', '💳 ورقة الشبكة')}</div>
    ${shift.notes ? `<div style="margin-top:16px;"><h4 style="font-size:12px;color:var(--text-2);margin-bottom:6px;">📝 ملاحظات الموظف</h4>
      <div style="background:var(--bg-3);padding:10px;border-radius:8px;font-size:13px;white-space:pre-wrap;">${esc(shift.notes)}</div></div>` : ''}`;
  $('modalPayments').addEventListener('input', () => { $('modalTotal').textContent = formatNum(sumPayments(readModalPayments())); });
  openModal('shiftModal');
}
function fmtTime(iso) {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? `${isoLocal(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—';
}
function readModalPayments() {
  const out = {};
  $('modalPayments').querySelectorAll('input[data-payment-id]').forEach((i) => { out[i.dataset.paymentId] = round2(i.value); });
  return out;
}
function openShiftLightbox(category, index) {
  const shift = store.get('shifts', editingShiftId);
  if (!shift) return;
  const { items, start } = shiftLightboxItems(shift, category, Number(index));
  openLightbox(items, start);
}
async function saveShiftEdits() {
  const shift = store.get('shifts', editingShiftId);
  if (!shift) return;
  const payments = { ...(shift.payments || {}), ...readModalPayments() };
  const next = { payments, total: sumPayments(payments) };
  const changes = diffFields(shift, next, ['payments', 'total']);
  if (Object.keys(changes).length) {
    await store.patch('shifts', shift.id, { ...next, updatedAt: new Date().toISOString() },
      { action: 'update', summary: `تعديل المحاسب لمدفوعات شفت ${shift.date} - ${shift.branchNameAr || ''}`, changes });
  }
  closeShiftModal();
  showAlert('accAlert', '✓ تم حفظ التعديلات', 'success');
}
async function deleteShift() {
  const shift = store.get('shifts', editingShiftId);
  if (!shift || !confirm('هل أنت متأكد من حذف هذا الشفت؟ سيُحذف من كل الأجهزة.')) return;
  await store.remove('shifts', shift.id, {
    action: 'delete', summary: `حذف شفت ${shift.date} - ${shift.branchNameAr || ''} - ${shiftAr(shift.shift)}`,
    changes: { total: [shift.total, null], payments: [shift.payments, null] }
  });
  closeShiftModal();
  showAlert('accAlert', '✓ تم حذف الشفت', 'success');
}
function closeShiftModal() { closeModal('shiftModal'); editingShiftId = null; }

/* ================= OCR ================= */
const loaderFor = (shift) => (img) => store.loadImageData(shift.id, img);
const saveOcr = (shift, ocrData, action = 'ocr') => store.patch('shifts', shift.id, { ocrData },
  { action, summary: `${action === 'ocr' ? 'قراءة صور' : 'تعديل يدوي لقراءات'} شفت ${shift.date} - ${shift.branchNameAr || ''}` });

async function runOcrOnShift() {
  const id = editingShiftId;
  const shift = store.get('shifts', id);
  if (!shift) return;
  if (!imageCount(shift)) return alert('لا توجد صور في هذا الشفت');
  const status = (html, type = 'info') => { const el = $('ocrStatus'); if (el) el.innerHTML = `<div class="alert alert-${type}">${html}</div>`; };
  status('⏳ بدء قراءة الصور...');
  try {
    const ocrData = await ocr.ocrShiftImages(shift, allMethods(), loaderFor(shift), (msg) => status('⏳ ' + esc(msg)));
    await saveOcr(shift, ocrData);
    if (editingShiftId === id) openShiftModal(id);
  } catch (e) {
    status('✗ فشل: ' + esc(e.message), 'danger');
  }
}

function openOcrEditModal() {
  const shift = store.get('shifts', editingShiftId);
  if (!shift) return;
  const o = shift.ocrData || {};
  const f = o.foodics || {};
  $('ocrFoodicsGrid').innerHTML = methodsInUse(allMethods(), [f]).map((m) => `
    <div class="pay-input"><label>${esc(m.nameEn || m.id)}${m.nameAr ? ' / ' + esc(m.nameAr) : ''}</label>
      <input type="number" step="0.01" data-payment-id="${esc(m.id)}" value="${num(f[m.id])}"></div>`).join('');
  $('ocr_cash_image').value = num(o.cashImage);
  $('ocr_network_image').value = num(o.networkImage);
  openModal('ocrEditModal');
}
const closeOcrEditModal = () => closeModal('ocrEditModal');
async function saveOcrEdits() {
  const id = editingShiftId;
  const shift = store.get('shifts', id);
  if (!shift) return;
  const foodics = { ...(shift.ocrData?.foodics || {}) };
  $('ocrFoodicsGrid').querySelectorAll('input[data-payment-id]').forEach((i) => { foodics[i.dataset.paymentId] = round2(i.value); });
  const ocrData = {
    ...(shift.ocrData || {}), foodics, errors: [], warnings: [],
    cashImage: round2(val('ocr_cash_image')), networkImage: round2(val('ocr_network_image')), manuallyEdited: true
  };
  delete ocrData.foodicsTotal;
  await saveOcr(shift, ocrData, 'ocr-edit');
  closeOcrEditModal();
  showAlert('accAlert', '✓ تم حفظ التعديلات', 'success');
  openShiftModal(id);
}

/* ---------- batch OCR ---------- */
function scopeShifts(prefix, onlyPending) {
  const from = val(prefix + 'DateFrom');
  const to = val(prefix + 'DateTo');
  const branch = val(prefix + 'Branch');
  return filterShifts(store.list('shifts'), { from, to, branch })
    .filter((s) => imageCount(s) > 0 && !(onlyPending && s.ocrData))
    .sort((a, b) => a.date.localeCompare(b.date));
}
const batchScope = () => scopeShifts('batch', val('batchScope') === 'pending');
const totalImages = (shifts) => shifts.reduce((n, s) => n + imageCount(s), 0);
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

async function previewBatchScope() {
  await store.ensureShiftWindow(val('batchDateFrom'));
  const shifts = batchScope();
  if (!shifts.length) { $('batchStatus').innerHTML = '<div class="alert alert-info">لا توجد شفتات تطابق المعايير المحددة</div>'; return; }
  const n = totalImages(shifts);
  $('batchStatus').innerHTML = `<div class="alert alert-info" style="flex-direction:column;align-items:stretch;">
    <div>📊 <strong>${shifts.length}</strong> شفت · <strong>${n}</strong> صورة · الوقت المتوقع ~${Math.max(1, Math.ceil(n * 4 / 60))} دقيقة</div>
    <div style="margin-top:10px;max-height:200px;overflow-y:auto;"><table class="data-table" style="font-size:12px;">
      <thead><tr><th>التاريخ</th><th>الفرع</th><th>الشفت</th><th>صور</th></tr></thead>
      <tbody>${shifts.map((s) => `<tr><td>${esc(s.date)}</td><td>${esc(s.branchNameAr || s.branchName || '')}</td><td>${esc(shiftAr(s.shift))}</td><td>${imageCount(s)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
}

async function startBatchOcr() {
  if (batchRunning) { batchCancelled = true; return; }
  if (!ocr.getApiKey()) return alert('⚠️ لم يتم إعداد Gemini API Key. اذهب لتبويب "إدارة البراندات" وأضف المفتاح.');
  await store.ensureShiftWindow(val('batchDateFrom'));
  const shifts = batchScope();
  const statusEl = $('batchStatus');
  if (!shifts.length) { statusEl.innerHTML = '<div class="alert alert-danger">لا توجد شفتات تطابق المعايير</div>'; return; }
  if (!confirm(`سيتم قراءة ${shifts.length} شفت (${totalImages(shifts)} صورة).\n\nهل تريد المتابعة؟`)) return;

  batchRunning = true; batchCancelled = false;
  const btn = $('batchStartBtn');
  btn.textContent = '⏹️ إيقاف القراءة';
  btn.classList.add('btn-danger');
  const started = Date.now();
  const failures = [];
  let ok = 0;
  let done = 0;
  for (const shift of shifts) {
    if (batchCancelled) break;
    const title = `${shift.branchNameAr || shift.branchName || ''} · ${shiftAr(shift.shift)} · ${shift.date}`;
    statusEl.innerHTML = `<div class="alert alert-info" style="flex-direction:column;align-items:stretch;">
      <div><strong>⏳ جاري القراءة...</strong> (${done + 1}/${shifts.length})</div>
      <div style="margin-top:6px;font-size:13px;">📍 ${esc(title)}</div>
      <div id="batchSubStatus" style="margin-top:6px;font-size:12px;color:var(--text-2);">بدء القراءة...</div>
      <div style="margin-top:8px;background:var(--bg);border-radius:6px;overflow:hidden;height:8px;">
        <div style="background:var(--accent);height:100%;width:${(done / shifts.length) * 100}%;"></div></div>
      <div style="margin-top:6px;font-size:11px;color:var(--text-3);">نجح: ${ok} · فشل: ${failures.length} · الوقت المنقضي: ${mmss(Math.floor((Date.now() - started) / 1000))}</div></div>`;
    try {
      const ocrData = await ocr.ocrShiftImages(shift, allMethods(), loaderFor(shift),
        (msg) => { const sub = $('batchSubStatus'); if (sub) sub.textContent = msg; }, () => batchCancelled);
      if (store.get('shifts', shift.id)) await saveOcr(shift, ocrData);
      if (ocrData.errors.length) failures.push({ title, errors: ocrData.errors }); else ok++;
    } catch (e) {
      if (batchCancelled) break;
      failures.push({ title, errors: [e.message] });
    }
    done++;
  }
  batchRunning = false;
  btn.textContent = '▶️ ابدأ القراءة الجماعية';
  btn.classList.remove('btn-danger');
  statusEl.innerHTML = `<div class="alert alert-${failures.length || batchCancelled ? 'warning' : 'success'}" style="flex-direction:column;align-items:stretch;">
    <div><strong>${batchCancelled ? '⚠️ تم إيقاف القراءة' : '✓ انتهت القراءة الجماعية'}</strong></div>
    <div style="margin-top:8px;font-size:13px;">📊 تمت معالجة <strong>${done}</strong> من ${shifts.length} · ✓ نجح: <strong>${ok}</strong> · ✗ فشل: <strong>${failures.length}</strong> · الوقت: ${mmss(Math.floor((Date.now() - started) / 1000))}</div>
    ${failures.length ? `<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;">عرض الأخطاء (${failures.length})</summary>
      <div style="margin-top:8px;max-height:200px;overflow-y:auto;background:var(--bg);padding:10px;border-radius:6px;">
      ${failures.map((r) => `<div style="font-size:11px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--border);"><strong>${esc(r.title)}</strong><br>
        <span style="color:var(--danger);">${r.errors.map(esc).join(' | ')}</span></div>`).join('')}</div></details>` : ''}</div>`;
}

/* ================= exports ================= */
async function exportToExcel() {
  await store.ensureShiftWindow(val('filterDateFrom'));
  const shifts = filtered();
  if (!shifts.length) return alert('لا توجد بيانات للتصدير');
  try {
    const name = await exportExcel(shifts, allMethods(), (id) => brandName(id));
    showAlert('accAlert', '✓ تم تصدير الملف: ' + esc(name), 'success');
  } catch (e) {
    alert('تعذر التصدير: ' + e.message);
  }
}

const exportScope = () => scopeShifts('export', false);
async function previewExportScope() {
  await store.ensureShiftWindow(val('exportDateFrom'));
  const shifts = exportScope();
  if (!shifts.length) { $('exportStatus').innerHTML = '<div class="alert alert-info">لا توجد شفتات بصور تطابق المعايير المحددة</div>'; return; }
  const by = new Map();
  for (const s of shifts) {
    const k = s.branchNameAr || s.branchName || 'غير محدد';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  $('exportStatus').innerHTML = `<div class="alert alert-info" style="flex-direction:column;align-items:stretch;">
    <div>📊 <strong>${shifts.length}</strong> شفت · <strong>${totalImages(shifts)}</strong> صورة · ${by.size} فرع</div>
    <div style="margin-top:10px;max-height:250px;overflow-y:auto;">${[...by].map(([branch, list]) => `
      <div style="margin-bottom:8px;padding:8px;background:var(--bg);border-radius:6px;"><strong style="color:var(--accent);">📁 ${esc(branch)}</strong>
        <span style="font-size:11px;color:var(--text-3);">(${list.length} شفت)</span>
        <div style="font-size:11px;color:var(--text-2);margin-top:4px;">${list.map((s) => `└ ${esc(s.date)}_${esc(shiftAr(s.shift))} (${imageCount(s)} صورة)`).join('<br>')}</div></div>`).join('')}</div></div>`;
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
async function exportImagesZip() {
  const statusEl = $('exportStatus');
  const btn = $('exportZipBtn');
  const info = (html, type = 'info') => { statusEl.innerHTML = `<div class="alert alert-${type}">${html}</div>`; };
  btn.disabled = true;
  btn.textContent = '⏳ جاري التحضير...';
  try {
    await store.ensureShiftWindow(val('exportDateFrom'));
    const shifts = exportScope();
    if (!shifts.length) return info('لا توجد شفتات بصور تطابق المعايير', 'danger');
    await loadScript(JSZIP_URL);
    const zip = new window.JSZip();
    const labels = { foodics: 'فودكس', cash: 'كاش', network: 'شبكة' };
    const methods = sortMethods(allMethods());
    const total = totalImages(shifts);
    const csv = ['﻿' + ['التاريخ', 'الفرع', 'الشفت', 'الموظف', 'الإجمالي'].map(csvCell).join(',')];
    const missing = [];
    const usedPaths = new Set();
    let added = 0;
    for (const shift of shifts) {
      const label = shiftAr(shift.shift) + (shift.isSurprise ? '_جرد_مفاجئ' : '');
      let path = `${sanitizeName(shift.branchNameAr || shift.branchName || 'غير_محدد')}/${sanitizeName(`${shift.date}_${label}`)}`;
      for (let n = 2; usedPaths.has(path); n++) path = path.replace(/(_\(\d+\))?$/, `_(${n})`);
      usedPaths.add(path);
      for (const cat of IMAGE_CATS) {
        const imgs = shift.images?.[cat] || [];
        for (let i = 0; i < imgs.length; i++) {
          info(`⏳ تحميل الصور... ${added + missing.length + 1}/${total}`);
          try {
            const parts = dataUrlParts(await store.loadImageData(shift.id, imgs[i]));
            zip.file(`${path}/${labels[cat]}_${i + 1}.${parts.ext}`, parts.base64, { base64: true });
            added++;
          } catch (e) {
            missing.push(`${path}/${labels[cat]}_${i + 1}: ${e.message}`);
          }
        }
      }
      zip.file(`${path}/تفاصيل_الشفت.txt`, '﻿' + [
        '=== تفاصيل الشفت ===', `التاريخ: ${shift.date}`, `البراند: ${brandName(shift.brand)}`,
        `الفرع (عربي): ${shift.branchNameAr || ''}`, `الفرع (إنجليزي): ${shift.branchNameEn || ''}`, `الشفت: ${label}`,
        `الموظف (عربي): ${shift.employeeNameAr || ''}`, `الموظف (إنجليزي): ${shift.employeeNameEn || ''}`, '',
        '=== المدفوعات (ما كتبه الموظف) ===',
        ...methodsInUse(methods, [shift.payments]).map((m) => `${methodLabel(m, 'en')}: ${num(shift.payments?.[m.id])}`),
        `الإجمالي: ${num(shift.total)}`, '', '=== الملاحظات ===', shift.notes || '(لا توجد ملاحظات)', '',
        '=== تاريخ الإرسال ===', fmtTime(shift.submittedAt)
      ].join('\r\n'));
      csv.push([shift.date, shift.branchNameAr || '', label, shift.employeeNameAr || '', num(shift.total)].map(csvCell).join(','));
    }
    zip.file('ملخص_الشفتات.csv', csv.join('\r\n'));
    if (missing.length) zip.file('صور_لم_تُحمّل.txt', '﻿' + missing.join('\r\n'));
    // JPEGs are already compressed: STORE is much faster than DEFLATE and the size is the same.
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => info(`⏳ جاري تجهيز الملف... ${Math.round(m.percent)}%`));
    const filename = `صور_الشفتات_${val('exportDateFrom') || 'all'}_إلى_${val('exportDateTo') || 'all'}.zip`;
    downloadBlob(blob, filename);
    info(`✓ تم تصدير <strong>${added}</strong> صورة من <strong>${shifts.length}</strong> شفت${missing.length ? ` · ⚠️ تعذر تحميل ${missing.length} صورة (التفاصيل داخل الملف)` : ''}<br>
      <span style="font-size:12px;">حجم الملف: ${(blob.size / 1048576).toFixed(2)} MB · ${esc(filename)}</span>`, missing.length ? 'warning' : 'success');
  } catch (e) {
    console.error('Export error:', e);
    info('✗ فشل التصدير: ' + esc(e.message), 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = '📦 تصدير الصور كـ ZIP';
  }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ================= employees ================= */
function renderEmployeesTable() {
  const emps = store.list('employees');
  $('employeesTableBody').innerHTML = !emps.length ? empty(6, '👥', 'لا يوجد موظفين. اضغط "إضافة موظف" لإضافة أول موظف.') : emps.map((e) => {
    const nameEn = e.nameEn || '';
    return `<tr>
      <td><strong>${esc(employeeName(e, 'ar') || '—')}</strong>${nameEn ? `<div style="font-size:11px;color:var(--text-3);direction:ltr;text-align:start;">${esc(nameEn)}</div>` : ''}</td>
      <td>${e.pin ? `<code style="background:var(--bg-3);padding:2px 8px;border-radius:4px;">${esc(e.pin)}</code>` : '<span class="badge badge-warning">لم يُحدد</span>'}</td>
      <td><span class="badge badge-accent">${esc(brandName(e.brand))}</span></td>
      <td>${esc(branchName(store.get('branches', e.branchId)) || '—')}</td>
      <td><span class="badge badge-info">${esc(shiftAr(e.shift))}</span></td>
      <td><button class="btn btn-sm btn-secondary" ${act('openEmployeeModal', e.id)}>تعديل</button>
          <button class="btn btn-sm btn-danger" ${act('deleteEmployee', e.id)}>حذف</button></td></tr>`;
  }).join('');
}
function updateBranchDropdown() {
  const branches = store.list('branches').filter((b) => b.brand === val('empFormBrand'));
  $('empFormBranch').innerHTML = branches.length
    ? branches.map((b) => `<option value="${esc(b.id)}">${esc(branchName(b))}</option>`).join('')
    : '<option value="">لا توجد فروع لهذا البراند — أضف فرع أولاً</option>';
}
function openEmployeeModal(id) {
  const emp = id ? store.get('employees', id) : null;
  editingEmployeeId = emp ? emp.id : null;
  $('employeeModalTitle').textContent = emp ? 'تعديل موظف' : 'إضافة موظف جديد';
  $('empFormNameAr').value = emp ? (emp.nameAr || emp.name || '') : '';
  $('empFormNameEn').value = emp?.nameEn || '';
  $('empFormPin').value = emp?.pin || '';
  if (emp) $('empFormBrand').value = emp.brand;
  updateBranchDropdown();
  if (emp) $('empFormBranch').value = emp.branchId;
  $('empFormShift').value = emp?.shift || 'morning';
  openModal('employeeModal');
}
async function saveEmployee() {
  const data = {
    nameAr: val('empFormNameAr').trim(), nameEn: val('empFormNameEn').trim(), pin: val('empFormPin').trim(),
    brand: val('empFormBrand'), branchId: val('empFormBranch'), shift: val('empFormShift')
  };
  if (!data.nameAr && !data.nameEn) return alert('أدخل اسم الموظف (عربي أو إنجليزي)');
  if (data.pin && !/^\d{5}$/.test(data.pin)) return alert('رقم PIN يجب أن يكون 5 أرقام (أو اتركه فارغاً)');
  if (!data.branchId) return alert('اختر فرعاً (أضف فرعاً أولاً إذا لم يكن موجوداً)');
  const clash = data.pin && store.list('employees').find((e) => e.pin === data.pin && e.id !== editingEmployeeId);
  if (clash) return alert('رقم PIN مستخدم لموظف آخر: ' + employeeName(clash, 'ar'));
  const who = data.nameAr || data.nameEn;
  if (editingEmployeeId) {
    const before = store.get('employees', editingEmployeeId);
    if (before?.name) data.name = null;                       // legacy single-name field
    const changes = diffFields(before, data, Object.keys(data));
    if (changes.pin) changes.pin = ['•••••', '•••••'];        // never write PINs into the log
    await store.patch('employees', editingEmployeeId, data, { action: 'update', summary: `تعديل الموظف ${who}`, changes });
  } else {
    await store.put('employees', { id: 'e' + Date.now(), ...data }, { action: 'create', summary: `إضافة الموظف ${who}` });
  }
  closeEmployeeModal();
  showAlert('accAlert', '✓ تم حفظ بيانات الموظف', 'success');
}
async function deleteEmployee(id) {
  const emp = store.get('employees', id);
  if (!emp || !confirm(`هل أنت متأكد من حذف الموظف "${employeeName(emp, 'ar')}"؟`)) return;
  await store.remove('employees', id, { action: 'delete', summary: `حذف الموظف ${employeeName(emp, 'ar')}` });
  showAlert('accAlert', '✓ تم حذف الموظف', 'success');
}
function closeEmployeeModal() { closeModal('employeeModal'); editingEmployeeId = null; }

/* ================= branches ================= */
function renderBranchesTable() {
  const branches = store.list('branches');
  const emps = store.list('employees');
  $('branchesTableBody').innerHTML = !branches.length ? empty(4, '🏢', 'لا توجد فروع') : branches.map((b) => `<tr>
    <td><strong>${esc(branchName(b) || '—')}</strong>${b.nameEn ? `<div style="font-size:11px;color:var(--text-3);direction:ltr;text-align:start;">${esc(b.nameEn)}</div>` : ''}</td>
    <td><span class="badge badge-accent">${esc(brandName(b.brand))}</span></td>
    <td>${emps.filter((e) => e.branchId === b.id).length}</td>
    <td><button class="btn btn-sm btn-secondary" ${act('openBranchModal', b.id)}>تعديل</button>
        <button class="btn btn-sm btn-danger" ${act('deleteBranch', b.id)}>حذف</button></td></tr>`).join('');
}
function openBranchModal(id) {
  const b = id ? store.get('branches', id) : null;
  editingBranchId = b ? b.id : null;
  $('branchModalTitle').textContent = b ? 'تعديل فرع' : 'إضافة فرع جديد';
  $('branchFormNameAr').value = b ? (b.nameAr || b.name || '') : '';
  $('branchFormNameEn').value = b?.nameEn || '';
  if (b) $('branchFormBrand').value = b.brand;
  openModal('branchModal');
}
async function saveBranch() {
  const data = { nameAr: val('branchFormNameAr').trim(), nameEn: val('branchFormNameEn').trim(), brand: val('branchFormBrand') };
  if (!data.nameAr && !data.nameEn) return alert('أدخل اسم الفرع (عربي أو إنجليزي)');
  const who = data.nameAr || data.nameEn;
  if (editingBranchId) {
    await store.patch('branches', editingBranchId, data,
      { action: 'update', summary: `تعديل الفرع ${who}`, changes: diffFields(store.get('branches', editingBranchId), data, Object.keys(data)) });
  } else {
    await store.put('branches', { id: 'b' + Date.now(), ...data }, { action: 'create', summary: `إضافة الفرع ${who}` });
  }
  closeBranchModal();
  showAlert('accAlert', '✓ تم حفظ الفرع', 'success');
}
async function deleteBranch(id) {
  const b = store.get('branches', id);
  if (!b) return;
  const count = store.list('employees').filter((e) => e.branchId === id).length;
  if (count) return alert('لا يمكن حذف الفرع - يوجد ' + count + ' موظف مرتبط به. احذف الموظفين أولاً.');
  if (!confirm(`هل أنت متأكد من حذف الفرع "${branchName(b)}"؟`)) return;
  await store.remove('branches', id, { action: 'delete', summary: `حذف الفرع ${branchName(b)}` });
  showAlert('accAlert', '✓ تم حذف الفرع', 'success');
}
function closeBranchModal() { closeModal('branchModal'); editingBranchId = null; }

/* ================= brands ================= */
function renderBrandsTable() {
  const brands = store.list('brands');
  const branches = store.list('branches');
  const emps = store.list('employees');
  $('brandsTableBody').innerHTML = !brands.length ? empty(5, '🏷️', 'لا توجد براندات') : brands.map((b) => `<tr>
    <td><strong>${esc(brandName(b) || '—')}</strong>${b.nameEn ? `<div style="font-size:11px;color:var(--text-3);direction:ltr;text-align:start;">${esc(b.nameEn)}</div>` : ''}</td>
    <td><code style="background:var(--bg-3);padding:2px 8px;border-radius:4px;">${esc(b.id)}</code></td>
    <td>${branches.filter((x) => x.brand === b.id).length}</td>
    <td>${emps.filter((x) => x.brand === b.id).length}</td>
    <td><button class="btn btn-sm btn-secondary" ${act('openBrandModal', b.id)}>تعديل</button>
        <button class="btn btn-sm btn-danger" ${act('deleteBrand', b.id)}>حذف</button></td></tr>`).join('');
}
function openBrandModal(id) {
  const b = id ? store.list('brands').find((x) => x.id === id) : null;
  editingBrandId = b ? b.id : null;
  $('brandModalTitle').textContent = b ? 'تعديل براند' : 'إضافة براند جديد';
  $('brandFormNameAr').value = b?.nameAr || '';
  $('brandFormNameEn').value = b?.nameEn || '';
  $('brandFormId').value = b?.id || '';
  $('brandFormId').disabled = !!b;
  $('brandIdFormGroup').style.opacity = b ? '0.5' : '1';
  openModal('brandModal');
}
/** The built-in defaults are shown while the collection is empty; store them for real on first edit. */
async function materializeDefaults(coll) {
  if (store.get(coll, store.list(coll)[0]?.id)) return;
  for (const item of store.list(coll)) await store.put(coll, item);
}
async function saveBrand() {
  const nameAr = val('brandFormNameAr').trim();
  const nameEn = val('brandFormNameEn').trim();
  const id = val('brandFormId').trim().toLowerCase();
  if (!nameAr && !nameEn) return alert('أدخل اسم البراند (عربي أو إنجليزي)');
  if (!editingBrandId) {
    if (!id) return alert('أدخل معرّف البراند');
    if (!/^[a-z0-9_]+$/.test(id)) return alert('المعرّف يجب أن يحتوي على حروف إنجليزية صغيرة وأرقام فقط (بدون مسافات)');
    if (store.list('brands').some((b) => b.id === id)) return alert('هذا المعرّف مستخدم بالفعل');
  }
  await materializeDefaults('brands');
  if (editingBrandId) await store.patch('brands', editingBrandId, { nameAr, nameEn }, { action: 'update', summary: `تعديل البراند ${nameAr || nameEn}` });
  else await store.put('brands', { id, nameAr, nameEn }, { action: 'create', summary: `إضافة البراند ${nameAr || nameEn}` });
  closeBrandModal();
  showAlert('accAlert', '✓ تم حفظ البراند', 'success');
}
async function deleteBrand(id) {
  const branchCount = store.list('branches').filter((b) => b.brand === id).length;
  const empCount = store.list('employees').filter((e) => e.brand === id).length;
  if (branchCount || empCount) return alert(`لا يمكن حذف البراند - يوجد ${branchCount} فرع و ${empCount} موظف مرتبط به. احذفهم أولاً.`);
  if (!confirm('هل أنت متأكد من حذف البراند؟')) return;
  await materializeDefaults('brands');
  await store.remove('brands', id, { action: 'delete', summary: `حذف البراند ${id}` });
  showAlert('accAlert', '✓ تم حذف البراند', 'success');
}
function closeBrandModal() { closeModal('brandModal'); editingBrandId = null; }

/* ================= payment methods ================= */
function renderPaymentMethodsTable() {
  const methods = sortMethods(allMethods());
  $('paymentMethodsTableBody').innerHTML = !methods.length
    ? '<tr><td colspan="7" style="text-align:center;color:var(--text-3);padding:20px;">لا توجد طرق دفع. اضغط "إضافة طريقة دفع" للبدء.</td></tr>'
    : methods.map((m) => {
      const on = m.active !== false;
      const type = m.isCash ? '<span class="badge badge-warning">💵 كاش</span>' : m.isCard ? '<span class="badge badge-info">💳 شبكة</span>' : '<span class="badge badge-neutral">📱 أخرى</span>';
      return `<tr><td>${esc(m.order || '—')}</td><td><strong>${esc(m.nameEn)}</strong></td><td>${esc(m.nameAr || '—')}</td>
        <td><code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px;">${esc(m.id)}</code></td><td>${type}</td>
        <td>${on ? '<span class="badge badge-success">✓ مفعّل</span>' : '<span class="badge badge-danger">✕ معطّل</span>'}</td>
        <td><button class="btn btn-sm btn-secondary" ${act('openPaymentMethodModal', m.id)}>✏️</button>
            <button class="btn btn-sm ${on ? 'btn-warning' : 'btn-success'}" ${act('togglePaymentMethod', m.id)}>${on ? '⏸️' : '▶️'}</button>
            <button class="btn btn-sm btn-danger" ${act('deletePaymentMethod', m.id)}>🗑️</button></td></tr>`;
    }).join('');
}
const findMethod = (id) => allMethods().find((m) => m.id === id);
function openPaymentMethodModal(id) {
  const m = id ? findMethod(id) : null;
  editingPmId = m ? m.id : null;
  $('paymentMethodModalTitle').textContent = m ? 'تعديل طريقة الدفع' : 'إضافة طريقة دفع جديدة';
  $('pmFormNameEn').value = m?.nameEn || '';
  $('pmFormNameAr').value = m?.nameAr || '';
  $('pmFormId').value = m?.id || '';
  $('pmFormId').disabled = !!m;
  $('pmFormOrder').value = m ? (m.order || 1) : allMethods().reduce((mx, x) => Math.max(mx, x.order || 0), 0) + 1;
  $('pmFormType').value = m?.isCash ? 'cash' : m?.isCard ? 'card' : 'other';
  $('pmFormActive').checked = m ? m.active !== false : true;
  openModal('paymentMethodModal');
}
function closePaymentMethodModal() { closeModal('paymentMethodModal'); editingPmId = null; }
async function savePaymentMethod() {
  const id = val('pmFormId').trim().toLowerCase();
  const type = val('pmFormType');
  const data = {
    nameEn: val('pmFormNameEn').trim(), nameAr: val('pmFormNameAr').trim(), order: parseInt(val('pmFormOrder'), 10) || 1,
    isCash: type === 'cash', isCard: type === 'card', active: $('pmFormActive').checked
  };
  if (!data.nameEn) return alert('يرجى إدخال الاسم بالإنجليزي');
  if (!editingPmId) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) return alert('المعرّف يجب أن يبدأ بحرف إنجليزي صغير، ويحتوي على حروف صغيرة وأرقام و _ فقط (مثل: mada، order_online)');
    if (findMethod(id)) return alert('هذا المعرّف موجود بالفعل. اختر معرّفاً آخر.');
  }
  await materializeDefaults('paymentMethods');
  if (editingPmId) {
    await store.patch('paymentMethods', editingPmId, data,
      { action: 'update', summary: `تعديل طريقة الدفع ${data.nameEn}`, changes: diffFields(findMethod(editingPmId), data, Object.keys(data)) });
  } else {
    await store.put('paymentMethods', { id, ...data }, { action: 'create', summary: `إضافة طريقة الدفع ${data.nameEn}` });
  }
  closePaymentMethodModal();
}
async function togglePaymentMethod(id) {
  const m = findMethod(id);
  if (!m) return;
  await materializeDefaults('paymentMethods');
  const active = m.active === false;
  await store.patch('paymentMethods', id, { active }, { action: 'update', summary: `${active ? 'تفعيل' : 'تعطيل'} طريقة الدفع ${m.nameEn}` });
}
async function deletePaymentMethod(id) {
  const m = findMethod(id);
  if (!m) return;
  if (!confirm(`⚠️ هل تريد حذف طريقة الدفع "${m.nameEn}"؟\n\nالبيانات القديمة في الشفتات السابقة تبقى محفوظة وتظهر في التقارير.\n\nيُفضّل استخدام "تعطيل" بدلاً من الحذف.`)) return;
  await materializeDefaults('paymentMethods');
  await store.remove('paymentMethods', id, { action: 'delete', summary: `حذف طريقة الدفع ${m.nameEn}` });
}

/* ================= Gemini key ================= */
function fillModelSelect(id, models, saved) {
  const sel = $(id);
  const opts = ['<option value="">تلقائي: أحدث موديل متاح (موصى به)</option>']
    .concat(models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`));
  // A saved model Google no longer lists is dropped: the select falls back to automatic.
  sel.innerHTML = opts.join('');
  sel.value = models.includes(saved) ? saved : '';
}
async function updateApiKeyUI() {
  const key = ocr.getApiKey();
  if (key) $('apiKeyInput').value = key;
  const models = key ? await ocr.listModels(key) : [];
  fillModelSelect('modelSelect', models, ocr.getModel());
  fillModelSelect('modelCashSelect', models, ocr.getCashModel());
}
const saveModelPref = (k, v) => (v ? localStorage.setItem(k, v) : localStorage.removeItem(k));
const keyStatus = (html, type) => { $('apiKeyStatus').innerHTML = `<div class="alert alert-${type}">${html}</div>`; };
function saveApiKey() {
  const key = val('apiKeyInput').trim();
  if (!key) return alert('أدخل المفتاح أولاً');
  localStorage.setItem('rashf_gemini_key', key);
  saveModelPref('rashf_gemini_model', val('modelSelect'));
  saveModelPref('rashf_gemini_cash_model', val('modelCashSelect'));
  const label = (v) => esc(v || 'تلقائي');
  keyStatus(`✓ تم حفظ المفتاح<br>• الموديل العام: ${label(val('modelSelect'))}<br>• موديل الكاش: ${label(val('modelCashSelect'))}`, 'success');
  updateApiKeyUI();
}
function clearApiKey() {
  if (!confirm('حذف المفتاح؟')) return;
  for (const k of ['rashf_gemini_key', 'rashf_gemini_model', 'rashf_gemini_cash_model']) localStorage.removeItem(k);
  $('apiKeyInput').value = '';
  keyStatus('تم حذف المفتاح', 'info');
}
async function testApiKey() {
  const key = val('apiKeyInput').trim() || ocr.getApiKey();
  if (!key) return alert('أدخل المفتاح أولاً');
  const model = val('modelSelect');
  keyStatus('⏳ جاري الاختبار' + (model ? ' باستخدام ' + esc(model) : '') + '...', 'info');
  try {
    const r = await ocr.testKey(key, model);
    const switched = model && r.model !== model ? `<br>⚠️ ${esc(model)} غير متاح، واستُخدم بدلاً منه ${esc(r.model)}` : '';
    keyStatus(`✓ المفتاح يعمل مع ${esc(r.model)}! الرد: ${esc(r.reply)}${switched}`, 'success');
    const models = await ocr.listModels(key);
    fillModelSelect('modelSelect', models, model);
    fillModelSelect('modelCashSelect', models, val('modelCashSelect'));
  } catch (e) {
    let tip = '';
    if (/quota|limit/i.test(e.message)) tip = '<br><br>💡 تجاوزت الحد المسموح. جرّب موديلاً آخر من القائمة.';
    else if (/not found/i.test(e.message)) tip = '<br><br>💡 الموديل غير متاح لهذا المفتاح. اختر موديلاً آخر.';
    keyStatus('✗ خطأ: ' + esc(e.message) + tip, 'danger');
  }
}

/* ================= sync / backup / reset ================= */
function updateSyncUI() {
  const s = store.sync;
  $('firebaseToggle').checked = s.enabled;
  let text = syncStatusText('ar');
  if (s.lastSync) text += ` · آخر مزامنة: ${new Date(s.lastSync).toLocaleTimeString('ar-SA')}`;
  $('firebaseSyncStatus').textContent = text;
  $('navSyncStatus').textContent = syncStatusText('ar');
  const legacy = store.legacyImageShifts().length;
  $('legacyImagesNote').textContent = legacy ? `يوجد ${legacy} شفت قديم ما زالت صوره داخل المستند (أبطأ في التحميل).` : 'كل الصور محفوظة بالطريقة الجديدة ✓';
  $('migrateImagesBtn').style.display = legacy ? '' : 'none';
}
const setFirebaseSync = (enabled) => store.setSyncEnabled(enabled);
async function retrySyncNow() { await store.retrySync(); showAlert('accAlert', 'تمت إعادة محاولة المزامنة', 'info'); }
async function migrateImages() {
  const n = store.legacyImageShifts().length;
  if (!n || !confirm(`سيتم ضغط صور ${n} شفت قديم ونقلها خارج مستند الشفت (أسرع وأخف). الصور نفسها لا تُحذف.\n\nمتابعة؟`)) return;
  const btn = $('migrateImagesBtn');
  btn.disabled = true;
  try {
    const done = await store.migrateLegacyImages((i, total) => { btn.textContent = `⏳ ${i}/${total}`; });
    showAlert('accAlert', `✓ تم ترحيل صور ${done} شفت`, 'success');
  } catch (e) {
    alert('توقف الترحيل: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🗜️ ترحيل صور الشفتات القديمة';
    updateSyncUI();
  }
}

function exportAllData() {
  const data = { version: 2, exportedAt: new Date().toISOString() };
  for (const k of ['shifts', 'employees', 'branches', 'brands', 'paymentMethods']) data[k] = store.list(k);
  const name = `rashf_backup_${isoLocal(new Date())}.json`;
  downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), name);
  alert(`✅ تم تصدير البيانات\n\nالشفتات: ${data.shifts.length}\nالموظفين: ${data.employees.length}\nالفروع: ${data.branches.length}\nالبراندات: ${data.brands.length}\nطرق الدفع: ${data.paymentMethods.length}\n\nالملف: ${name}\n\nملاحظة: الصور بالحجم الكامل لا تدخل في هذا الملف (استخدم "تصدير الصور ZIP")، ومفتاح Gemini لم يعد يُكتب في النسخة الاحتياطية.`);
}
async function importAllData(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !['shifts', 'employees', 'branches', 'brands', 'paymentMethods'].some((k) => Array.isArray(data[k]))) {
      return alert('❌ ملف غير صالح');
    }
    const n = (k) => (Array.isArray(data[k]) ? data[k].length : '—');
    if (!confirm(`⚠️ سيتم استبدال البيانات الحالية (على هذا الجهاز${store.sync.enabled ? ' وفي السحابة' : ''}) بمحتوى الملف:\n\n📅 تاريخ التصدير: ${data.exportedAt || 'غير معروف'}\n\nالشفتات: ${n('shifts')}\nالموظفين: ${n('employees')}\nالفروع: ${n('branches')}\nالبراندات: ${n('brands')}\nطرق الدفع: ${n('paymentMethods')}\n\nأي عنصر غير موجود في الملف سيُحذف. هل تريد المتابعة؟`)) return;
    if (Array.isArray(data.shifts)) await store.ensureShiftWindow('');
    await store.importData(data, (coll, i, total) => showAlert('accAlert', `⏳ استيراد ${esc(coll)}: ${i}/${total}`, 'info', 0));
    if (data.geminiKey && !ocr.getApiKey()) localStorage.setItem('rashf_gemini_key', data.geminiKey);
    showAlert('accAlert', '✅ تم استيراد البيانات بنجاح', 'success');
  } catch (e) {
    alert('❌ فشل الاستيراد: ' + e.message);
  }
}

async function resetAllData() {
  const pending = store.sync.pending;
  if (!confirm(`⚠️ سيتم مسح نسخة البيانات المحفوظة على هذا الجهاز فقط ثم إعادة تحميلها من السحابة.${store.sync.enabled ? '' : '\n\n🚨 المزامنة متوقفة: البيانات غير المرفوعة ستُفقد نهائياً!'}${pending ? `\n\n🚨 يوجد ${pending} عنصر لم يُرفع بعد وسيُفقد!` : ''}\n\nهل أنت متأكد؟`)) return;
  await store.wipeLocal();
  location.reload();
}
async function resetShiftsOnly() {
  const shifts = filtered();
  if (!shifts.length) return alert('لا توجد شفتات ضمن الفلتر الحالي');
  const f = filters();
  if (!confirm(`🚨 سيتم حذف ${shifts.length} شفت نهائياً (الفلتر الحالي: ${f.from || 'البداية'} ← ${f.to || 'اليوم'}) من هذا الجهاز${store.sync.enabled ? ' ومن السحابة وكل الأجهزة' : ''}.\n\nلا يمكن التراجع. متابعة؟`)) return;
  if (prompt(`للتأكيد اكتب العدد ${shifts.length}:`) !== String(shifts.length)) return alert('تم الإلغاء');
  for (const s of shifts) await store.remove('shifts', s.id, { action: 'delete', summary: `حذف جماعي: شفت ${s.date} - ${s.branchNameAr || ''}`, changes: { total: [s.total, null] } });
  showAlert('accAlert', `✓ تم حذف ${shifts.length} شفت`, 'success');
}

/* ================= audit log ================= */
const ACTION_AR = { create: 'إضافة', update: 'تعديل', replace: 'استبدال', delete: 'حذف', ocr: 'قراءة صور', 'ocr-edit': 'تعديل قراءة', import: 'استيراد', 'migrate-images': 'ترحيل صور' };
const COLL_AR = { shifts: 'شفت', employees: 'موظف', branches: 'فرع', brands: 'براند', paymentMethods: 'طريقة دفع', all: 'النظام' };
function changesHtml(changes) {
  if (!changes) return '';
  const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const rows = [];
  for (const [k, pair] of Object.entries(changes)) {
    const [a, b] = Array.isArray(pair) ? pair : [null, pair];
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) if (num(a[sub]) !== num(b[sub])) rows.push(`${k}.${sub}: ${show(a[sub])} ← ${show(b[sub])}`);
    } else rows.push(`${k}: ${show(a)} ← ${show(b)}`);
  }
  return rows.map((r) => `<div style="font-size:11px;color:var(--text-2);direction:ltr;text-align:start;">${esc(r)}</div>`).join('');
}
async function renderAudit() {
  const tbody = $('auditTableBody');
  tbody.innerHTML = empty(4, '⏳', 'جاري التحميل...');
  try {
    const entries = await store.loadAudit(300);
    tbody.innerHTML = !entries.length ? empty(4, '📜', 'لا توجد تعديلات مسجّلة بعد') : entries.map((e) => {
      const who = e.actor?.type === 'accountant' ? `المحاسب${e.actor.email ? ' · ' + e.actor.email : ' (دخول قديم)'}`
        : e.actor?.type === 'employee' ? `الموظف · ${e.actor.name || ''}` : 'النظام';
      return `<tr><td style="white-space:nowrap;direction:ltr;">${esc(fmtTime(e.at))}</td><td>${esc(who)}</td>
        <td><span class="badge badge-${e.action === 'delete' ? 'danger' : e.action === 'create' ? 'success' : 'info'}">${esc(ACTION_AR[e.action] || e.action)}</span>
          <span class="badge badge-neutral">${esc(COLL_AR[e.coll] || e.coll)}</span></td>
        <td>${esc(e.summary || '')}${changesHtml(e.changes)}</td></tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = empty(4, '⚠️', 'تعذر تحميل السجل: ' + esc(e.message));
  }
}

export function leaveAccountantApp() {
  batchCancelled = true;
  for (const id of ['shiftModal', 'employeeModal', 'branchModal', 'brandModal', 'paymentMethodModal', 'ocrEditModal']) closeModal(id);
}

register({
  switchTab, applyFilters, resetFilters, quickFilter, setBatchDate, setExportDate, showMoreShifts,
  openShiftModal, openShiftLightbox, saveShiftEdits, deleteShift, closeShiftModal,
  runOcrOnShift, openOcrEditModal, closeOcrEditModal, saveOcrEdits, previewBatchScope, startBatchOcr,
  exportToExcel, previewExportScope, exportImagesZip,
  openEmployeeModal, updateBranchDropdown, saveEmployee, deleteEmployee, closeEmployeeModal,
  openBranchModal, saveBranch, deleteBranch, closeBranchModal,
  openBrandModal, saveBrand, deleteBrand, closeBrandModal,
  openPaymentMethodModal, closePaymentMethodModal, savePaymentMethod, togglePaymentMethod, deletePaymentMethod,
  saveApiKey, clearApiKey, testApiKey, setFirebaseSync, retrySyncNow, migrateImages,
  exportAllData, importAllData, resetAllData, resetShiftsOnly, renderAudit
});
