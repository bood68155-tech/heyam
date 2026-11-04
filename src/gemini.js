'use strict';

/**
 * Google Gemini layer — the "AI structuring" step of the pipeline.
 *
 * Mirrors a Make.com scenario:
 *   Telegram message  ->  Gemini (parse + normalize to JSON)  ->  Google Sheets rows
 *
 * Two entry points:
 *   parseStudentText(text)  : free-form message(s) -> partial field map
 *   structureRecord(record): validated record    -> cleaned record + notes
 *
 * The model is never trusted blindly: every value it returns goes back through
 * the local validators, and the locally validated value wins on disagreement.
 */

const { config } = require('./config');
const logger = require('./logger');
const { heuristicParse } = require('./heuristic');
const { validateField, FIELD_ORDER, FIELD_LABELS } = require('./validators');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const STUDENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    fullName: { type: 'STRING', description: 'الاسم الرباعي للطالب بدون ألقاب أو ملاحظات' },
    universityId: { type: 'STRING', description: 'الرقم الجامعي بأرقام إنجليزية فقط' },
    section: { type: 'STRING', description: 'الشعبة: عربي أو إنجليزي' },
    major: { type: 'STRING', description: 'اسم التخصص الرسمي' },
    phone: { type: 'STRING', description: 'رقم واتس بأرقام فقط بدون مسافات' },
    notes: { type: 'STRING', description: 'ملاحظات قصيرة عن أي قيمة غير واضحة أو مفقودة' },
  },
  required: ['fullName', 'universityId', 'section', 'major', 'phone'],
};

const CLEAN_RULES = `أنت محرّك تنظيم بيانات في نظام تسجيل طلاب جامعي.
مهمتك إعادة كتابة بيانات طالب واحد بصيغة منظمة قبل حفظها في Google Sheets.

القواعد الإلزامية:
1) الاسم الرباعي: أربعة مقاطع على الأقل، احذف الألقاب (الشيخ، المهندس، الدكتور، د.) والكلمات الزائدة،
   وحّد شكل الحروف (أ/ا)، واكتبه كما هو بدون إضافة أسماء جديدة أو تغيير ترتيبها.
2) الرقم الجامعي: أرقام إنجليزية (0-9) فقط بدون مسافات أو شرطات، وحافظ على الأصفار البادئة.
3) الشعبة: "عربي" أو "إنجليزي" فقط. أي إشارة إلى Arabic فتعني "عربي"، وإلى English فتعني "إنجليزي".
4) التخصص: الاسم الرسمي دون كلمات مثل "قسم" أو "تخصص".
5) الهاتف: أرقام فقط. إن أضفت رمز الدولة الافتراضي (${config.defaultCountryCode || 'غير محدد'}) فطبّقه على الأرقام المحلية فقط.
6) لا تخترع أي قيمة غير موجودة. إن كان حقل غير واضح، أعده كما وصل إليك واذكره في notes.
7) أعد JSON مطابقاً للمخطط فقط، بدون أي نص إضافي.`;

function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in model output');
  return cleaned.slice(start, end + 1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Low-level Gemini call. Returns a parsed JSON object or null when unavailable. */
async function callGemini(prompt, { temperature = 0.1, retries = 2 } = {}) {
  if (!config.gemini.apiKey) return null;

  const url = `${API_BASE}/${encodeURIComponent(config.gemini.model)}:generateContent?key=${encodeURIComponent(config.gemini.apiKey)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: STUDENT_SCHEMA,
    },
  };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }

      const json = await res.json();
      const text = (json?.candidates?.[0]?.content?.parts || [])
        .map((part) => part.text)
        .filter(Boolean)
        .join('');

      if (!text.trim()) throw new Error('empty response');
      return JSON.parse(extractJson(text));
    } catch (err) {
      const last = attempt === retries;
      logger.warn(`Gemini attempt ${attempt}/${retries} failed: ${err.message}`);
      if (last) return null;
      await sleep(600 * attempt);
    }
  }
  return null;
}

/**
 * Merge model output with locally validated values.
 * Local validation always has the final word so a bad model answer cannot
 * corrupt the sheet.
 */
function reconcile(original, candidate, options) {
  const data = {};
  const notes = [];

  for (const field of FIELD_ORDER) {
    const local = validateField(field, original[field], options);
    const localValue = local.ok ? local.value : original[field];

    if (candidate && candidate[field] !== undefined && candidate[field] !== null && String(candidate[field]).trim() !== '') {
      const fromModel = validateField(field, candidate[field], options);
      if (fromModel.ok) {
        data[field] = fromModel.value;
        const changed = String(fromModel.value) !== String(localValue);
        if (changed) notes.push(`${FIELD_LABELS[field]}: "${localValue}" ← "${fromModel.value}"`);
        continue;
      }
      notes.push(`${FIELD_LABELS[field]}: تجاهلنا قيمة الذكاء الاصطناعي غير الصالحة "${candidate[field]}"`);
    }
    data[field] = localValue;
  }

  return { data, changes: notes };
}

/**
 * Parse a pasted block of text into the five fields.
 * Falls back to the offline heuristic parser when Gemini is unavailable.
 * @returns {Promise<{ fields: object, aiUsed: boolean, notes: string }>}
 */
async function parseStudentText(text, options = {}) {
  const prompt = `${CLEAN_RULES}

الرسالة الواردة من الطالب (قد تحتوي حقولاً ناقصة أو مكتوبة بشكل غير مرتب):
"""
${String(text).slice(0, 2000)}
"""

استخرج الحقول الموجودة فقط. اترك الحقل نصاً فارغاً "" إذا لم يكن موجوداً في الرسالة.`;

  const candidate = await callGemini(prompt, { temperature: 0 });
  if (!candidate) {
    logger.info('Gemini unavailable — using offline heuristic parser');
    return { fields: heuristicParse(text), aiUsed: false, notes: '' };
  }

  const fields = {};
  for (const field of FIELD_ORDER) {
    const result = validateField(field, candidate[field], options);
    if (result.ok) fields[field] = result.value;
  }

  // Fill the gaps from the local parser so a partial model answer is not fatal.
  const offline = heuristicParse(text);
  for (const field of FIELD_ORDER) {
    if (fields[field]) continue;
    const result = validateField(field, offline[field], options);
    if (result.ok) fields[field] = result.value;
  }

  return { fields, aiUsed: true, notes: String(candidate.notes || '').trim() };
}

/**
 * Clean and normalize a fully collected record before writing it to the sheet.
 * @returns {Promise<{ data: object, changes: string[], aiUsed: boolean, notes: string }>}
 */
async function structureRecord(record, options = {}) {
  const prompt = `${CLEAN_RULES}

بيانات الطالب كما جمعها البوت:
${JSON.stringify(record, null, 2)}

أعد البيانات بعد التنظيف والتوحيد.`;

  const candidate = await callGemini(prompt, { temperature: 0.05 });
  if (!candidate) {
    const { data } = reconcile(record, null, options);
    return { data, changes: [], aiUsed: false, notes: '' };
  }

  const { data, changes } = reconcile(record, candidate, options);
  logger.info(`Gemini structured record (${changes.length} adjustment(s))`);
  return { data, changes, aiUsed: true, notes: String(candidate.notes || '').trim() };
}

/** Quick availability probe used by the /health command. */
function aiEnabled() {
  return Boolean(config.gemini.apiKey);
}

module.exports = { parseStudentText, structureRecord, aiEnabled, callGemini, STUDENT_SCHEMA };
