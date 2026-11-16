// Employee app (English, LTR): end-of-shift report with photos.
import * as store from './store.js';
import { SHIFT_NAMES, IMAGE_CATS } from './constants.js';
import { activeMethods, sumPayments, imageCount, diffFields } from './logic.js';
import { esc, num, round2, formatNum, businessDate, isoLocal, formatDateEN, newNumericId, sid } from './util.js';
import { compressImage } from './images.js';
import { $, session, register, act, showAlert, openModal, closeModal, choose, brandName, branchName, employeeName, syncStatusText } from './ui.js';

let uploaded = { foodics: [], cash: [], network: [] };
let editingId = null;
let pendingCategory = null;
let methodsSignature = '';
let busy = 0;

const methods = () => activeMethods(store.list('paymentMethods'));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shiftLabel = (code, lang) => SHIFT_NAMES[code]?.[lang] || code || '—';

export function enterEmployeeApp() {
  const u = session.user;
  document.body.classList.remove('ar');
  $('loginScreen').style.display = 'none';
  $('employeeApp').classList.add('active');
  const branch = store.get('branches', u.branchId);
  $('empName').textContent = employeeName(u, 'en');
  $('empMeta').textContent = branchName(branch, 'en') + ' · ' + shiftLabel(u.shift, 'en');
  $('infoShift').textContent = shiftLabel(u.shift, 'en');
  $('infoBrand').textContent = brandName(u.brand, 'en');
  $('infoBranch').textContent = branchName(branch, 'en');
  editingId = null;
  uploaded = { foodics: [], cash: [], network: [] };
  methodsSignature = '';
  setEmpDate(businessDate());
  renderEmpPaymentsGrid();
  IMAGE_CATS.forEach(renderPreviews);
  renderEmpSubmissions();
  renderEmpSync();
}

/** Re-render after a data change without disturbing what the employee is typing. */
export function refreshEmployee(what) {
  if (!session.user || session.user.type !== 'employee') return;
  if (what.has('paymentMethods')) renderEmpPaymentsGrid();
  if (what.has('shifts')) renderEmpSubmissions();
  if (what.has('sync') || what.has('shifts')) renderEmpSync();
}

function renderEmpSync() {
  const el = $('empSyncStatus');
  if (el) el.textContent = syncStatusText('en');
}

/* ---------- payments grid ---------- */
function renderEmpPaymentsGrid() {
  const grid = $('empPaymentsGrid');
  const list = methods();
  const sig = list.map((m) => m.id + '|' + m.nameEn).join(',');
  if (sig === methodsSignature) return;           // unchanged: keep the typed values untouched
  const typed = {};
  grid.querySelectorAll('input[data-payment-id]').forEach((i) => { typed[i.dataset.paymentId] = i.value; });
  methodsSignature = sig;
  grid.innerHTML = list.map((m) => `
    <div class="pay-input">
      <label>${esc(m.nameEn || m.nameAr || m.id)}</label>
      <input type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" data-payment-id="${esc(m.id)}" value="${esc(typed[m.id] || '')}">
    </div>`).join('');
  updateTotal();
}
function readPayments() {
  const out = {};
  $('empPaymentsGrid').querySelectorAll('input[data-payment-id]').forEach((i) => { out[i.dataset.paymentId] = round2(i.value); });
  return out;
}
function updateTotal() {
  $('empTotal').textContent = formatNum(sumPayments(readPayments()));
}

/* ---------- date ---------- */
function setEmpDate(iso) {
  $('empDate').value = iso || '';
  $('empDateDisplay').value = iso ? formatDateEN(iso) : '';
}
function openDatePicker() {
  // The (transparent) native date input covers the field, so a tap opens the picker
  // by itself on phones. Desktop browsers only open it from the tiny icon: help them.
  const input = $('empDate');
  if (typeof input.showPicker === 'function' && window.matchMedia('(pointer: fine)').matches) {
    try { input.showPicker(); } catch { /* not allowed here: the native control still works */ }
  }
}
const onDateChange = () => setEmpDate($('empDate').value);

