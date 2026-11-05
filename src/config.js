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
 * A service account key can arrive double escaped: the two characters `\` + `n`
 * survive JSON parsing, so the whole PEM lands on one physical line and the
 * crypto layer receives a key with no line breaks. Collapse them to real
 * newlines before the key reaches google-auth-library.
 *
 * Safe for a well-formed key: base64 contains no backslash, so there is nothing
 * legitimate to replace.
 */
function normalizePrivateKey(privateKey) {
  if (typeof privateKey !== 'string' || !privateKey) return privateKey;
  return privateKey.replace(/\\n/g, '\n').trim();
}

function normalizeServiceAccount(creds) {
  if (!creds || typeof creds !== 'object') return creds;
  if (typeof creds.private_key !== 'string') return creds;
  return { ...creds, private_key: normalizePrivateKey(creds.private_key) };
}

/**
 * Resolve Google credentials from one of three supported shapes.
 * @returns {{ source: string, options: object, escapedNewlines?: boolean }}
 */
function resolveCredentials() {
  const inline = parseInlineCredentials(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CREDENTIALS_JSON,
  );
  if (inline) {
    // Remember whether the key arrived escaped, so /health can report what was
    // actually fixed instead of leaving it a mystery.
    const escapedNewlines =
      typeof inline.private_key === 'string' && inline.private_key.includes('\\n');

    return {
      source: 'inline-json',
      options: { credentials: normalizeServiceAccount(inline) },
      escapedNewlines,
    };
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
          private_key: normalizePrivateKey(privateKey),
        },
      },
      escapedNewlines: privateKey.includes('\\n'),
    };
  }

  return { source: 'none', options: {} };
}

/**
 * The service account address that the spreadsheet must be shared with.
 * Not a secret (it is the public half of the identity) and the single most
 * useful thing to print when Google answers 403 "The caller does not have
 * permission" — it is exactly the address that was never added as an editor.
 */
function resolveClientEmail(credentials) {
  try {
    if (credentials.options.credentials?.client_email) {
      return credentials.options.credentials.client_email;
    }
    const keyFile = credentials.options.keyFile;
    if (keyFile && fs.existsSync(keyFile)) {
      return JSON.parse(fs.readFileSync(keyFile, 'utf8')).client_email || null;
    }
  } catch {
    // unreadable/malformed key file is reported by configProblems()
  }
  return null;
}

/**
 * Shape of the key as the auth client will actually see it. A malformed PEM
 * fails at signing time with a crypto error ("no start line", invalid_grant),
 * never with an HTTP 403 — this is what makes that distinction visible.
 */
function describePrivateKey(credentials) {
  const key = credentials.options.credentials?.private_key;
  if (typeof key !== 'string' || !key) return { present: false };

  const trimmed = key.trim();
  return {
    present: true,
    escapedNewlinesFixed: Boolean(credentials.escapedNewlines),
    lines: trimmed.split('\n').length,
    hasHeader: /^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(trimmed),
    hasFooter: /-----END (?:RSA )?PRIVATE KEY-----$/.test(trimmed),
  };
}

const credentials = resolveCredentials();

const config = {
  root: ROOT,
  botToken: (process.env.BOT_TOKEN || '').trim(),
  adminIds: parseIds(process.env.ADMIN_IDS),
  sheets: {
    // GOOGLE_SHEET_ID (this build) and SPREADSHEET_ID (the Render blueprint in
    // this repository) are both accepted.
    spreadsheetId: parseSpreadsheetId(process.env.GOOGLE_SHEET_ID || process.env.SPREADSHEET_ID),
    sheetName: (process.env.GOOGLE_SHEET_NAME || 'Students').trim(),
    credentials,
    clientEmail: resolveClientEmail(credentials),
    privateKey: describePrivateKey(credentials),
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

  const key = config.sheets.privateKey;
  if (key.present && (!key.hasHeader || !key.hasFooter)) {
    problems.push(
      'GOOGLE_SERVICE_ACCOUNT_JSON يحتوي private_key مشوّهاً — يجب أن يبدأ بـ -----BEGIN PRIVATE KEY----- وينتهي بـ -----END PRIVATE KEY----- (تأكد من نسخ ملف JSON كاملاً دون تعديل)',
    );
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

module.exports = {
  config,
  configProblems,
  assertConfig,
  parseSpreadsheetId,
  parseIds,
  // Exported so the offline self-check can prove the PEM repair instead of
  // trusting it: a wrongly escaped key only fails later, at signing time.
  normalizePrivateKey,
  parseInlineCredentials,
};
