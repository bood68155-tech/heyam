'use strict';

/**
 * Read-only "find" flow: search by name or university ID and print the matches.
 * Kept separate from delete so a lookup never carries delete risk.
 */

const logger = require('../logger');
const messages = require('../messages');
const state = require('../state');
const sheets = require('../sheets');

async function start(ctx, queryArg) {
  const query = String(queryArg || '').trim();
  if (query) return runSearch(ctx, query);
  state.set(ctx.chat.id, { mode: 'find', step: 'query' });
  return ctx.reply(messages.find.prompt, { parse_mode: 'HTML' });
}

async function runSearch(ctx, query) {
  const chatId = ctx.chat.id;
  state.set(chatId, { mode: 'find', step: 'query' });

  let matches = [];
  try {
    matches = await sheets.searchStudents(query);
  } catch (err) {
    logger.error(`find failed: ${err.message}`);
    await ctx.reply(messages.errors.sheets);
    return undefined;
  }

  if (!matches.length) {
    return ctx.reply(messages.remove.notFound(query), { parse_mode: 'HTML' });
  }

  const limited = matches.slice(0, 5);
  const blocks = [messages.find.results(matches.length)];
  for (const record of limited) {
    blocks.push(messages.recordBlock(record));
    if (record.rowNumber) blocks.push(`📄 الصف: ${record.rowNumber}`);
  }
  if (matches.length > limited.length) {
    blocks.push(`… و${matches.length - limited.length} نتيجة أخرى. حدّد البحث أكثر.`);
  }

  state.clear(chatId);
  return ctx.reply(blocks.join('\n'), { parse_mode: 'HTML' });
}

async function onText(ctx, text) {
  return runSearch(ctx, text);
}

module.exports = { start, onText };