/* ---------- photos ---------- */
function showUploadOptions(category) {
  pendingCategory = category;
  const titles = { foodics: 'Foodics Receipt - Choose Source', cash: 'Cash Photo - Choose Source', network: 'Network Receipt - Choose Source' };
  $('uploadSourceTitle').textContent = titles[category] || 'Choose photo source';
  openModal('uploadSourceModal');
}
function closeUploadSourceModal() { closeModal('uploadSourceModal'); pendingCategory = null; }
function triggerUpload(source) {
  if (!pendingCategory) return;
  const input = $(`file${cap(pendingCategory)}${source === 'camera' ? 'Camera' : 'Gallery'}`);
  closeUploadSourceModal();
  if (input) { input.value = ''; input.click(); }
}
async function handleFileUpload(event, category) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  setBusy(+1);
  const failed = [];
  for (const file of files) {
    try {
      const { data, thumb } = await compressImage(file);
      uploaded[category].push({ id: store.newImageId(), name: file.name || '', data, thumb, compressed: true });
      renderPreviews(category);
    } catch (e) {
      console.error('Image processing failed:', e);
      failed.push(file.name || 'photo');
    }
  }
  setBusy(-1);
  if (failed.length) showAlert('empAlert', `Could not read: ${esc(failed.join(', '))}. Please take the photo again.`, 'danger', 7000);
}
function setBusy(delta) {
  busy += delta;
  const btn = $('empSubmitBtn');
  btn.disabled = busy > 0;
  if (busy > 0) btn.dataset.label = btn.dataset.label || btn.innerHTML, btn.innerHTML = '⏳ Processing photos...';
  else if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
}
function renderPreviews(category) {
  const items = uploaded[category];
  $('preview' + cap(category)).innerHTML = items.map((img) => `
    <div class="preview-item">
      <img src="${esc(img.thumb || img.data || '')}" alt="">
      <button class="remove-btn" type="button" ${act('removeImage', img.id, category)}>×</button>
    </div>`).join('');
  const box = $('box' + cap(category));
  const counter = box.querySelector('.file-count');
  box.classList.toggle('has-files', items.length > 0);
  counter.style.display = items.length ? 'block' : 'none';
  counter.textContent = items.length;
}
function removeImage(id, category) {
  uploaded[category] = uploaded[category].filter((img) => sid(img.id) !== sid(id));
  renderPreviews(category);
}

/* ---------- submit ---------- */
function setSubmitMode(editing) {
  const btn = $('empSubmitBtn');
  btn.innerHTML = editing ? '💾 Update Shift Report' : '✓ Submit Shift Report';
  btn.classList.toggle('btn-warning', editing);
  $('empCancelEditBtn').style.display = editing ? 'inline-flex' : 'none';
}
function resetEmpForm() {
  uploaded = { foodics: [], cash: [], network: [] };
  IMAGE_CATS.forEach(renderPreviews);
  $('empPaymentsGrid').querySelectorAll('input').forEach((i) => { i.value = ''; });
  $('empNotes').value = '';
  setEmpDate(businessDate());
  updateTotal();
}
const sameSlot = (s, date, u) => s.date === date && s.branchId === u.branchId && s.shift === u.shift;
const imageIds = (images) => IMAGE_CATS.flatMap((c) => (images?.[c] || []).map((i) => c + ':' + sid(i.id))).join(',');

