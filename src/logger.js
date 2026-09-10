// In-memory ring buffer + SSE fan-out for live logs.
const MAX_LOGS = 500;
const logs = [];
const listeners = new Set();

function levelRank(level) {
  return level === 'error' ? 0 : level === 'warn' ? 1 : 2;
}

function push(level, scope, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message: String(message),
    meta: meta || undefined,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  for (const res of listeners) {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      // ignore broken SSE clients; cleaned up on close
    }
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${entry.ts}] [${scope}] ${entry.message}`);
}

const info = (scope, msg, meta) => push('info', scope, msg, meta);
const warn = (scope, msg, meta) => push('warn', scope, msg, meta);
const error = (scope, msg, meta) => push('error', scope, msg, meta);

function recent(limit = 100) {
  return logs.slice(-Math.max(1, Math.min(limit, MAX_LOGS)));
}

function subscribe(res) {
  listeners.add(res);
  return () => listeners.delete(res);
}

module.exports = { info, warn, error, recent, subscribe, levelRank };
