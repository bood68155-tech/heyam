'use strict';

/**
 * Offline fallback parser.
 *
 * Gemini is the primary parser, but a bot must keep working when the API key is
 * missing, quota is exhausted or the network hiccups. This module extracts fields
 * from a pasted block using labelled lines plus conservative heuristics.
 * It never invents values: anything it cannot find is left undefined.
 */

const { toAsciiDigits, digitsOnly, normalizeArabic, cleanName } = require('./utils');
const { normalizeSection } = require('./validators');

const LABELS = [
  ['phone', /(?:رقم\s*الهاتف(?:\s*واتس|\s*واتساب)?|الهاتف|الموبايل|الجوال|واتساب|واتس|whats\s*app|phone|mobile)\s*[:\-–=]\s*(.+)/i],
  ['universityId', /(?:الرقم\s*الجامعي|الرقم\s*الاكاديمي|رقم\s*الطالب|university\s*id|student\s*id|reg(?:istration)?\s*(?:no|number)|\bid\b)\s*[:\-–=]\s*(.+)/i],
  ['section', /(?:الشعبة|شعبة|القسم\s*الدراسي|section|group)\s*[:\-–=]\s*(.+)/i],
  ['major', /(?:التخصص|تخصص|specialization|speciality|major|department)\s*[:\-–=]\s*(.+)/i],
  ['fullName', /(?:الاسم\s*الرباعي|الاسم\s*الكامل|اسم\s*الطالب|الاسم|full\s*name|name)\s*[:\-–=]\s*(.+)/i],
];

const NOISE = /^(?:بيانات\s*الطالب|معلومات\s*الطالب|استمارة|تسجيل|student\s*info(?:rmation)?|form|ـ+|-+)$/i;

function labeledValue(line, regex) {
  const match = line.match(regex);
  if (!match) return undefined;
  const value = match[1].replace(/^[\s\-–=]+/, '').trim();
  return value || undefined;
}

/**
 * Parse a free-form block into raw (unvalidated) field candidates.
 * @param {string} text
 * @returns {{ fullName?: string, universityId?: string, section?: string, major?: string, phone?: string }}
 */
function heuristicParse(text) {
  const raw = String(text ?? '');
  const lines = raw
    .split(/\r?\n|(?:\s+[-–—]\s+)/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));

  const out = {};
  const leftovers = [];

  for (const line of lines) {
    let consumed = false;
    for (const [field, regex] of LABELS) {
      if (out[field]) continue;
      const value = labeledValue(line, regex);
      if (value !== undefined) {
        out[field] = value;
        consumed = true;
        break;
      }
    }
    if (!consumed) leftovers.push(line);
  }

  // Labelled sections arrive as typed text ("Arabic", "english"…): canonicalize.
  if (out.section) {
    out.section = normalizeSection(out.section) || out.section;
  }

  // Section: scan every line, the answer is usually a single word.
  if (!out.section) {
    for (const line of lines) {
      const section = normalizeSection(line);
      if (section) {
        out.section = section;
        break;
      }
    }
  }

  // Phone: longest run of digits that looks like a phone number.
  if (!out.phone) {
    const candidates = (raw.match(/\+?\d[\d\s\-()]{6,}\d/g) || [])
      .map((c) => digitsOnly(c))
      .filter((d) => d.length >= 7 && d.length <= 15)
      .sort((a, b) => b.length - a.length);
    if (candidates.length) out.phone = candidates[0];
  }

  // University ID: a shorter digit run that is not the phone number.
  if (!out.universityId) {
    const phoneDigits = digitsOnly(out.phone || '');
    const tokens = toAsciiDigits(raw).match(/\b\d{3,15}\b/g) || [];
    const candidate = tokens.find((t) => t !== phoneDigits && !phoneDigits.includes(t));
    if (candidate) out.universityId = candidate;
  }

  // Name: first leftover line that reads like four name words and has no digits.
  if (!out.fullName) {
    const nameLine = leftovers.find((line) => {
      if (/\d/.test(line)) return false;
      const words = cleanName(line).split(' ').filter(Boolean);
      return words.length >= 3 && /[\p{L}]/u.test(line);
    });
    if (nameLine) out.fullName = nameLine;
  }

  // Major: first leftover line that is not the name and has no digits.
  // Requiring at least two words keeps stray chatter ("مرحبا") out of the field;
  // labelled majors are unaffected because they are captured earlier.
  if (!out.major) {
    const majorLine = leftovers.find((line) => {
      if (line === out.fullName || /\d/.test(line)) return false;
      const text = normalizeArabic(line);
      if (!text || text.length < 6 || text.length > 80) return false;
      if (normalizeSection(line)) return false;
      return text.split(' ').filter((word) => word.length > 1).length >= 2;
    });
    if (majorLine) out.major = majorLine;
  }

  // Remove keys we only guessed weakly from the phone (avoid echoing digits as a name).
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'string') out[key] = out[key].trim();
    if (!out[key]) delete out[key];
  }
  return out;
}

module.exports = { heuristicParse };
