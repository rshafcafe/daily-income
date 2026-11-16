// Business rules as pure functions: comparisons, report building, OCR mapping,
// sync reconciliation. Everything here is covered by tests/.
import { num, round2, formatNum } from './util.js';
import { SHIFT_TYPES, IMAGE_CATS } from './constants.js';

/* ---------- payment methods ---------- */
export const sortMethods = (methods) => [...methods].sort((a, b) => (a.order || 999) - (b.order || 999));
export const activeMethods = (methods) => sortMethods(methods).filter((m) => m.active !== false);
export function methodLabel(m, lang = 'en') {
  if (!m) return '';
  return lang === 'ar' ? (m.nameAr || m.nameEn || m.id) : (m.nameEn || m.nameAr || m.id);
}
/** Active methods + any other method id that actually carries a value in `objs`. */
export function methodsInUse(methods, objs) {
  const known = new Map(sortMethods(methods).map((m) => [m.id, m]));
  const used = new Set();
  for (const o of objs) for (const [k, v] of Object.entries(o || {})) if (num(v) !== 0) used.add(k);
  const out = [...known.values()].filter((m) => m.active !== false || used.has(m.id));
  for (const id of used) if (!known.has(id)) out.push({ id, nameEn: id, nameAr: id, active: false });
  return out;
}

export function sumPayments(payments) {
  return round2(Object.values(payments || {}).reduce((s, v) => s + num(v), 0));
}
export function imageCount(shift) {
  return IMAGE_CATS.reduce((n, c) => n + (shift?.images?.[c]?.length || 0), 0);
}
/** A surprise audit is a mid-shift count, not extra income: never add it to totals. */
export const countsAsIncome = (shift) => !shift.isSurprise;

export function filterShifts(shifts, { from, to, brand, branch } = {}) {
  return shifts.filter((s) =>
    !(from && s.date < from) && !(to && s.date > to) &&
    !(brand && s.brand !== brand) && !(branch && s.branchId !== branch));
}

/* ---------- per-shift comparison (Foodics vs photo vs written) ---------- */
export function computeComparisons(shift, methods) {
  const ocr = shift.ocrData || null;
  const payments = shift.payments || {};
  const res = { hasOcr: !!ocr, threeWayCash: null, threeWayMada: null, programVsActual: null, alerts: [] };
  if (!ocr) return res;

  const fd = ocr.foodics && typeof ocr.foodics === 'object' ? ocr.foodics : null;
  const sumIds = (obj, ids) => round2(ids.reduce((s, id) => s + num(obj?.[id]), 0));
  const threeWay = (ids, photoRaw) => {
    const written = sumIds(payments, ids);
    const foodics = fd ? sumIds(fd, ids) : null;
    const photo = num(photoRaw);
    return {
      foodics, photo, written,
      foodicsVsWritten: foodics !== null ? round2(written - foodics) : null,
      photoVsWritten: photo > 0 ? round2(written - photo) : null,
      foodicsVsPhoto: foodics !== null && photo > 0 ? round2(foodics - photo) : null
    };
  };

  const cashIds = methods.filter((m) => m.isCash).map((m) => m.id);
  const cardIds = methods.filter((m) => m.isCard).map((m) => m.id);

  const c = (res.threeWayCash = { ...threeWay(cashIds, ocr.cashImage), cashDetails: ocr.cashImageDetails || [] });
  if (c.foodics !== null && Math.abs(c.written - c.foodics) >= 1) {
    res.alerts.push(`الكاش لا يطابق فودكس: كتب ${formatNum(c.written)} ، فودكس يقول ${formatNum(c.foodics)} (فرق ${formatNum(c.written - c.foodics)})`);
  }
  if (c.photo > 0 && c.foodics !== null && Math.abs(c.photo - c.foodics) >= 10) {
    res.alerts.push(`صورة الفلوس لا تطابق فودكس: الصورة ${formatNum(c.photo)} ، فودكس ${formatNum(c.foodics)} (فرق ${formatNum(c.photo - c.foodics)})`);
  }

  const m = (res.threeWayMada = threeWay(cardIds, ocr.networkImage));
  if (m.foodics !== null && Math.abs(m.written - m.foodics) >= 1) {
    res.alerts.push(`الشبكة لا تطابق فودكس: كتب ${formatNum(m.written)} ، فودكس يقول ${formatNum(m.foodics)} (فرق ${formatNum(m.written - m.foodics)})`);
  }
  if (m.photo > 0 && m.foodics !== null && Math.abs(m.photo - m.foodics) >= 1) {
    res.alerts.push(`صورة الشبكة لا تطابق فودكس: الصورة ${formatNum(m.photo)} ، فودكس ${formatNum(m.foodics)} (فرق ${formatNum(m.photo - m.foodics)})`);
  }

  if (fd) {
    const programTotal = sumPayments(fd);
    const actualTotal = round2(shift.total);
    const diff = round2(actualTotal - programTotal);
    const fields = methodsInUse(methods, [fd, payments]).map((mm) => {
      const p = round2(fd[mm.id]);
      const a = round2(payments[mm.id]);
      return { id: mm.id, method: mm, program: p, actual: a, diff: round2(a - p), match: Math.abs(a - p) < 1 };
    });
    res.programVsActual = { programTotal, actualTotal, diff, match: Math.abs(diff) < 1, fields };
    if (Math.abs(diff) >= 1) {
      res.alerts.push(`عدم تطابق الإجمالي مع البرنامج: الفعلي ${formatNum(actualTotal)} vs البرنامج ${formatNum(programTotal)} (${diff > 0 ? 'زيادة' : 'عجز'} ${formatNum(Math.abs(diff))})`);
    }
  }
  for (const w of ocr.warnings || []) res.alerts.push(w);
  return res;
}

