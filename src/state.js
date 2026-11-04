'use strict';

/**
 * In-memory conversation state, keyed by chat id.
 *
 * A single chat is handled by one person at a time (private chat with the bot),
 * so a per-chat map is enough. State is intentionally ephemeral: a restart only
 * means the student re-runs /add, the sheet itself is the source of truth.
 */

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes of inactivity
const sessions = new Map();

function now() {
  return Date.now();
}

function defaults() {
  return { mode: null, step: null, data: {}, pendingDelete: null, pendingMatches: null, updatedAt: now() };
}

function get(chatId) {
  const session = sessions.get(chatId);
  if (!session) return defaults();
  if (now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(chatId);
    return defaults();
  }
  return session;
}

/** Shallow-merge a patch into the session (keeps unspecified keys). */
function set(chatId, patch) {
  const current = get(chatId);
  const next = { ...current, ...patch, updatedAt: now() };
  sessions.set(chatId, next);
  return next;
}

function clear(chatId) {
  sessions.delete(chatId);
}

function prune() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [chatId, session] of sessions) {
    if (session.updatedAt < cutoff) sessions.delete(chatId);
  }
}

const pruneTimer = setInterval(prune, 10 * 60 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

module.exports = { get, set, clear, prune };
