'use strict';

/**
 * GET /health — deployment diagnostics.
 *
 * Vercel exposes runtime logs only through its dashboard or CLI, so this route
 * reports the same facts from inside the running function:
 *
 *   { ok, sheet, sheetTab, credentials, ai, problems, sheets, writeTest, recent }
 *
 *   /health           configuration + a live read of the Students tab
 *   /health?write=1    also appends a marked row, then deletes it, which proves
 *                      the service account can actually WRITE (and cleans up)
 *
 * 200 when everything is healthy, 503 when something is broken so uptime checks
 * and `npm run verify` fail loudly instead of reporting a false green.
 */

const { config, configProblems } = require('../src/config');
const logger = require('../src/logger');
const sheets = require('../src/sheets');
const gemini = require('../src/gemini');

const WRITE_FLAGS = new Set(['1', 'true', 'yes', 'write']);

function sendJson(req, res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(req.method === 'HEAD' ? undefined : payload);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url || '/health', 'https://placeholder.local');
  const wantWrite = WRITE_FLAGS.has((url.searchParams.get('write') || '').toLowerCase());

  const problems = configProblems();
  const report = {
    ok: false,
    service: 'heyam student bot',
    route: '/health',
    sheet: config.sheets.spreadsheetId || null,
    sheetTab: config.sheets.sheetName,
    credentials: config.sheets.credentials.source,
    // Share the spreadsheet with this address (Editor) when Google answers 403.
    serviceAccount: config.sheets.clientEmail,
    ai: gemini.aiEnabled(),
    countryCode: config.defaultCountryCode || null,
    problems,
    sheets: null,
    writeTest: null,
    recent: logger.recent(10),
  };

  if (problems.length) {
    logger.error(`health: التهيئة غير مكتملة — ${problems.join(' | ')}`);
    sendJson(req, res, 503, report);
    return;
  }

  try {
    const health = await sheets.healthCheck();
    report.sheets = health;

    if (wantWrite) {
      if (health.ok) {
        report.writeTest = await sheets.writeRoundTrip();
      } else {
        report.writeTest = { ok: false, error: 'تم تخطي فحص الكتابة لأن قراءة الجدول فشلت' };
      }
    }

    report.ok = Boolean(health.ok) && (!wantWrite || Boolean(report.writeTest?.ok));
  } catch (err) {
    // Token/credential failures (invalid_grant, 403 on the spreadsheet, a
    // malformed private key) surface here with the real Google message.
    report.sheets = { ok: false, error: err.message };
    if (/permission|403|forbidden/i.test(err.message) && config.sheets.clientEmail) {
      report.sheets.hint = `شارك الجدول مع ${config.sheets.clientEmail} بصلاحية Editor`;
    }
    logger.error(`health check failed: ${err.message}`);
  }

  report.recent = logger.recent(10);
  sendJson(req, res, report.ok ? 200 : 503, report);
};
