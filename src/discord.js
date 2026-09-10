const API_BASE = 'https://discord.com/api/v10';
const SNOWFLAKE_RE = /^[0-9]{5,25}$/;

/**
 * Account (user) tokens are sent raw as the `Authorization` header,
 * while bot tokens are sent as `Bot <token>`. We auto-detect which one
 * works so the dashboard accepts both — account tokens first, since
 * that is the primary use case here.
 */
async function tryAuth(token, prefix) {
  const auth = prefix ? `Bot ${token}` : token;
  const res = await fetch(`${API_BASE}/users/@me`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Token validation failed (HTTP ${res.status})`);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  const me = await res.json();
  return { me, authType: prefix ? 'bot' : 'user' };
}

async function validateToken(token) {
  const clean = String(token || '').trim().replace(/^Bot\s+/i, '');
  if (clean.length < 20) {
    const err = new Error('That token looks too short to be valid.');
    err.status = 400;
    throw err;
  }
  // Account tokens first (primary use case), bot tokens as fallback.
  try {
    return { ...(await tryAuth(clean, false)), token: clean };
  } catch (userErr) {
    try {
      return { ...(await tryAuth(clean, true)), token: clean };
    } catch {
      throw userErr;
    }
  }
}

function authHeader(stored) {
  return stored.authType === 'bot' ? `Bot ${stored.token}` : stored.token;
}

async function sendChannelMessage(stored, channelId, content) {
  if (!SNOWFLAKE_RE.test(String(channelId))) {
    const err = new Error('Invalid channel ID (expected a numeric snowflake).');
    err.status = 400;
    throw err;
  }
  const text = String(content ?? '').trim();
  if (!text) {
    const err = new Error('Message content is empty.');
    err.status = 400;
    throw err;
  }
  if (text.length > 2000) {
    const err = new Error('Message exceeds Discord\'s 2000 character limit.');
    err.status = 400;
    throw err;
  }
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(stored),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: text }),
  });
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(`Rate limited. Retry after ~${data.retry_after ?? '?'}s.`);
    err.status = 429;
    err.retryAfter = data.retry_after;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Discord API error (HTTP ${res.status}): ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function isSnowflake(id) {
  return SNOWFLAKE_RE.test(String(id || ''));
}

/** Accept a full invite URL (`discord.gg/abc`, `discord.com/invite/abc`) or a raw code. */
function parseInvite(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const err = new Error('Paste a Discord server invite link or code.');
    err.status = 400;
    throw err;
  }
  const m = raw.match(/(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)([A-Za-z0-9-]+)/i);
  const code = (m ? m[1] : raw).trim();
  if (!/^[A-Za-z0-9-]{2,32}$/.test(code)) {
    const err = new Error('Could not read an invite code from that link.');
    err.status = 400;
    throw err;
  }
  return code;
}

/**
 * Join a server with one stored token. If Discord answers with a captcha
 * challenge and `solveCaptcha` is provided, it is called with the challenge
 * and the join is retried once with the solution.
 */
async function joinInvite(stored, code, solveCaptcha) {
  const attempt = async (captchaKey) => {
    const res = await fetch(`${API_BASE}/invites/${code}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(stored),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(captchaKey ? { captcha_key: captchaKey } : {}),
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(`Rate limited. Retry after ~${data.retry_after ?? '?'}s.`);
      err.status = 429;
      err.retryAfter = data.retry_after;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data?.captcha_sitekey && solveCaptcha) {
        const err = new Error('captcha_required');
        err.captcha = {
          sitekey: data.captcha_sitekey,
          service: data.captcha_service || 'hcaptcha',
          rqdata: data.captcha_rqdata || data.rqdata || null,
        };
        throw err;
      }
      const msg = data?.message || `HTTP ${res.status}`;
      const err = new Error(`Join failed (${msg})`);
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  };

  try {
    return await attempt(null);
  } catch (err) {
    if (err.message === 'captcha_required' && solveCaptcha) {
      const key = await solveCaptcha(err.captcha);
      return await attempt(key);
    }
    throw err;
  }
}

module.exports = { validateToken, sendChannelMessage, isSnowflake, parseInvite, joinInvite };
