'use strict';

/**
 * Pure helper functions: Arabic-aware text normalization, digit conversion and
 * free-form / bulk input detection. No dependencies so it can be unit tested
 * without credentials or network access.
 */

const FIELD_ORDER = ['fullName', 'universityId', 'section', 'major', 'phone'];

const FIELD_LABELS = {
  fullName: 'الاسم الرباعي',
  universityId: 'الرقم الجامعي',
  section: 'الشعبة',
  major: 'التخصص',
  phone: 'رقم الهاتف واتس',
};

/** Convert Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits to ASCII. */
function toAsciiDigits(input) {
  return String(input ?? '').replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** Drop harakat, tatweel, and unify alef / ya / ta-marbuta / hamza forms. */
function normalizeArabic(input) {
  return String(input ?? '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Comparison key: Arabic-normalized, ASCII digits, single spaces. */
function normalizeKey(input) {
  return normalizeArabic(toAsciiDigits(input)).replace(/\s+/g, ' ').trim();
}

/** Collapse whitespace and strip characters that never belong in a person name. */
function cleanName(input) {
  return String(input ?? '')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[^\p{L}\p{M}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep digits only (used for phone numbers and university IDs). */
function digitsOnly(input) {
  return toAsciiDigits(input).replace(/\D/g, '');
}

/**
 * Normalize a WhatsApp number.
 * - Accepts +country, 00country, local numbers with a leading 0, spaces/dashes.
 * - When `defaultCountryCode` is configured, local numbers are completed with it.
 * - Returns digits without "+" so both storage and comparison stay consistent.
 */
function normalizePhone(input, defaultCountryCode = '') {
  let value = toAsciiDigits(String(input ?? '')).replace(/[^\d+]/g, '');
  if (value.startsWith('+')) value = value.slice(1);
  if (value.startsWith('00')) value = value.slice(2);
  value = value.replace(/\D/g, '');
  if (!value) return '';

  const cc = digitsOnly(defaultCountryCode || '');
  if (!cc) return value;

  if (value.startsWith('0')) return cc + value.replace(/^0+/, '');
  if (value.startsWith(cc)) return value;
  if (value.length <= 10) return cc + value;
  return value;
}

/** Never expose a full phone number in logs or error messages. */
function maskPhone(phone) {
  const value = digitsOnly(phone);
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.max(value.length - 4, 2))}${value.slice(-4)}`;
}

/**
 * True when a message looks like several fields pasted at once rather than a
 * single answer — e.g. a multi-line block from a WhatsApp form or a CSV line.
 */
function looksLikeBulk(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 3) return true;

  const labelHits = [
    /الاسم/, /الرقم\s*الجامعي/, /الشعبة/, /التخصص/, /الهاتف|واتس|جوال/,
    /\bname\b/i, /\b(id|university\s*id)\b/i, /\bsection\b/i, /\bmajor\b/i, /\b(phone|whatsapp|mobile)\b/i,
  ].filter((re) => re.test(raw)).length;
  if (labelHits >= 2) return true;

  const digits = digitsOnly(raw);
  return raw.length >= 30 && digits.length >= 12;
}

/**
 * Match a stored record against a free-text query (name fragment or university ID).
 * Name matching ignores Arabic spelling variants, ID matching ignores formatting.
 */
function matchesQuery(record, query) {
  const q = normalizeKey(query);
  if (!q) return false;

  const qDigits = digitsOnly(q);
  const idKey = digitsOnly(record.universityId);
  if (qDigits.length >= 3 && idKey && idKey.includes(qDigits)) return true;

  const nameKey = normalizeKey(record.fullName);
  if (!nameKey) return false;
  if (nameKey.includes(q)) return true;

  // Word-order independent match: every query word must appear in the name.
  const words = q.split(' ').filter((w) => w.length > 1);
  return words.length > 1 && words.every((w) => nameKey.includes(w));
}

/** Escape user-controlled text before embedding it in HTML messages. */
function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Naive E.164-ish display: "+967771234567" when it looks international. */
function formatPhone(phone) {
  const value = digitsOnly(phone);
  if (!value) return '';
  return value.length >= 11 ? `+${value}` : value;
}

module.exports = {
  FIELD_ORDER,
  FIELD_LABELS,
  toAsciiDigits,
  normalizeArabic,
  normalizeKey,
  cleanName,
  digitsOnly,
  normalizePhone,
  maskPhone,
  looksLikeBulk,
  matchesQuery,
  formatPhone,
  escapeHtml,
};
