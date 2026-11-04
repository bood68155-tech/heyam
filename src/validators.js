'use strict';

/**
 * Field-level validation and normalization for the five required student fields.
 * Every validator returns a uniform shape: { ok, value, error }.
 *
 * The bot validates twice on purpose:
 *  1. as the student types each answer (fast feedback),
 *  2. after Gemini restructures the record (never trust model output blindly).
 */

const {
  cleanName,
  digitsOnly,
  normalizeArabic,
  normalizePhone,
  toAsciiDigits,
  FIELD_ORDER,
  FIELD_LABELS,
} = require('./utils');

// "عبد الله" or "أبو بكر" is a single name part written as two words.
const COMPOUND_PREFIXES = ['عبد', 'ابو', 'أبو', 'ام', 'أم'];

function stripDiacritics(value) {
  return String(value ?? '').replace(/[\u064B-\u0652\u0670\u0640]/g, '');
}

/**
 * Count name components rather than raw words: "محمد عبد الله علي" is three
 * components (محمد / عبد الله / علي), while "عبدالله محمد علي الصالح" is four.
 */
function countNameParts(tokens) {
  let parts = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    parts += 1;
    const token = stripDiacritics(tokens[i]).toLowerCase();
    if (COMPOUND_PREFIXES.includes(token) && i + 1 < tokens.length) {
      i += 1; // skip the second half of the compound name
    }
  }
  return parts;
}

function validateFullName(raw) {
  const value = cleanName(raw);
  if (!value) {
    return { ok: false, error: 'أرسل الاسم الرباعي كاملاً.' };
  }
  const tokens = value.split(' ').filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: 'الاسم قصير جداً — اكتب أربعة أسماء مفصولة بمسافات.' };
  }
  const parts = countNameParts(tokens);
  if (parts < 4) {
    return {
      ok: false,
      error: `الاسم يجب أن يكون رباعياً (٤ أسماء). وصلنا ${parts} فقط.\nمثال: محمد أحمد علي الصالح`,
    };
  }
  if (value.replace(/\s/g, '').length < 8) {
    return { ok: false, error: 'الاسم قصير جداً. اكتب الاسم الرباعي كاملاً.' };
  }
  if (tokens.length > 8) {
    return { ok: false, error: 'الاسم طويل جداً. اكتب الاسم الرباعي فقط بدون ألقاب أو ملاحظات.' };
  }
  return { ok: true, value };
}

function validateUniversityId(raw) {
  const value = toAsciiDigits(String(raw ?? ''))
    .replace(/[\s\-_.]/g, '')
    .replace(/^#+/, '');
  if (!value) return { ok: false, error: 'أرسل الرقم الجامعي (أرقام فقط).' };
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: 'الرقم الجامعي يجب أن يحتوي أرقاماً فقط بدون حروف.' };
  }
  if (value.length < 3 || value.length > 15) {
    return { ok: false, error: 'طول الرقم الجامعي غير صحيح — يجب أن يكون بين ٣ و ١٥ رقماً.' };
  }
  return { ok: true, value };
}

/** Map any spelling of the two sections onto the canonical Arabic values. */
function normalizeSection(raw) {
  const value = normalizeArabic(toAsciiDigits(String(raw ?? '')));
  if (!value) return null;
  if (/(انجل|انكليز|english|^eng$|eng\b|latin|لاتين|اجنب|أجنب)/.test(value)) return 'إنجليزي';
  if (/(عرب|arab|^ar$)/.test(value)) return 'عربي';
  return null;
}

function validateSection(raw) {
  const value = normalizeSection(raw);
  if (!value) {
    return { ok: false, error: 'الشعبة يجب أن تكون: عربي أو إنجليزي فقط.' };
  }
  return { ok: true, value };
}

function validateMajor(raw) {
  const value = String(raw ?? '')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[^\p{L}\p{M}\s\-&/.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return { ok: false, error: 'أرسل اسم التخصص.' };
  if (value.replace(/\s/g, '').length < 2) {
    return { ok: false, error: 'اسم التخصص قصير جداً.' };
  }
  if (value.length > 80) {
    return { ok: false, error: 'اسم التخصص طويل جداً — اكتب اسم التخصص فقط.' };
  }
  return { ok: true, value };
}

function validatePhone(raw, defaultCountryCode = '') {
  const rawDigits = digitsOnly(raw);
  if (!rawDigits) return { ok: false, error: 'أرسل رقم الهاتف (واتس) بالأرقام.' };
  if (rawDigits.length < 6) {
    return { ok: false, error: 'رقم الهاتف قصير جداً. أرسل الرقم كاملاً مع رمز الدولة إن أمكن.' };
  }
  if (rawDigits.length > 15) {
    return { ok: false, error: 'رقم الهاتف طويل جداً — يجب ألا يتجاوز ١٥ رقماً.' };
  }
  const value = normalizePhone(raw, defaultCountryCode);
  if (value.length < 7 || value.length > 15) {
    return { ok: false, error: 'رقم الهاتف غير صحيح. مثال: +967771234567' };
  }
  return { ok: true, value };
}

/**
 * Single entry point used by the conversation flow and by the Gemini layer.
 * @param {string} field one of FIELD_ORDER
 * @param {*} raw value coming from the user or from the model
 * @param {{ defaultCountryCode?: string }} [options]
 */
function validateField(field, raw, options = {}) {
  switch (field) {
    case 'fullName':
      return validateFullName(raw);
    case 'universityId':
      return validateUniversityId(raw);
    case 'section':
      return validateSection(raw);
    case 'major':
      return validateMajor(raw);
    case 'phone':
      return validatePhone(raw, options.defaultCountryCode);
    default:
      return { ok: false, error: `حقل غير معروف: ${field}` };
  }
}

/**
 * Validate a whole record, collecting the first error per field.
 * @returns {{ ok: boolean, data: object, errors: Record<string, string> }}
 */
function validateRecord(record, options = {}) {
  const data = {};
  const errors = {};
  for (const field of FIELD_ORDER) {
    const result = validateField(field, record?.[field], options);
    if (result.ok) data[field] = result.value;
    else errors[field] = result.error;
  }
  return { ok: Object.keys(errors).length === 0, data, errors };
}

module.exports = {
  FIELD_ORDER,
  FIELD_LABELS,
  validateFullName,
  validateUniversityId,
  validateSection,
  validateMajor,
  validatePhone,
  normalizeSection,
  validateField,
  validateRecord,
};
