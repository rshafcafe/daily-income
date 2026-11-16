// Gemini OCR: Foodics till report, cash photo, card-terminal receipt.
import { GEMINI_MODELS } from './constants.js';
import { mapFoodicsResult, activeMethods } from './logic.js';
import { num, round2, sleep } from './util.js';
import { dataUrlParts } from './images.js';

export const getApiKey = () => localStorage.getItem('rashf_gemini_key') || '';
export const getModel = () => localStorage.getItem('rashf_gemini_model') || GEMINI_MODELS[0];
export const getCashModel = () => localStorage.getItem('rashf_gemini_cash_model') || GEMINI_MODELS[0];

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const BACKOFF = [3000, 8000, 20000];

function parseJson(text) {
  try { return JSON.parse(text); } catch { /* try to salvage */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  throw new Error('فشل تحليل JSON: ' + text.slice(0, 200));
}

async function callModel(model, key, body) {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error?.message || `خطأ في الـ API (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const cand = json.candidates?.[0];
  if (!cand) throw new Error(json.promptFeedback?.blockReason ? 'تم حجب الطلب: ' + json.promptFeedback.blockReason : 'استجابة فارغة من Gemini');
  if (cand.finishReason === 'MAX_TOKENS') throw new Error('انتهت الـ tokens قبل اكتمال الإجابة');
  if (['SAFETY', 'RECITATION', 'BLOCKLIST'].includes(cand.finishReason)) throw new Error('تم رفض الطلب: ' + cand.finishReason);
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('استجابة فارغة من Gemini (' + cand.finishReason + ')');
  return parseJson(text);
}

/**
 * One image + prompt -> parsed JSON. Retries rate limits/overload with backoff,
 * then falls back to the next model in the chain.
 */
export async function geminiOcr(imageDataUrl, prompt, opts = {}) {
  const key = opts.key || getApiKey();
  if (!key) throw new Error('لم يتم إعداد Gemini API Key. اذهب لتبويب "إدارة البراندات" وأضف المفتاح.');
  const img = dataUrlParts(imageDataUrl);
  if (!img) throw new Error('صورة غير صالحة');
  const first = opts.model || getModel();
  const chain = [first, ...GEMINI_MODELS.filter((m) => m !== first)];
  let lastErr = null;

  for (const model of chain) {
    const isLite = model.includes('lite');
    const generationConfig = { temperature: 0, maxOutputTokens: isLite ? 8192 : 4096, responseMimeType: 'application/json' };
    if (model.includes('2.5') && !isLite) generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget || 0 };
    if (generationConfig.thinkingConfig?.thinkingBudget) generationConfig.maxOutputTokens += generationConfig.thinkingConfig.thinkingBudget;
    const body = JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: img.mime, data: img.base64 } }, { text: prompt }] }],
      generationConfig
    });
    for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
      if (opts.isCancelled?.()) throw new Error('تم الإيقاف');
      try {
        return await callModel(model, key, body);
      } catch (e) {
        lastErr = e;
        const transient = e.status === 429 || e.status === 500 || e.status === 503 || e instanceof TypeError;
        if (e.status === 404) break;                       // model not available -> next in chain
        if (!transient) throw e;                           // bad key, blocked content... no point retrying
        if (attempt === BACKOFF.length) break;             // exhausted -> next model
        const wait = BACKOFF[attempt] + Math.random() * 1000;
        opts.onRetry?.(`⏳ ${model}: الخادم مشغول، إعادة المحاولة بعد ${Math.round(wait / 1000)} ثانية (${attempt + 2}/${BACKOFF.length + 1})...`);
        await sleep(wait);
      }
    }
    if (model !== chain[chain.length - 1]) opts.onRetry?.(`↪️ التحويل إلى موديل بديل بعد تعذر ${model}`);
  }
  throw lastErr || new Error('فشل بعد عدة محاولات');
}

/* ---------- prompts ---------- */
export function foodicsPrompt(methods) {
  const list = methods.map((m) => `- "${m.id}": ${[m.nameEn, m.nameAr].filter(Boolean).map((n) => `"${n}"`).join(' / ')}`).join('\n');
  return `You are transcribing ONE section of a Foodics "Till Close Report" (Saudi POS receipt, thermal paper, English and/or Arabic).

TASK: copy the rows of the "Payments" section exactly as printed. Do NOT calculate, merge, or guess.

HOW TO FIND THE SECTION
- It is headed "Payments" (Arabic: "المدفوعات").
- Each row is: payment method name ... amount.
- The section ENDS at the row "Total Payments" (Arabic: "إجمالي المدفوعات"). Rows after it ("Total Returns", "Net Payments") are not payment methods.

SECTIONS YOU MUST NEVER READ FROM
- "Drawer Operations" (below "Net Payments"): Total Pay In, Total Pay Out, Total Cash Drops,
  "Total Payment Operations", "Total Return Operations", Opening Amount, Closing Amount,
  Estimated Cash In Register, Cash Shortage/Excess.
  WARNING: "Total Payment Operations" is NOT "Total Payments" and is NOT the Cash payment. Ignore it completely.
- Sales, taxes, discounts, orders count, or any other section.

KNOWN PAYMENT METHODS (id: names that may be printed)
${list}

OUTPUT — return ONLY this JSON object:
{
  "lines": [ { "label": "<method name exactly as printed>", "amount": <number>, "field": "<matching id from the list above, or null>" } ],
  "total_payments": <number printed on the "Total Payments" row, or null if not visible>,
  "readable": <true if the Payments section is fully legible, otherwise false>
}

RULES
- One entry in "lines" per printed row of the Payments section, in printed order. Include rows whose method is not in the list (field = null).
- Do not include "Total Payments", "Total Returns", "Net Payments" or any Drawer Operations row in "lines".
- Amounts: ignore the currency sign (﷼ / SAR), remove thousands separators: "1,484.00" -> 1484.00. Convert Arabic-Indic digits (٠-٩) to 0-9.
- Read digit by digit. Easily confused pairs: 1/7, 0/8, 3/8, 5/6.
- SELF-CHECK: the amounts in "lines" must add up to "total_payments". If they do not, re-read every row before answering.
- If a method from the list is not printed, simply omit it. If there is no Payments section in the image, return {"lines": [], "total_payments": null, "readable": false}.`;
}

const CASH_PROMPT = `You are analyzing an image of Saudi Riyal cash. Identify EVERY item one-by-one.

==== SAUDI RIYAL DENOMINATIONS ====
BANKNOTES (read the printed number on each note):
• 500 SAR: BLUE/dark teal, large note
• 200 SAR: BROWN/olive green
• 100 SAR: PINK/RED
• 50 SAR: YELLOW-GREEN/light green
• 20 SAR: GRAY/PURPLE-GRAY commemorative note, "TWENTY RIYALS" / "20" (G20 note). Do not confuse 20 with 10.
• 10 SAR: BROWN
• 5 SAR: PURPLE/VIOLET with flowers, "FIVE RIYALS" / "5"
• 1 SAR: GREEN small note

COINS — the ONLY reliable way to tell 1 SAR from 2 SAR is to READ THE NUMBER STAMPED ON THE COIN:
- "١" + "ريال" (or "1 RIYAL") = 1 SAR
- "٢" + "ريالان" (or "2 RIYALS") = 2 SAR
- "نصف ريال" / "50 HALALAS" = 0.5 SAR
Both coins are bi-color; size and ring colour are only secondary hints.
- If the number is unclear, DEFAULT to 1 SAR (far more common).
- Coins that look identical in the same image are the same denomination.
- Never mark a coin as 2 SAR unless you clearly read "٢" or "2 RIYALS" on it.

==== INSTRUCTIONS ====
1. List EVERY separate note or coin you can see, even upside-down, sideways or partly covered.
2. For each one, READ the number printed on it. Do not guess from colour alone.
3. Count duplicates carefully (two 5-riyal notes are two notes).
4. Sum the total and verify your arithmetic.

==== OUTPUT — return ONLY this JSON ====
{
  "items_seen": ["50 SAR banknote (reads '50')", "1 SAR coin (reads '١ ريال')"],
  "count_500": 0, "count_200": 0, "count_100": 0, "count_50": 0, "count_20": 0,
  "count_10": 0, "count_5": 0, "count_1_bill": 0,
  "coins_1sar": 0, "coins_2sar": 0, "coins_halala": 0, "coins_total": 0,
  "cash": 0,
  "confidence": "high"
}
- coins_halala = total value of halala coins in SAR.
- coins_total = coins_1sar*1 + coins_2sar*2 + coins_halala
- cash = count_500*500 + count_200*200 + count_100*100 + count_50*50 + count_20*20 + count_10*10 + count_5*5 + count_1_bill*1 + coins_total
- confidence: "high" | "medium" | "low"`;

const NETWORK_PROMPT = `This is a card-terminal (mada / POS network) receipt, usually an end-of-day reconciliation/settlement slip.
Find the GRAND TOTAL approved amount for the whole slip (labels such as "TOTAL", "TOTALS", "GRAND TOTAL", "الإجمالي", "المجموع").
If the slip lists several card schemes (mada, VISA, MASTERCARD, ...) with one grand total, return the grand total, not a scheme subtotal.
If it is a single purchase receipt, return its amount.
Return ONLY this JSON: {"mada": <number>}
Remove thousands separators, convert Arabic-Indic digits to 0-9, use 0 if no amount is visible.`;

/** Recompute the cash total from the counted denominations instead of trusting the model's arithmetic. */
export function cashDetailFromModel(d) {
  const int = (v) => Math.max(0, parseInt(v, 10) || 0);
  const det = {
    items_seen: Array.isArray(d.items_seen) ? d.items_seen.map(String) : [],
    count_500: int(d.count_500), count_200: int(d.count_200), count_100: int(d.count_100),
    count_50: int(d.count_50), count_20: int(d.count_20), count_10: int(d.count_10),
    count_5: int(d.count_5), count_1: int(d.count_1_bill ?? d.count_1),
    coins_1sar: int(d.coins_1sar), coins_2sar: int(d.coins_2sar), coins_halala: num(d.coins_halala),
    confidence: ['high', 'medium', 'low'].includes(d.confidence) ? d.confidence : 'low'
  };
  const itemized = det.coins_1sar + det.coins_2sar * 2 + det.coins_halala;
  det.coins_total = round2(itemized || num(d.coins_total));
  const counted = det.count_500 * 500 + det.count_200 * 200 + det.count_100 * 100 + det.count_50 * 50 +
    det.count_20 * 20 + det.count_10 * 10 + det.count_5 * 5 + det.count_1 + det.coins_total;
  det.total = round2(counted > 0 ? counted : num(d.cash));
  if (counted > 0 && Math.abs(counted - num(d.cash)) >= 1) det.mathFixed = true;
  return det;
}

/**
 * Reads every photo of a shift. `loadImage(img)` resolves the full-size data URL.
 * Returns the ocrData object stored on the shift.
 */
export async function ocrShiftImages(shift, allMethods, loadImage, onProgress, isCancelled) {
  const methods = activeMethods(allMethods);
  const result = { foodics: null, cashImage: 0, cashImageDetails: [], networkImage: 0, errors: [], warnings: [], readAt: new Date().toISOString() };
  const opts = { onRetry: onProgress, isCancelled };
  const each = async (cat, label, fn) => {
    const imgs = shift.images?.[cat] || [];
    for (let i = 0; i < imgs.length; i++) {
      if (isCancelled?.()) throw new Error('تم الإيقاف');
      onProgress?.(`قراءة ${label} ${i + 1}/${imgs.length}...`);
      try { await fn(await loadImage(imgs[i])); } catch (e) {
        if (isCancelled?.()) throw e;
        result.errors.push(`${label} ${i + 1}: ${e.message}`);
      }
    }
  };

  const prompt = foodicsPrompt(methods);
  await each('foodics', 'ورقة فودكس', async (data) => {
    const mapped = mapFoodicsResult(await geminiOcr(data, prompt, { ...opts, thinkingBudget: 1024 }), methods);
    if (!result.foodics) result.foodics = Object.fromEntries(methods.map((m) => [m.id, 0]));
    for (const m of methods) result.foodics[m.id] = round2(result.foodics[m.id] + mapped.values[m.id]);
    if (mapped.total !== null) result.foodicsTotal = round2((result.foodicsTotal || 0) + mapped.total);
    result.warnings.push(...mapped.warnings);
  });
  await each('cash', 'صورة الكاش', async (data) => {
    const det = cashDetailFromModel(await geminiOcr(data, CASH_PROMPT, { ...opts, thinkingBudget: 2048, model: getCashModel() }));
    result.cashImage = round2(result.cashImage + det.total);
    result.cashImageDetails.push(det);
  });
  await each('network', 'ورقة الشبكة', async (data) => {
    result.networkImage = round2(result.networkImage + num((await geminiOcr(data, NETWORK_PROMPT, opts)).mada));
  });
  return result;
}

export async function testKey(key, model) {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'قل: ناجح' }] }] })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || 'مفتاح غير صحيح');
  return json.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
