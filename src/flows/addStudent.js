'use strict';

/**
 * "Add student" flow.
 *
 *   /add -> ask 5 fields one by one -> Gemini structuring -> preview -> append to sheet
 *
 * A student may also paste everything at once (during any step); the message is
 * sent to Gemini for extraction and the flow skips to the first missing field.
 */

const { InlineKeyboard } = require('grammy');

const { config } = require('../config');
const logger = require('../logger');
const messages = require('../messages');
const state = require('../state');
const gemini = require('../gemini');
const sheets = require('../sheets');
const { FIELD_ORDER, looksLikeBulk } = require('../utils');
const { validateField, validateRecord } = require('../validators');

const SECTION_CALLBACKS = { ar: 'عربي', en: 'إنجليزي' };

function sectionKeyboard() {
  return new InlineKeyboard().text('عربي', 'add:section:ar').text('English', 'add:section:en');
}

function nextMissing(data) {
  return FIELD_ORDER.find((field) => !data[field]) || null;
}

async function ask(ctx, field) {
  const text = messages.add.ask[field];
  if (!text) return undefined;
  if (field === 'section') {
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: sectionKeyboard() });
  }
  return ctx.reply(text, { parse_mode: 'HTML' });
}

async function stripKeyboard(ctx) {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // Message may be too old to edit — harmless.
  }
}

/** Begin a fresh registration. */
async function start(ctx) {
  state.set(ctx.chat.id, {
    mode: 'add',
    step: 'fullName',
    data: {},
    pendingDelete: null,
    pendingMatches: null,
  });
  await ctx.reply(messages.add.intro, { parse_mode: 'HTML' });
  return ask(ctx, 'fullName');
}

async function advance(ctx, session) {
  const next = nextMissing(session.data);
  if (next) {
    state.set(ctx.chat.id, { step: next });
    return ask(ctx, next);
  }
  return finalize(ctx);
}

/** Extract fields from a pasted block and continue with whatever is missing. */
async function handleBulk(ctx, text) {
  const chatId = ctx.chat.id;
  await ctx.reply(messages.add.parsing);

  let parsed = { fields: {}, aiUsed: false };
  try {
    parsed = await gemini.parseStudentText(text, { defaultCountryCode: config.defaultCountryCode });
  } catch (err) {
    logger.warn(`parseStudentText failed: ${err.message}`);
  }

  const found = FIELD_ORDER.filter((field) => parsed.fields[field]);
  if (!found.length) {
    await ctx.reply(messages.add.notUnderstood, { parse_mode: 'HTML' });
    return undefined;
  }

  const session = state.get(chatId);
  Object.assign(session.data, parsed.fields);
  state.set(chatId, { mode: 'add', data: session.data });

  const next = nextMissing(session.data);
  if (!next) return finalize(ctx);

  await ctx.reply(
    `${messages.add.parsedIntro}\n✅ استُخرج ${found.length} من 5 حقول${parsed.aiUsed ? ' (Gemini)' : ''}.`,
    { parse_mode: 'HTML' },
  );
  state.set(chatId, { step: next });
  return ask(ctx, next);
}

/** Entry point when the user pastes a record without starting /add. */
async function startFromBulk(ctx, text) {
  state.set(ctx.chat.id, {
    mode: 'add',
    step: 'fullName',
    data: {},
    pendingDelete: null,
    pendingMatches: null,
  });
  return handleBulk(ctx, text);
}

