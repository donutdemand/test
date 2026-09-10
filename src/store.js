const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveStorePath() {
  return path.resolve(process.env.STORE_PATH || './data/store.json');
}

function blankStore() {
  return { tokens: [], tasks: [], settings: { captchaApiKey: '', captchaProvider: 'captchaai' } };
}

/** Mask a token for API responses — the full secret never leaves the server. */
function maskToken(token) {
  if (!token || token.length < 10) return '••••••';
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}

function publicToken(t) {
  return {
    id: t.id,
    username: t.username,
    discriminator: t.discriminator,
    userId: t.userId,
    authType: t.authType,
    status: t.status,
    lastError: t.lastError || null,
    createdAt: t.createdAt,
    masked: maskToken(t.token),
  };
}

function load() {
  const file = resolveStorePath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return {
      tokens: Array.isArray(data.tokens) ? data.tokens : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      settings: {
        captchaApiKey: data.settings?.captchaApiKey || '',
        captchaProvider: data.settings?.captchaProvider || 'captchaai',
      },
    };
  } catch {
    return blankStore();
  }
}

/** Settings as safe for the API — the key itself never leaves the server. */
function publicSettings(settings) {
  const key = settings?.captchaApiKey || '';
  return {
    captchaProvider: settings?.captchaProvider || 'captchaai',
    captchaKeyConfigured: key.length > 0,
    captchaKeyMasked: key ? maskToken(key) : null,
  };
}

function save(state) {
  const file = resolveStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = { load, save, newId, publicToken, publicSettings, maskToken, blankStore, resolveStorePath };
