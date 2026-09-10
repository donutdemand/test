const path = require('path');
const express = require('express');
const { validateToken, sendChannelMessage, isSnowflake, parseInvite, joinInvite } = require('./discord');
const { solveDiscordCaptcha, getBalance } = require('./captcha');
const store = require('./store');
const logger = require('./logger');
const Scheduler = require('./scheduler');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  let state = store.load();
  if (!state.settings) state.settings = { captchaApiKey: '', captchaProvider: 'captchaai' };
  const persist = () => store.save(state);
  const scheduler = new Scheduler(() => state, persist);

  // Bulk operations (e.g. join-all) with live progress for the dashboard.
  const operations = [];
  function newOperation(type, total, meta) {
    const op = {
      id: store.newId('op'),
      type,
      status: 'running',
      total,
      done: 0,
      ok: 0,
      failed: 0,
      meta: meta || {},
      results: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    operations.unshift(op);
    if (operations.length > 20) operations.pop();
    return op;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function joinDelayMs() {
    const n = Number(process.env.JOIN_DELAY_SECONDS || 8);
    return (Number.isFinite(n) && n >= 0 ? n : 8) * 1000;
  }

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

  // ---- settings (CaptchaAI key etc.) ----
  app.get('/api/settings', (req, res) => {
    res.json({ settings: store.publicSettings(state.settings) });
  });

  app.put('/api/settings', (req, res) => {
    const { captchaApiKey, captchaProvider } = req.body || {};
    if (captchaApiKey !== undefined) {
      const key = String(captchaApiKey || '').trim();
      if (key && key.length < 8) {
        return res.status(400).json({ error: 'That API key looks too short.' });
      }
      state.settings.captchaApiKey = key;
      logger.info('settings', key ? 'CaptchaAI API key saved.' : 'CaptchaAI API key removed.');
    }
    if (captchaProvider !== undefined) {
      state.settings.captchaProvider = String(captchaProvider || 'captchaai').slice(0, 40);
    }
    persist();
    res.json({ settings: store.publicSettings(state.settings) });
  });

  // Verify the saved CaptchaAI key (balance/threads) without spending a solve.
  app.get('/api/settings/captcha-balance', async (req, res) => {
    if (!state.settings.captchaApiKey) {
      return res.status(400).json({ error: 'No CaptchaAI key saved yet.' });
    }
    try {
      const balance = await getBalance(state.settings.captchaApiKey);
      logger.info('captcha', `CaptchaAI balance check OK: ${balance}`);
      res.json({ balance });
    } catch (err) {
      logger.error('captcha', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---- server joiner ----
  app.get('/api/operations', (req, res) => {
    res.json({ operations: operations.slice(0, 20) });
  });

  app.post('/api/tokens/join-all', async (req, res) => {
    let code;
    try {
      code = parseInvite((req.body || {}).invite);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    const targets = state.tokens.filter((t) => t.status !== 'invalid');
    if (targets.length === 0) {
      return res.status(400).json({ error: 'No active tokens to join with. Add tokens first.' });
    }
    const delayMs = joinDelayMs();
    const op = newOperation('join-all', targets.length, { invite: code });
    logger.info('join', `Join-all started: ${targets.length} account(s) → invite ${code} (~${Math.max(1, Math.round(delayMs / 1000))}s apart)`);
    res.status(202).json({ operation: op });

    (async () => {
      for (const t of targets) {
        try {
          await joinInvite(t, code, async (challenge) => {
            logger.warn('join', `Captcha challenge for ${t.username} (service: ${challenge.service}) — solving via CaptchaAI…`);
            try {
              return await solveDiscordCaptcha({
                settings: state.settings,
                sitekey: challenge.sitekey,
                service: challenge.service,
                pageUrl: `https://discord.gg/${code}`,
                username: t.username,
              });
            } catch (solveErr) {
              logger.error('captcha', `Captcha solve failed for ${t.username}: ${solveErr.message}`);
              throw solveErr;
            }
          });
          op.results.push({ tokenId: t.id, username: t.username, ok: true });
          op.ok += 1;
          logger.info('join', `✓ ${t.username} joined ${code}`);
        } catch (err) {
          const reason = err.message === 'captcha_required'
            ? 'captcha required (no usable solver key)'
            : err.message;
          op.results.push({ tokenId: t.id, username: t.username, ok: false, error: reason });
          op.failed += 1;
          logger.error('join', `✗ ${t.username}: ${reason}`);
          if (err.status === 429 && err.retryAfter) {
            const wait = Math.ceil(Number(err.retryAfter) * 1000) + 1000;
            logger.warn('join', `Rate limited — pausing joins for ~${Math.round(wait / 1000)}s`);
            await sleep(wait);
          }
        }
        op.done += 1;
        if (t !== targets[targets.length - 1]) await sleep(delayMs + Math.random() * 3000);
      }
      op.status = 'done';
      op.finishedAt = new Date().toISOString();
      logger.info('join', `Join-all finished: ${op.ok} joined, ${op.failed} failed`);
    })().catch((err) => {
      op.status = 'done';
      op.finishedAt = new Date().toISOString();
      logger.error('join', `Join-all crashed: ${err.message}`);
    });
  });

  // ---- progress / stats ----
  app.get('/api/stats', (req, res) => {
    const active = state.tokens.filter((t) => t.status !== 'invalid');
    res.json({
      tokens: { total: state.tokens.length, active: active.length, invalid: state.tokens.length - active.length },
      tasks: {
        total: state.tasks.length,
        enabled: state.tasks.filter((t) => t.enabled).length,
        messagesSent: state.tasks.reduce((n, t) => n + (t.runCount || 0), 0),
      },
      captcha: { configured: Boolean(state.settings.captchaApiKey) },
      operations: operations.slice(0, 5).map((o) => ({
        id: o.id, type: o.type, status: o.status,
        total: o.total, done: o.done, ok: o.ok, failed: o.failed,
      })),
    });
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
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const unsubscribe = logger.subscribe(res);
    req.on('close', unsubscribe);
  });

  return { app, scheduler, getState: () => state, persist };
}

module.exports = { createApp };