async function submitShift() {
  const u = session.user;
  const date = $('empDate').value;
  if (!date) return showAlert('empAlert', 'Please select date', 'danger');
  if (date > isoLocal(new Date())) return showAlert('empAlert', 'The date cannot be in the future', 'danger');

  const payments = readPayments();
  if (Object.values(payments).some((v) => v < 0)) return showAlert('empAlert', 'Amounts cannot be negative', 'danger');
  if (sumPayments(payments) === 0) return showAlert('empAlert', 'Please enter at least one payment amount', 'danger');
  if (!IMAGE_CATS.some((c) => uploaded[c].length) && !confirm('No photos uploaded. Continue?')) return;

  const notes = $('empNotes').value;
  const all = store.list('shifts');
  const btn = $('empSubmitBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    if (editingId) {
      const existing = store.get('shifts', editingId);
      if (!existing) { empCancelEdit(); return showAlert('empAlert', 'Shift not found', 'danger'); }
      if (!existing.isSurprise && all.some((s) => sid(s.id) !== sid(editingId) && !s.isSurprise && sameSlot(s, date, u))) {
        return showAlert('empAlert', 'Another report already exists for that date. Edit that report instead.', 'danger', 7000);
      }
      const merged = { ...(existing.payments || {}), ...payments };   // keeps amounts of methods that were deactivated later
      const imagesChanged = imageIds(existing.images) !== imageIds(uploaded);
      const next = {
        ...existing, date, payments: merged, total: sumPayments(merged), images: uploaded, notes,
        updatedAt: new Date().toISOString(),
        ocrData: imagesChanged ? null : (existing.ocrData ?? null)
      };
      const changes = diffFields(existing, next, ['date', 'payments', 'total', 'notes']);
      if (imagesChanged) changes.images = [imageCount(existing), imageCount(next)];
      await store.saveShift(next, { action: 'update', summary: `تعديل الموظف لشفت ${date}`, changes });
      empCancelEdit();
      showAlert('empAlert', '✓ Shift updated successfully', 'success');
      return;
    }

    const existing = all.find((s) => !s.isSurprise && sameSlot(s, date, u));
    let isSurprise = false;
    let id = newNumericId();
    let submittedAt = new Date().toISOString();
    let audit = { action: 'create', summary: `شفت جديد ${date}` };
    if (existing) {
      const choice = await choose({
        title: 'Report already exists',
        text: `A report for ${date} (${shiftLabel(u.shift, 'en')}) was already submitted. What do you want to do?`,
        buttons: [
          { label: 'Replace the old report', value: 'replace', cls: 'btn-warning' },
          { label: 'Add as a surprise audit (keep both)', value: 'surprise' },
          { label: 'Cancel', value: null, cls: 'btn-secondary' }
        ]
      });
      if (!choice) return;
      if (choice === 'surprise') { isSurprise = true; audit = { action: 'create', summary: `جرد مفاجئ ${date}` }; } else {
        id = existing.id;                         // overwrite in place: nothing is deleted
        submittedAt = existing.submittedAt || submittedAt;
        audit = { action: 'replace', summary: `استبدال شفت ${date}`, changes: diffFields(existing, { payments, total: sumPayments(payments) }, ['payments', 'total']) };
      }
    }
    const branch = store.get('branches', u.branchId);
    await store.saveShift({
      id, date, brand: u.brand, branchId: u.branchId,
      branchNameAr: branchName(branch, 'ar'), branchNameEn: branchName(branch, 'en'),
      shift: u.shift, isSurprise,
      employeeId: u.id, employeeNameAr: employeeName(u, 'ar'), employeeNameEn: employeeName(u, 'en'), employeePin: u.pin,
      payments, total: sumPayments(payments), images: uploaded, notes,
      submittedAt, ...(existing && !isSurprise ? { updatedAt: new Date().toISOString() } : {}),
      ocrData: null
    }, audit);
    resetEmpForm();
    showAlert('empAlert', navigator.onLine ? '✓ Shift submitted successfully' : '✓ Saved on this device. It will upload automatically when the internet is back.', 'success', 7000);
  } catch (e) {
    console.error(e);
    showAlert('empAlert', 'Could not save the report: ' + esc(e.message), 'danger', 9000);
  } finally {
    btn.disabled = busy > 0;
  }
}

function renderEmpSubmissions() {
  const u = session.user;
  const list = $('empSubmissionsList');
  const mine = store.list('shifts')
    .filter((s) => s.branchId === u.branchId && s.shift === u.shift)
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))
    .slice(0, 10);
  if (!mine.length) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📭</div>No submissions yet</div>';
    return;
  }
  list.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Date</th><th>Total</th><th>Photos</th><th>Actions</th></tr></thead>
    <tbody>${mine.map((s) => `<tr>
      <td>${esc(s.date)} ${s.isSurprise ? '<span style="color:#fbbf24;font-size:11px;">🔍 Surprise</span>' : ''}</td>
      <td class="num">${formatNum(s.total)} SAR</td>
      <td>${imageCount(s)}</td>
      <td><button class="btn btn-sm btn-secondary" ${act('empEditShift', s.id)}>✏️ Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function empEditShift(id) {
  const shift = store.get('shifts', id);
  if (!shift) return;
  editingId = id;
  setEmpDate(shift.date);
  methodsSignature = '';
  renderEmpPaymentsGrid();
  $('empPaymentsGrid').querySelectorAll('input[data-payment-id]').forEach((i) => {
    i.value = num(shift.payments?.[i.dataset.paymentId]) || '';
  });
  uploaded = Object.fromEntries(IMAGE_CATS.map((c) => [c, [...(shift.images?.[c] || [])]]));
  IMAGE_CATS.forEach(renderPreviews);
  $('empNotes').value = shift.notes || '';
  updateTotal();
  setSubmitMode(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  showAlert('empAlert', '✏️ Editing shift from ' + esc(shift.date) + '. Make changes and click Update.', 'info', 0);
}
function empCancelEdit() {
  editingId = null;
  resetEmpForm();
  setSubmitMode(false);
  $('empAlert').innerHTML = '';
}

export function leaveEmployeeApp() {
  editingId = null;
  uploaded = { foodics: [], cash: [], network: [] };
  setSubmitMode(false);
}

$('empPaymentsGrid').addEventListener('input', updateTotal);
register({
  openDatePicker, onDateChange, showUploadOptions, closeUploadSourceModal, triggerUpload, handleFileUpload,
  removeImage, submitShift, empEditShift, empCancelEdit
});
