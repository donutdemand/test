const path = require('path');
const express = require('express');
const { validateToken, sendChannelMessage, isSnowflake } = require('./discord');
const store = require('./store');
const logger = require('./logger');
const Scheduler = require('./scheduler');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  let state = store.load();
  const persist = () => store.save(state);
  const scheduler = new Scheduler(() => state, persist);

  // ---- static dashboard ----
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---- tokens ----
  app.get('/api/tokens', (req, res) => {
    res.json({ tokens: state.tokens.map(store.publicToken) });
  });

  app.post('/api/tokens', async (req, res) => {
    const rawTokens = Array.isArray(req.body.tokens)
      ? req.body.tokens
      : [req.body.token].filter(Boolean);
    if (rawTokens.length === 0) {
      return res.status(400).json({ error: 'Provide "token" or "tokens[]" in the request body.' });
    }
    const added = [];
    const failed = [];
    for (const raw of rawTokens.slice(0, 50)) {
      const clean = String(raw).trim().replace(/^Bot\s+/i, '');
      if (state.tokens.some((t) => t.token === clean)) {
        failed.push({ token: `${clean.slice(0, 4)}••••`, error: 'Token already added.' });
        continue;
      }
      try {
        const { me, authType, token } = await validateToken(clean);
        const record = {
          id: store.newId('tok'),
          token,
          authType,
          username: me.username ? `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''}` : 'unknown',
          userId: me.id || null,
          discriminator: me.discriminator || null,
          status: 'active',
          lastError: null,
          createdAt: new Date().toISOString(),
        };
        state.tokens.push(record);
        added.push(store.publicToken(record));
        logger.info('tokens', `Account token added for ${record.username} (${authType})`);
        if (authType === 'bot') {
          logger.info('tokens', 'Bot token detected — works the same way for sending.');
        }
      } catch (err) {
        failed.push({ token: `${String(clean).slice(0, 4)}••••`, error: err.message });
        logger.warn('tokens', `Rejected token: ${err.message}`);
      }
    }
    persist();
    res.status(added.length ? 201 : 400).json({ added, failed });
  });

  app.delete('/api/tokens/:id', (req, res) => {
    const idx = state.tokens.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Token not found.' });
    const [removed] = state.tokens.splice(idx, 1);
    // Disable tasks that depended on this token rather than deleting them.
    for (const task of state.tasks) {
      if (task.tokenId === removed.id) {
        task.enabled = false;
        scheduler.unschedule(task.id);
      }
    }
    persist();
    logger.info('tokens', `Token removed (${removed.username || removed.id})`);
    res.json({ ok: true });
  });

  // Re-check every stored account token against Discord (finds locked /
  // invalid / password-changed accounts without re-pasting anything).
  app.post('/api/tokens/revalidate', async (req, res) => {
    const results = [];
    for (const t of state.tokens) {
      try {
        const { me, authType } = await validateToken(t.token);
        t.username = me.username
          ? `${me.username}${me.discriminator && me.discriminator !== '0' ? `#${me.discriminator}` : ''}`
          : t.username;
        t.userId = me.id || t.userId;
        t.authType = authType;
        t.status = 'active';
        t.lastError = null;
        results.push({ id: t.id, ok: true, username: t.username });
      } catch (err) {
        t.status = 'invalid';
        t.lastError = err.message;
        results.push({ id: t.id, ok: false, username: t.username, error: err.message });
        logger.warn('tokens', `Token for ${t.username} no longer valid: ${err.message}`);
      }
    }
    persist();
    logger.info('tokens', `Revalidated ${state.tokens.length} token(s): ${results.filter((r) => r.ok).length} active`);
    res.json({ results, tokens: state.tokens.map(store.publicToken) });
  });

  // ---- tasks ----
  app.get('/api/tasks', (req, res) => {
    res.json({ tasks: state.tasks, minIntervalSeconds: scheduler.minIntervalSeconds() });
  });

  function validateTaskInput(body) {
    const errors = [];
    if (!body.tokenId || !state.tokens.some((t) => t.id === body.tokenId)) {
      errors.push('Choose a valid token.');
    }
    if (!isSnowflake(body.channelId)) errors.push('channelId must be a numeric Discord channel ID.');
    const messages = Array.isArray(body.messages) ? body.messages.map((m) => String(m)).filter((m) => m.trim()) : [];
    if (body.message && !messages.includes(String(body.message))) messages.unshift(String(body.message));
    if (messages.length === 0) errors.push('Add at least one message.');
    if (messages.some((m) => m.length > 2000)) errors.push('Each message must be ≤ 2000 characters.');
    const interval = Number(body.intervalSeconds);
    if (!Number.isFinite(interval) || interval < scheduler.minIntervalSeconds()) {
      errors.push(`intervalSeconds must be ≥ ${scheduler.minIntervalSeconds()}.`);
    }
    const jitter = Number(body.jitterSeconds ?? 0);
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 3600) {
      errors.push('jitterSeconds must be between 0 and 3600.');
    }
    if (body.rotation && !['random', 'round-robin'].includes(body.rotation)) {
      errors.push('rotation must be "random" or "round-robin".');
    }
    return { errors, messages, interval, jitter };
  }

  app.post('/api/tasks', (req, res) => {
    const { errors, messages, interval, jitter } = validateTaskInput(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const task = {
      id: store.newId('task'),
      name: String(req.body.name || `Task ${state.tasks.length + 1}`).slice(0, 80),
      tokenId: req.body.tokenId,
      channelId: String(req.body.channelId).trim(),
      messages: messages.slice(0, 50),
      rotation: req.body.rotation || 'random',
      intervalSeconds: interval,
      jitterSeconds: jitter,
      enabled: req.body.enabled !== false,
      runCount: 0,
      lastRunAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
    };
    state.tasks.push(task);
    persist();
    if (task.enabled) scheduler.schedule(task.id);
    logger.info('tasks', `Task created: "${task.name}" every ${task.intervalSeconds}s`);
    res.status(201).json({ task });
  });

  app.put('/api/tasks/:id', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    const merged = { ...task, ...req.body, id: task.id };
    const { errors, messages, interval, jitter } = validateTaskInput(merged);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    Object.assign(task, {
      name: String(merged.name || task.name).slice(0, 80),
      tokenId: merged.tokenId,
      channelId: String(merged.channelId).trim(),
      messages,
      rotation: merged.rotation || 'random',
      intervalSeconds: interval,
      jitterSeconds: jitter,
      enabled: merged.enabled !== false,
    });
    persist();
    scheduler.unschedule(task.id);
    if (task.enabled) scheduler.schedule(task.id);
    logger.info('tasks', `Task updated: "${task.name}"`);
    res.json({ task });
  });

  app.post('/api/tasks/:id/toggle', (req, res) => {
    const task = state.tasks.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    task.enabled = !task.enabled;
    persist();
    scheduler.unschedule(task.id);
    if (task.enabled) scheduler.schedule(task.id);
    logger.info('tasks', `Task "${task.name}" ${task.enabled ? 'enabled' : 'paused'}`);
    res.json({ task });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const idx = state.tasks.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found.' });
    const [removed] = state.tasks.splice(idx, 1);
    scheduler.unschedule(removed.id);
    persist();
    logger.info('tasks', `Task deleted: "${removed.name}"`);
    res.json({ ok: true });
  });

  // Send one message immediately (useful for testing a token + channel).
  app.post('/api/send-test', async (req, res) => {
    const { tokenId, channelId, message } = req.body || {};
    const token = state.tokens.find((t) => t.id === tokenId);
    if (!token) return res.status(400).json({ error: 'Choose a valid token.' });
    try {
      const sent = await sendChannelMessage(token, String(channelId || '').trim(), message);
      logger.info('send', `Test message sent via ${token.username} to ${channelId}`);
      res.json({ ok: true, messageId: sent.id });
    } catch (err) {
      logger.error('send', `Test message failed: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ---- logs ----
  app.get('/api/logs', (req, res) => {
    res.json({ logs: logger.recent(Number(req.query.limit) || 100) });
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const unsubscribe = logger.subscribe(res);
    req.on('close', unsubscribe);
  });

  return { app, scheduler, getState: () => state, persist };
}

module.exports = { createApp };
