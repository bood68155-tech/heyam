'use strict';

/**
 * Vercel serverless entry point (webhook mode).
 *
 * Vercel's Node runtime calls a function as (req, res) with Node's http types,
 * so grammY's "http" adapter is the right one here — there is no dedicated
 * "vercel" adapter in grammY 1.x.
 *
 * Route: https://<project>.vercel.app/api/webhook
 * Set it with: npm run webhook:set
 *
 * The handler is built once per warm lambda and reused, so repeat updates skip
 * the cold-start cost of constructing the bot.
 */

const { PassThrough } = require('node:stream');

const { webhookCallback, BotError } = require('grammy');

const { buildBot } = require('../src/index');
const { config, configProblems } = require('../src/config');
const logger = require('../src/logger');

const SECRET = (process.env.WEBHOOK_SECRET || '').trim();

let handleUpdate = null;

/** Lazily build the bot + handler on first request of a cold start. */
function getHandler() {
  if (!handleUpdate) {
    const bot = buildBot();
    handleUpdate = webhookCallback(bot, 'http', {
      // Telegram gives up on a slow endpoint; finish before Vercel's limit.
      timeoutMilliseconds: 25_000,
      // When WEBHOOK_SECRET is set, requests without the matching
      // X-Telegram-Bot-Api-Secret-Token header are rejected.
      secretToken: SECRET || undefined,
    });
  }
  return handleUpdate;
}

/**
 * Vercel's Node runtime may hand the function an already-parsed body (`req.body`)
 * with the raw request stream drained. grammY's "http" adapter reads that stream,
 * so without this shim the bot would receive an empty update and look dead.
 * When a parsed object body is present we re-expose it as a readable stream.
 */
function ensureReadableBody(req) {
  const { body } = req;
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) return;

  const payload = Buffer.from(JSON.stringify(body));
  const stream = new PassThrough();

  // grammY subscribes with req.on("data").once("end"), so mirror those onto the
  // pass-through and keep returning the request for the chained call.
  req.on = function replayOn(event, listener) {
    stream.on(event, listener);
    return this;
  };
  req.once = function replayOnce(event, listener) {
    stream.once(event, listener);
    return this;
  };

  // Give the adapter a tick to attach listeners before the payload flows.
  setImmediate(() => stream.end(payload));

  if (req.headers && !req.headers['content-length']) {
    req.headers['content-length'] = String(payload.length);
  }
}

/** Small JSON status page, used for GET/HEAD and by uptime checks. */
function sendStatus(req, res, statusCode = 200) {
  const problems = configProblems();
  const body = {
    ok: problems.length === 0,
    service: 'heyam student bot',
    mode: 'webhook',
    route: '/api/webhook',
    ai: Boolean(config.gemini.apiKey),
    sheet: config.sheets.spreadsheetId || null,
    sheetTab: config.sheets.sheetName,
    countryCode: config.defaultCountryCode || null,
    problems,
  };
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(req.method === 'HEAD' ? undefined : payload);
}

module.exports = async (req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendStatus(req, res);
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.end('Method Not Allowed');
    return;
  }

  if (!config.botToken) {
    logger.error('BOT_TOKEN غير مضبوط في متغيّرات بيئة Vercel — تم رفض التحديث');
    sendStatus(req, res, 503);
    return;
  }

  try {
    ensureReadableBody(req);
    return await getHandler()(req, res);
  } catch (err) {
    // In webhook mode grammY rethrows middleware failures as BotError (bot.catch
    // is only wired into the polling loop), so errors land here.
    //
    // A middleware failure means the update *was* processed — a reply may simply
    // have failed. We answer 200 on purpose: a non-2xx makes Telegram replay the
    // update, which would append the same student to the sheet twice. Anything
    // thrown outside the middleware (bad token, bot.init failure) is a real
    // deployment problem and does return 500 so it shows up in getWebhookInfo.
    if (err instanceof BotError) {
      const updateId = err.ctx?.update?.update_id;
      logger.error(`Update ${updateId ?? '?'} failed: ${err.error?.message || err.message}`);
      if (!res.writableEnded) {
        res.statusCode = 200;
        res.end('');
      }
      return undefined;
    }

    logger.error('Webhook error:', err?.message || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal error');
    }
    return undefined;
  }
};
