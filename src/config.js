'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

/** "123, 456" or "@username" -> [123, 456, "username"] */
function parseIds(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((v) => v.trim().replace(/^@/, ''))
    .filter(Boolean)
    .map((v) => (/^-?\d+$/.test(v) ? Number(v) : v));
}

/** Accept a raw spreadsheet id or a full Google Sheets URL. */
function parseSpreadsheetId(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const fromUrl = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl) return fromUrl[1];
  return value;
}

/**
 * Parse a service account passed as an environment value. Accepts raw JSON or
 * base64-encoded JSON, which is how the Render blueprint in this repository
 * (GOOGLE_CREDENTIALS_JSON) is meant to be filled in.
 * @returns {object|null} the parsed credentials, or null when no value is set
 */
function parseInlineCredentials(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  const candidates = [value];
  if (!value.startsWith('{')) {
    // Render blueprints often carry the key base64 encoded.
    candidates.push(Buffer.from(value, 'base64').toString('utf8').trim());
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate before giving up
    }
  }

  throw new Error('بيانات اعتماد Google غير صالحة — القيمة ليست JSON ولا Base64 صالحاً (invalid service account JSON)');
}

/**
 * Resolve Google credentials from one of three supported shapes.
 * @returns {{ source: string, options: object }}
 */
function resolveCredentials() {
  const inline = parseInlineCredentials(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS_JSON,
  );
  if (inline) {
    return { source: 'inline-json', options: { credentials: inline } };
  }

  const keyFile = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (keyFile) {
    const resolved = path.isAbsolute(keyFile) ? keyFile : path.join(ROOT, keyFile);
    return { source: 'key-file', options: { keyFile: resolved } };
  }

  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').trim();
  if (email && privateKey) {
    return {
      source: 'env-vars',
      options: {
        credentials: {
          client_email: email,
          private_key: privateKey.replace(/\\n/g, '\n'),
        },
      },
    };
  }

  return { source: 'none', options: {} };
}

const config = {
  root: ROOT,
  botToken: (process.env.BOT_TOKEN || '').trim(),
  adminIds: parseIds(process.env.ADMIN_IDS),
  sheets: {
    // GOOGLE_SHEET_ID (this build) and SPREADSHEET_ID (the Render blueprint in
    // this repository) are both accepted.
    spreadsheetId: parseSpreadsheetId(process.env.GOOGLE_SHEET_ID || process.env.SPREADSHEET_ID),
    sheetName: (process.env.GOOGLE_SHEET_NAME || 'Students').trim(),
    credentials: resolveCredentials(),
  },
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim(),
    model: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
  },
  defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE || '').trim(),
};

/** Human readable report of what is missing, used on startup and by /health. */
function configProblems() {
  const problems = [];
  if (!config.botToken) problems.push('BOT_TOKEN مفقود — أنشئ بوتاً من @BotFather وضع التوكن في .env');
  if (!config.sheets.spreadsheetId) {
    problems.push(
      'GOOGLE_SHEET_ID مفقود — ضع رقم الجدول أو رابطه الكامل في .env (أو SPREADSHEET_ID على Render)',
    );
  }
  if (config.sheets.credentials.source === 'none') {
    problems.push(
      'بيانات اعتماد Google مفقودة — استخدم GOOGLE_APPLICATION_CREDENTIALS أو GOOGLE_SERVICE_ACCOUNT_JSON أو GOOGLE_CREDENTIALS_JSON',
    );
  } else if (
    config.sheets.credentials.options.keyFile &&
    !fs.existsSync(config.sheets.credentials.options.keyFile)
  ) {
    problems.push(`ملف الاعتماد غير موجود: ${config.sheets.credentials.options.keyFile}`);
  }
  return problems;
}

/**
 * Fail fast on configuration that makes the bot useless, but degrade gracefully
 * for optional features (Gemini is optional by design).
 */
function assertConfig({ requireBotToken = true } = {}) {
  const problems = [...configProblems()];
  if (!requireBotToken) {
    const filtered = problems.filter((p) => !p.startsWith('BOT_TOKEN'));
    problems.length = 0;
    problems.push(...filtered);
  }
  if (problems.length) {
    const message = ['إعدادات ناقصة / Missing configuration:', ...problems.map((p) => `  • ${p}`)].join('\n');
    throw new Error(message);
  }
}

module.exports = { config, configProblems, assertConfig, parseSpreadsheetId, parseIds };
