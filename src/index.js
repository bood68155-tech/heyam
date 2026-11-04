'use strict';

/**
 * Entry point: builds the Telegram bot and routes updates to the flows.
 *
 * Pipeline (same shape as a Make.com scenario):
 *   Telegram update -> flow/validation -> Gemini structuring -> Google Sheets row
 */

const { Bot } = require('grammy');

const { config, assertConfig } = require('./config');
const logger = require('./logger');
const messages = require('./messages');
const state = require('./state');
const sheets = require('./sheets');
const gemini = require('./gemini');
const addFlow = require('./flows/addStudent');
const deleteFlow = require('./flows/deleteStudent');
const findFlow = require('./flows/findStudent');
const { looksLikeBulk } = require('./utils');

const CONFIRM_RE = /^(?:تم|تاكيد|تأكيد|نعم|موافق|اوكي|أوكي|حسنا|done|yes|ok|okay|confirm|y)$/i;

/**
 * Admins come from ADMIN_IDS. When the list is empty the bot warns once at
 * startup and allows everyone — convenient for a single-person test setup,
 * dangerous in production.
 */
function isAdmin(ctx) {
  if (!config.adminIds.length) return true;
  const id = ctx.from?.id;
  const username = (ctx.from?.username || '').toLowerCase();
  return config.adminIds.some((entry) =>
    typeof entry === 'number' ? entry === id : String(entry).toLowerCase() === username,
  );
}

function buildBot() {
  const bot = new Bot(config.botToken);

  // ── Commands ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    state.clear(ctx.chat.id);
    await ctx.reply(messages.welcome, { parse_mode: 'HTML' });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(messages.help, { parse_mode: 'HTML' });
  });

  bot.command('add', async (ctx) => addFlow.start(ctx));

  bot.command('cancel', async (ctx) => {
    state.clear(ctx.chat.id);
    await ctx.reply(messages.cancelled);
  });

  bot.command('find', async (ctx) => findFlow.start(ctx, ctx.match));

  bot.command('delete', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply(messages.needAdmin);
      return;
    }
    await deleteFlow.start(ctx, ctx.match);
  });

  bot.command('health', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply(messages.needAdmin);
      return;
    }
    const health = await sheets.healthCheck();
    await ctx.reply(messages.health(health.ok, { ...health, ai: gemini.aiEnabled() }), {
      parse_mode: 'HTML',
    });
  });

  // ── Plain text ──────────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();

    // Unknown command (the known ones are handled above).
    if (text.startsWith('/')) {
      await ctx.reply(messages.hint);
      return;
    }

    const session = state.get(chatId);

    if (session.mode === 'add') {
      await addFlow.onText(ctx, text);
      return;
    }
    if (session.mode === 'delete') {
      await deleteFlow.onText(ctx, text);
      return;
    }
    if (session.mode === 'find') {
      await findFlow.onText(ctx, text);
      return;
    }

    // Someone pasted a full record without typing /add.
    if (looksLikeBulk(text)) {
      await addFlow.startFromBulk(ctx, text);
      return;
    }

    // "تم" / "Done" right after a deletion request that lost its buttons.
    const pending = state.get(chatId).pendingDelete;
    if (pending && CONFIRM_RE.test(text)) {
      await deleteFlow.onText(ctx, text);
      return;
    }

    await ctx.reply(messages.hint);
  });

  // ── Non-text messages ───────────────────────────────────────────────────────
  bot.on('message', async (ctx) => {
    const session = state.get(ctx.chat.id);
    if (session.mode === 'add') {
      await ctx.reply(messages.errors.textOnly);
      return;
    }
    await ctx.reply(messages.hint);
  });

  // ── Inline buttons ──────────────────────────────────────────────────────────
  bot.callbackQuery(/^add:/, async (ctx) => addFlow.onCallback(ctx));

  bot.callbackQuery(/^del:/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: 'هذا الإجراء للمشرفين فقط', show_alert: true });
      return;
    }
    await deleteFlow.onCallback(ctx);
  });

  bot.callbackQuery(/^find:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('استخدم /find متبوعاً بالاسم أو الرقم الجامعي.');
  });

  // ── Error handling ──────────────────────────────────────────────────────────
  bot.catch((err) => {
    const updateId = err.ctx?.update?.update_id;
    logger.error(`Update ${updateId ?? '?'} failed:`, err.error?.message || err.message || err);
  });

  return bot;
}

async function main() {
  try {
    assertConfig();
  } catch (err) {
    logger.error(`\n${err.message}\n`);
    process.exit(1);
  }

  if (!gemini.aiEnabled()) {
    logger.warn('GEMINI_API_KEY غير مضبوط — سيستخدم البوت المحلل المحلي بدلاً من Gemini');
  }
  if (!config.adminIds.length) {
    logger.warn('ADMIN_IDS فارغ — أوامر الحذف متاحة للجميع (للتجربة فقط)');
  }
  if (!config.defaultCountryCode) {
    logger.warn('DEFAULT_COUNTRY_CODE فارغ — سيتم حفظ أرقام الواتس كما كتبها الطالب');
  }

  const health = await sheets.healthCheck();
  if (health.ok) {
    logger.info(`Google Sheets جاهز: "${health.sheetName}" — ${health.count} سجل`);
  } else {
    logger.error(`تعذّر الاتصال بـ Google Sheets: ${health.error}`);
  }

  const bot = buildBot();

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'البداية / Start' },
      { command: 'add', description: 'إضافة طالب / Add student' },
      { command: 'find', description: 'بحث / Find' },
      { command: 'delete', description: 'حذف سجل (مشرف) / Delete' },
      { command: 'cancel', description: 'إلغاء / Cancel' },
      { command: 'help', description: 'مساعدة / Help' },
      { command: 'health', description: 'حالة الخدمات (مشرف) / Health' },
    ])
    .catch((err) => logger.warn(`setMyCommands failed: ${err.message}`));

  const shutdown = async (signal) => {
    logger.info(`Received ${signal} — stopping bot`);
    try {
      await bot.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await bot.start({
    drop_pending_updates: true,
    onStart: (me) => logger.info(`البوت يعمل الآن: @${me.username}`),
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason?.message || reason);
});

if (require.main === module) {
  main().catch((err) => {
    logger.error('Fatal startup error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { buildBot, isAdmin, main };
