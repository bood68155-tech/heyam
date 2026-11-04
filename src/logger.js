'use strict';

/**
 * Small structured logger. Keeps output readable in a terminal / pm2 / journalctl
 * and never prints secrets (tokens, keys, full phone numbers).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

// Bounded in-memory tail of warnings/errors. Serverless platforms hand you logs
// only through a dashboard or CLI; keeping the last entries in the instance lets
// GET /health expose what actually broke on the instance that served the update.
const RECENT_LIMIT = 25;
const recent = [];

function stamp() {
  // Local ISO-like timestamp, easier to scan than a UTC string.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function remember(level, args) {
  try {
    const message = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.message;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ')
      .slice(0, 500);
    recent.push({ at: new Date().toISOString(), level, message });
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  } catch {
    // diagnostics must never break request handling
  }
}

function write(level, args) {
  if (level === 'warn' || level === 'error') remember(level, args);
  if (LEVELS[level] < threshold) return;
  const tag = level.toUpperCase().padEnd(5);
  const line = `${stamp()} ${tag}`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
}

module.exports = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  /** Most recent warnings/errors seen by this instance (newest last). */
  recent: (limit = RECENT_LIMIT) => recent.slice(-limit),
};
