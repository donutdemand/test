require('dotenv').config();
const { createApp } = require('./server');
const { validateToken } = require('./discord');
const store = require('./store');
const logger = require('./logger');

const PORT = Number(process.env.PORT || 3000);

async function preloadTokens(state, persist) {
  const envTokens = String(process.env.DISCORD_TOKENS || '')
    .split(',')
    .map((t) => t.trim().replace(/^Bot\s+/i, ''))
    .filter(Boolean);
  let changed = false;
  for (const raw of envTokens) {
    if (state.tokens.some((t) => t.token === raw)) continue;
    try {
      const { me, authType, token } = await validateToken(raw);
      state.tokens.push({
        id: store.newId('tok'),
        token,
        authType,
        username: me.username || 'unknown',
        userId: me.id || null,
        discriminator: me.discriminator || null,
        status: 'active',
        lastError: null,
        createdAt: new Date().toISOString(),
      });
      changed = true;
      logger.info('boot', `Preloaded token for ${me.username}`);
    } catch (err) {
      logger.warn('boot', `Skipped invalid preload token: ${err.message}`);
    }
  }
  if (changed) persist();
}

async function main() {
  const { app, scheduler, getState, persist } = createApp();
  await preloadTokens(getState(), persist);
  scheduler.startAll();

  const server = app.listen(PORT, () => {
    logger.info('boot', `Dashboard live at http://localhost:${PORT}`);
    const { tokens, tasks } = getState();
    logger.info('boot', `${tokens.length} token(s), ${tasks.filter((t) => t.enabled).length}/${tasks.length} task(s) enabled`);
  });

  const shutdown = () => {
    logger.info('boot', 'Shutting down…');
    scheduler.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
