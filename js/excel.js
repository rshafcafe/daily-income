// Styled Excel export. The 0.9 MB spreadsheet library is no longer inlined in
// the page: it is fetched only when the accountant actually exports.
import { SHIFT_NAMES, SHIFT_TYPES } from './constants.js';
import { buildReport, sortMethods, methodLabel } from './logic.js';
import { formatArabicDate, num, round2 } from './util.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
const loaded = new Map();
export function loadScript(url) {
  if (!loaded.has(url)) {
    loaded.set(url, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(url); s.remove(); reject(new Error('تعذر تحميل المكتبة — تحقق من الاتصال بالإنترنت')); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(url);
}

/* ---------- styles ---------- */
const line = { style: 'thin', color: { rgb: '9E9E9E' } };
const border = { top: line, bottom: line, left: line, right: line };
const center = { horizontal: 'center', vertical: 'center', wrapText: true };
const base = (fill, font = {}) => ({
  border, alignment: center,
  font: { name: 'Arial', sz: 11, ...font },
  ...(fill ? { fill: { patternType: 'solid', fgColor: { rgb: fill } } } : {})
});
const ST = {
  title: base('3E2C1C', { bold: true, sz: 14, color: { rgb: 'FFFFFF' } }),
  branch: base('D4A574', { bold: true, sz: 13 }),
  actualHead: base('A9D08E', { bold: true }),
  programHead: base('9BC2E6', { bold: true }),
  diffHead: base('F4B084', { bold: true }),
  actualSub: base('E2EFDA', { bold: true }),
  programSub: base('DDEBF7', { bold: true }),
  diffSub: base('FCE4D6', { bold: true }),
  label: base('F2F2F2', { bold: true }),
  cell: base(null),
  na: base('FAFAFA', { color: { rgb: 'A0A0A0' } }),
  total: base('FFE699', { bold: true }),
  head: base('3E2C1C', { bold: true, color: { rgb: 'FFFFFF' } })
};
const NUM_FMT = '#,##0.00;-#,##0.00;"-"';
const txt = (v, s) => ({ v: v ?? '', t: 's', s });
const numCell = (v, s) => ({ v: round2(v), t: 'n', z: NUM_FMT, s: { ...s, numFmt: NUM_FMT } });
function diffCell(v, s) {
  const c = numCell(v, s);
  if (v < 0) c.s = { ...c.s, font: { ...c.s.font, bold: true, color: { rgb: 'C00000' } } };
  else if (v > 0) c.s = { ...c.s, font: { ...c.s.font, bold: true, color: { rgb: '2E7D32' } } };
  return c;
}

const COLS = 11;
const DIFF_ORDER = ['morning', 'total', 'saudi', 'evening'];   // column order used by the accountant's sheet
const DIFF_TITLES = ['الزيادة الصباحية', 'إجمالي الزيادة', 'زيادة سعودي', 'الزيادة المسائية'];

function reportSheet(XLSX, shifts, methods, title) {
  const rows = [];
  const merges = [];
  const heights = [];
  const blank = (s) => Array.from({ length: COLS }, () => txt('', s));
  const merged = (text, style, from = 0, to = COLS - 1, row = blank(style)) => {
    row[from] = txt(text, style);
    for (let c = from + 1; c <= to; c++) row[c] = txt('', style);
    merges.push({ s: { r: rows.length, c: from }, e: { r: rows.length, c: to } });
    return row;
  };

  rows.push(merged(title, ST.title)); heights.push({ hpt: 30 });
  rows.push([]); heights.push({ hpt: 8 });

  for (const br of buildReport(shifts, methods).branches) {
    rows.push(merged(br.name, ST.branch)); heights.push({ hpt: 24 });

    let r = blank(ST.label);
    r = merged('الفعلي', ST.actualHead, 1, 3, r);
    r = merged('البرنامج', ST.programHead, 4, 6, r);
    r = merged('الزيادات (الفعلي − البرنامج)', ST.diffHead, 7, 10, r);
    rows.push(r); heights.push({ hpt: 20 });

    const shiftNames = SHIFT_TYPES.map((t) => SHIFT_NAMES[t].ar);
    rows.push([
      txt('البند', ST.label),
      ...shiftNames.map((n) => txt(n, ST.actualSub)),
      ...shiftNames.map((n) => txt(n, ST.programSub)),
      ...DIFF_TITLES.map((n) => txt(n, ST.diffSub))
    ]); heights.push({ hpt: 20 });

    for (const row of br.rows) {
      rows.push([
        txt(row.label, ST.label),
        ...SHIFT_TYPES.map((t) => (row.showActual ? numCell(row.actual[t], ST.cell) : txt('-', ST.na))),
        ...SHIFT_TYPES.map((t) => numCell(row.program[t], ST.cell)),
        ...DIFF_ORDER.map((k) => (row.diff ? diffCell(row.diff[k], ST.cell) : txt('-', ST.na)))
      ]); heights.push({ hpt: 18 });
    }
    rows.push([
      txt('الإجمالي', ST.total),
      ...SHIFT_TYPES.map((t) => numCell(br.total.actual[t], ST.total)),
      ...SHIFT_TYPES.map((t) => numCell(br.total.program[t], ST.total)),
      ...DIFF_ORDER.map((k) => diffCell(br.total.diff[k], ST.total))
    ]); heights.push({ hpt: 20 });
    rows.push([]); heights.push({ hpt: 12 });
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  ws['!rows'] = heights;
  ws['!cols'] = [{ wch: 18 }, ...Array(6).fill({ wch: 13 }), ...Array(4).fill({ wch: 16 })];
  return ws;
}

function detailsSheet(XLSX, shifts, methods, brandName) {
  const all = sortMethods(methods);
  const head = ['التاريخ', 'البراند', 'الفرع', 'الشفت', 'النوع', 'الموظف', ...all.map((m) => methodLabel(m, 'ar')), 'الإجمالي', 'إجمالي البرنامج (فودكس)', 'الملاحظات'];
  const rows = [head.map((h) => txt(h, ST.head))];
  const sorted = [...shifts].sort((a, b) => a.date.localeCompare(b.date) || (a.branchNameAr || '').localeCompare(b.branchNameAr || '', 'ar'));
  for (const s of sorted) {
    const fd = s.ocrData?.foodics;
    rows.push([
      txt(s.date, ST.cell), txt(brandName(s.brand), ST.cell), txt(s.branchNameAr || s.branchName || '', ST.cell),
      txt(SHIFT_NAMES[s.shift]?.ar || s.shift || '', ST.cell), txt(s.isSurprise ? 'جرد مفاجئ' : 'عادي', ST.cell),
      txt(s.employeeNameAr || s.employeeName || '', ST.cell),
      ...all.map((m) => numCell(s.payments?.[m.id], ST.cell)),
      numCell(s.total, ST.total),
      fd ? numCell(Object.values(fd).reduce((t, v) => t + num(v), 0), ST.cell) : txt('-', ST.na),
      txt(s.notes || '', { ...ST.cell, alignment: { horizontal: 'right', vertical: 'center', wrapText: true } })
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 9 }, { wch: 11 }, { wch: 22 }, ...all.map(() => ({ wch: 11 })), { wch: 12 }, { wch: 16 }, { wch: 30 }];
  ws['!rows'] = [{ hpt: 22 }];
  return ws;
}

export async function exportExcel(shifts, methods, brandName) {
  await loadScript(XLSX_URL);
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  const dates = [...new Set(shifts.map((s) => s.date))].sort();

  for (const date of dates) {
    const dayShifts = shifts.filter((s) => s.date === date);
    XLSX.utils.book_append_sheet(wb, reportSheet(XLSX, dayShifts, methods, `تقرير الدخل اليومي رشف يوم ${formatArabicDate(date)}`), date);
  }
  if (dates.length > 1) {
    XLSX.utils.book_append_sheet(wb, reportSheet(XLSX, shifts, methods, `تقرير شامل (${dates[0]} → ${dates[dates.length - 1]})`), 'الإجمالي الشامل');
  }
  XLSX.utils.book_append_sheet(wb, detailsSheet(XLSX, shifts, methods, brandName), 'تفاصيل الشفتات');

  const name = dates.length === 1 ? `تقرير_الدخل_${dates[0]}.xlsx` : `تقرير_الدخل_${dates[0]}_إلى_${dates[dates.length - 1]}.xlsx`;
  XLSX.writeFile(wb, name);
  return name;
}
