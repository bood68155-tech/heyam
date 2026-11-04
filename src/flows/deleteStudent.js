'use strict';

/**
 * "Delete student" flow (admins only).
 *
 *   /delete [query] -> search by name or university ID -> show match(es)
 *                   -> confirm ("تم") -> delete row -> confirmation message
 *
 * Confirmation can be given either by pressing the "تم" button or by typing
 * "تم" / "Done" (requirement: confirmation message followed by deletion).
 */

const { InlineKeyboard } = require('grammy');

const logger = require('../logger');
const messages = require('../messages');
const state = require('../state');
const sheets = require('../sheets');

const CONFIRM_RE = /^(?:تم|تاكيد|تأكيد|نعم|موافق|اوكي|أوكي|حسنا|done|yes|ok|okay|confirm|y)$/i;
const CANCEL_RE = /^(?:الغاء|إلغاء|لا|تراجع|cancel|no|n)$/i;

const isConfirm = (text) => CONFIRM_RE.test(String(text || '').trim());
const isCancel = (text) => CANCEL_RE.test(String(text || '').trim());

function truncate(value, max = 28) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function stripKeyboard(ctx) {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // Ignore: message might be too old.
  }
}

function confirmKeyboard(rowNumber) {
  return new InlineKeyboard().text('تم ✅', `del:ok:${rowNumber}`).text('إلغاء', 'del:no');
}

async function promptOrSearch(ctx, queryArg) {
  const query = String(queryArg || '').trim();
  if (query) return runSearch(ctx, query);
  state.set(ctx.chat.id, { mode: 'delete', step: 'query', pendingDelete: null, pendingMatches: null });
  return ctx.reply(messages.remove.prompt, { parse_mode: 'HTML' });
}

async function runSearch(ctx, query) {
  const chatId = ctx.chat.id;
  state.set(chatId, { mode: 'delete', step: 'query', pendingDelete: null, pendingMatches: null });
  await ctx.reply(messages.remove.searching);

  let matches = [];
  try {
    matches = await sheets.searchStudents(query);
  } catch (err) {
    logger.error(`search failed: ${err.message}`);
    await ctx.reply(messages.errors.sheets);
    return undefined;
  }

  if (!matches.length) {
    return ctx.reply(messages.remove.notFound(query), { parse_mode: 'HTML' });
  }

  if (matches.length === 1) {
    const record = matches[0];
    state.set(chatId, { mode: 'delete', step: 'confirm', pendingDelete: record, pendingMatches: matches });
    return ctx.reply(messages.remove.confirm(record), {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(record.rowNumber),
    });
  }

  const shown = matches.slice(0, 10);
  state.set(chatId, { mode: 'delete', step: 'select', pendingDelete: null, pendingMatches: matches });

  const keyboard = new InlineKeyboard();
  shown.forEach((record, index) => {
    keyboard
      .text(`${index + 1}. ${truncate(record.fullName)} — ${truncate(record.universityId, 12)}`, `del:pick:${record.rowNumber}`)
      .row();
  });

  return ctx.reply(messages.remove.multiple(matches.length), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

async function performDelete(ctx, record) {
  try {
    await sheets.deleteRow(record.rowNumber);
    state.clear(ctx.chat.id);
    await ctx.answerCallbackQuery({ text: 'تم ✅' }).catch(() => {});
    await stripKeyboard(ctx);
    return ctx.reply(messages.remove.deleted(record), { parse_mode: 'HTML' });
  } catch (err) {
    logger.error(`delete failed: ${err.message}`);
    return ctx.reply(messages.errors.sheets);
  }
}

/** Free-text handler: confirmation, cancellation or a new search query. */
async function onText(ctx, text) {
  const chatId = ctx.chat.id;
  const session = state.get(chatId);

  if (session.mode !== 'delete') {
    return runSearch(ctx, text);
  }

  if (session.step === 'confirm' && session.pendingDelete) {
    if (isConfirm(text)) return performDelete(ctx, session.pendingDelete);
    if (isCancel(text)) {
      state.clear(chatId);
      return ctx.reply(messages.remove.aborted);
    }
  }

  if (isCancel(text)) {
    state.clear(chatId);
    return ctx.reply(messages.remove.aborted);
  }

  // Anything else is treated as a fresh search query.
  return runSearch(ctx, text);
}

async function onCallback(ctx) {
  const chatId = ctx.chat.id;
  const parts = String(ctx.callbackQuery.data || '').split(':');
  const action = parts[1];
  const row = Number(parts[2]);
  const session = state.get(chatId);

  if (action === 'no') {
    await ctx.answerCallbackQuery().catch(() => {});
    state.clear(chatId);
    await stripKeyboard(ctx);
    return ctx.reply(messages.remove.aborted);
  }

  if (action === 'pick') {
    await ctx.answerCallbackQuery().catch(() => {});
    const record = (session.pendingMatches || []).find((r) => r.rowNumber === row);
    if (!record) {
      await ctx.reply(messages.remove.stale);
      return undefined;
    }
    state.set(chatId, { mode: 'delete', step: 'confirm', pendingDelete: record });
    await stripKeyboard(ctx);
    return ctx.reply(messages.remove.confirm(record), {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard(record.rowNumber),
    });
  }

  if (action === 'ok') {
    const pending = session.pendingDelete;
    const record =
      pending && pending.rowNumber === row
        ? pending
        : (session.pendingMatches || []).find((r) => r.rowNumber === row);

    if (!record) {
      await ctx.answerCallbackQuery({ text: 'انتهت صلاحية الطلب', show_alert: true }).catch(() => {});
      await ctx.reply(messages.remove.stale);
      return undefined;
    }
    return performDelete(ctx, record);
  }

  await ctx.answerCallbackQuery().catch(() => {});
  return undefined;
}

module.exports = { start: promptOrSearch, onText, onCallback, isConfirm, isCancel };