/* ---------- accountant report (one block per branch) ---------- */
const zero3 = () => ({ morning: 0, saudi: 0, evening: 0 });

/**
 * Actual  = what the employee wrote, cash + card methods only.
 * Program = Foodics OCR for every method; when a shift has no usable OCR the
 *           employee's own numbers are used so no fake surplus/deficit appears.
 * Diff    = actual - program, cash + card rows only. The total row's diff is the
 *           sum of those row diffs.
 */
export function buildReport(shifts, methods) {
  const usable = shifts.filter((s) => SHIFT_TYPES.includes(s.shift) && countsAsIncome(s));
  const inUse = methodsInUse(methods, usable.flatMap((s) => [s.payments, s.ocrData?.foodics]));
  const ordered = [
    ...inUse.filter((m) => m.isCash),
    ...inUse.filter((m) => m.isCard && !m.isCash),
    ...inUse.filter((m) => !m.isCash && !m.isCard)
  ];

  const byBranch = new Map();
  for (const s of usable) {
    if (!byBranch.has(s.branchId)) byBranch.set(s.branchId, []);
    byBranch.get(s.branchId).push(s);
  }

  const branches = [...byBranch.entries()].map(([branchId, list]) => {
    const name = list[0].branchNameAr || list[0].branchName || String(branchId);
    const acc = new Map(ordered.map((m) => [m.id, { actual: zero3(), program: zero3() }]));
    for (const s of list) {
      const fd = s.ocrData?.foodics;
      const validOcr = !!fd && ordered.some((m) => num(fd[m.id]) > 0);
      for (const m of ordered) {
        const a = acc.get(m.id);
        if (m.isCash || m.isCard) a.actual[s.shift] += num(s.payments?.[m.id]);
        a.program[s.shift] += num(validOcr ? fd[m.id] : s.payments?.[m.id]);
      }
    }
    const total = { actual: zero3(), program: zero3(), diff: { ...zero3(), total: 0 } };
    const rows = ordered.map((m) => {
      const a = acc.get(m.id);
      const showActual = !!(m.isCash || m.isCard);
      let diff = null;
      if (showActual) {
        diff = { total: 0 };
        for (const t of SHIFT_TYPES) {
          diff[t] = round2(a.actual[t] - a.program[t]);
          diff.total = round2(diff.total + diff[t]);
          total.diff[t] = round2(total.diff[t] + diff[t]);
        }
        total.diff.total = round2(total.diff.total + diff.total);
      }
      for (const t of SHIFT_TYPES) {
        a.actual[t] = round2(a.actual[t]);
        a.program[t] = round2(a.program[t]);
        if (showActual) total.actual[t] = round2(total.actual[t] + a.actual[t]);
        total.program[t] = round2(total.program[t] + a.program[t]);
      }
      return { id: m.id, label: methodLabel(m, 'ar'), showActual, actual: a.actual, program: a.program, diff };
    });
    return { branchId, name, rows, total };
  });
  branches.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return { methods: ordered, branches };
}