/** Normalize with Gemini, validate locally, guard against duplicates, show preview. */
async function finalize(ctx) {
  const chatId = ctx.chat.id;
  const session = state.get(chatId);

  await ctx.reply(messages.add.structuring);

  let structured = { data: session.data, changes: [], aiUsed: false, notes: '' };
  try {
    structured = await gemini.structureRecord(session.data, {
      defaultCountryCode: config.defaultCountryCode,
    });
  } catch (err) {
    logger.warn(`structureRecord failed: ${err.message}`);
  }

  // Local validation has the final word, even over the model.
  const checked = validateRecord({ ...session.data, ...structured.data }, {
    defaultCountryCode: config.defaultCountryCode,
  });

  if (!checked.ok) {
    const field = FIELD_ORDER.find((f) => checked.errors[f]) || 'fullName';
    state.set(chatId, { step: field, data: session.data });
    await ctx.reply(messages.add.invalid(field, checked.errors[field]), { parse_mode: 'HTML' });
    return undefined;
  }

  try {
    const existing = await sheets.findByUniversityId(checked.data.universityId);
    if (existing) {
      state.clear(chatId);
      await ctx.reply(messages.add.duplicate(existing), { parse_mode: 'HTML' });
      return undefined;
    }
  } catch (err) {
    logger.error(`duplicate check failed: ${err.message}`);
    await ctx.reply(messages.errors.sheets);
    return undefined;
  }

  state.set(chatId, {
    mode: 'add',
    step: 'confirm',
    data: checked.data,
    meta: { aiUsed: structured.aiUsed, changes: structured.changes || [], notes: structured.notes || '' },
  });

  const keyboard = new InlineKeyboard().text('حفظ ✅', 'add:save').text('إلغاء', 'add:cancel');
  return ctx.reply(messages.add.preview(checked.data, structured), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/** Free-text answer for the current step. */
async function onText(ctx, text) {
  const chatId = ctx.chat.id;
  const session = state.get(chatId);
  if (session.mode !== 'add') return undefined;

  // Someone pasted the whole form while answering a question.
  if (looksLikeBulk(text)) return handleBulk(ctx, text);

  const field = session.step;
  if (!field || field === 'confirm') {
    await ctx.reply(messages.add.alreadySaved);
    return undefined;
  }

  const result = validateField(field, text, { defaultCountryCode: config.defaultCountryCode });
  if (!result.ok) {
    await ctx.reply(messages.add.invalid(field, result.error), { parse_mode: 'HTML' });
    return undefined;
  }

  session.data[field] = result.value;
  state.set(chatId, { data: session.data });
  return advance(ctx, session);
}

/** Inline button handler for `add:*` callback data. */
async function onCallback(ctx) {
  const chatId = ctx.chat.id;
  const parts = String(ctx.callbackQuery.data || '').split(':');
  const action = parts[1];
  const session = state.get(chatId);

  if (action === 'section') {
    const section = SECTION_CALLBACKS[parts[2]];
    await ctx.answerCallbackQuery().catch(() => {});
    if (!section) return undefined;
    if (session.mode !== 'add' || session.step !== 'section') {
      await ctx.reply(messages.add.alreadySaved);
      return undefined;
    }
    session.data.section = section;
    state.set(chatId, { data: session.data });
    await stripKeyboard(ctx);
    await ctx.reply(`📚 الشعبة: <b>${section}</b>`, { parse_mode: 'HTML' });
    return advance(ctx, session);
  }

  if (action === 'cancel') {
    await ctx.answerCallbackQuery().catch(() => {});
    state.clear(chatId);
    await stripKeyboard(ctx);
    return ctx.reply(messages.cancelled);
  }

  if (action === 'save') {
    if (session.step !== 'confirm' || !session.data?.universityId) {
      await ctx.answerCallbackQuery().catch(() => {});
      return ctx.reply(messages.add.alreadySaved);
    }
    try {
      const saved = await sheets.appendStudent(session.data);
      state.clear(chatId);
      await ctx.answerCallbackQuery({ text: 'تم الحفظ ✅' }).catch(() => {});
      await stripKeyboard(ctx);
      return ctx.reply(messages.add.saved(session.data, saved.updatedRange), { parse_mode: 'HTML' });
    } catch (err) {
      logger.error(`append failed: ${err.message}`);
      await ctx.answerCallbackQuery({ text: 'فشل الحفظ', show_alert: false }).catch(() => {});
      return ctx.reply(messages.errors.sheets);
    }
  }

  await ctx.answerCallbackQuery().catch(() => {});
  return undefined;
}

module.exports = { start, startFromBulk, onText, onCallback, finalize };