/* ---------- Foodics OCR result -> payment fields ---------- */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
// Lines that belong to the totals / "Drawer Operations" block, never a payment method.
const NOT_A_METHOD = /total|net\s*pay|return|drawer|opening|closing|estimated|shortage|pay\s*in|pay\s*out|cash\s*drop|operation|إجمالي|اجمالي|صافي|مرتجع/i;

function matchMethod(label, methods) {
  const l = norm(label);
  if (!l) return null;
  const names = (m) => [m.nameEn, m.nameAr, m.id].map(norm).filter((n) => n.length >= 2);
  const exact = methods.find((m) => names(m).includes(l));
  if (exact) return { method: exact, exact: true };
  let best = null;
  for (const m of methods) {
    for (const n of names(m)) {
      if (n.length >= 3 && (l.includes(n) || (l.length >= 3 && n.includes(l)))) {
        if (!best || n.length > best.len) best = { method: m, len: n.length };
      }
    }
  }
  return best ? { method: best.method, exact: false } : null;
}

/**
 * Turns the model's transcription of the receipt's "Payments" section into
 * {methodId: amount}. The mapping and the sum check are done here, in code,
 * so a model slip (e.g. reading "Total Payment Operations") is caught.
 * Accepts the legacy flat shape {mada: 1, cash: 2} too.
 */
export function mapFoodicsResult(raw, methods) {
  const values = Object.fromEntries(methods.map((m) => [m.id, 0]));
  const warnings = [];
  const unmapped = [];
  if (!raw || typeof raw !== 'object') return { values, total: null, sum: 0, warnings: ['قراءة فودكس: استجابة غير صالحة'], unmapped };

  if (!Array.isArray(raw.lines)) {
    for (const m of methods) values[m.id] = round2(raw[m.id]);
    return { values, total: null, sum: sumPayments(values), warnings, unmapped };
  }

  let sumAll = 0;
  for (const line of raw.lines) {
    const amount = round2(typeof line?.amount === 'string' ? line.amount.replace(/[,\s﷼]/g, '') : line?.amount);
    const label = String(line?.label || '').trim();
    if (!label || NOT_A_METHOD.test(label)) continue;
    sumAll = round2(sumAll + amount);
    const byLabel = matchMethod(label, methods);
    const byModel = methods.find((m) => m.id === line.field);
    const target = byLabel?.exact ? byLabel.method : (byModel || byLabel?.method);
    if (target) values[target.id] = round2(values[target.id] + amount);
    else if (amount !== 0) unmapped.push({ label, amount });
  }
  const total = raw.total_payments === null || raw.total_payments === undefined ? null : round2(raw.total_payments);
  if (unmapped.length) {
    warnings.push('فودكس: بنود غير معرّفة في طرق الدفع: ' + unmapped.map((u) => `${u.label} = ${formatNum(u.amount)}`).join(' ، '));
  }
  if (total !== null && total > 0 && Math.abs(sumAll - total) >= 1) {
    warnings.push(`فودكس: مجموع البنود المقروءة ${formatNum(sumAll)} لا يساوي Total Payments المطبوع ${formatNum(total)} — راجع الورقة يدوياً`);
  }
  return { values, total, sum: sumPayments(values), warnings, unmapped };
}

/* ---------- sync reconciliation ---------- */
/**
 * Decides what to do with local items that are missing from a complete server
 * snapshot: an item the server once had was deleted remotely (drop it), an
 * item the server never saw was created offline (push it). `dropIds` are the
 * app's built-in defaults: they yield to real cloud data and are never pushed.
 */
export function planReconcile({ localIds, serverIds, syncedIds, pendingIds, dropIds, serverEmpty }) {
  const toDelete = [];
  const toPush = [];
  for (const id of localIds) {
    if (serverIds.has(id) || pendingIds.has(id)) continue;
    if (syncedIds.has(id)) toDelete.push(id);
    else if (dropIds && dropIds.has(id)) { if (!serverEmpty) toDelete.push(id); } // built-in defaults: never uploaded
    else toPush.push(id);
  }
  return { toDelete, toPush };
}

/** {field: [before, after]} for the audit log. */
export function diffFields(before, after, keys) {
  const out = {};
  for (const k of keys || new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before?.[k];
    const b = after?.[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[k] = [a ?? null, b ?? null];
  }
  return out;
}
