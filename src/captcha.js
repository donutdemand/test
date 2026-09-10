const logger = require('./logger');

// CaptchaAI solver integration (2Captcha-style in.php / res.php protocol).
//
// Docs: https://blog.captchaai.com/captchaai-quickstart
//   Submit: POST {base}/in.php { key, method: 'hcaptcha', sitekey, pageurl, json: 1 }
//     → { status: 1, request: '<taskId>' }
//   Poll:   GET {base}/res.php?key=..&action=get&id=..&json=1  (first poll after ~15s, then every 5s)
//     → { status: 1, request: '<token>' }  or  { status: 0, request: 'CAPCHA_NOT_READY' }
//
// Base URL override: CAPTCHAAI_API_URL (default https://ocr.captchaai.com).
// Every step is logged so the dashboard shows progress.

const FIRST_POLL_DELAY_MS = 15000;
const POLL_EVERY_MS = 5000;
// Per CaptchaAI docs, server-side submit errors are transient:
// retry after ~10s with exponential backoff.
const SUBMIT_RETRY_DELAYS_MS = [10000, 20000, 40000];
const TRANSIENT_SUBMIT_ERRORS = new Set([
  'ERROR_SERVER_ERROR',
  'ERROR_INTERNAL_SERVER_ERROR',
  'ERROR_NO_SLOT_AVAILABLE',
]);

function solverBaseUrl() {
  return (
    process.env.CAPTCHAAI_API_URL || 'https://ocr.captchaai.com'
  ).replace(/\/+$/, '');
}

function hasKey(settings) {
  return Boolean(settings?.captchaApiKey);
}

function networkError(url, err) {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const cause = err?.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : '';
  return new Error(`Could not reach solver at ${host}${cause || `: ${err.message}`}`);
}

/** Parse a solver reply (JSON with json=1, or plain-text pipe format). */
function parseReply(text, status) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    if (/^OK\|/.test(raw)) return { status: 1, request: raw.slice(3) };
    throw new Error(`Solver error: ${raw.slice(0, 140) || `HTTP ${status}`}`);
  }
}

async function submitHcaptcha({ apiKey, sitekey, pageUrl, rqdata, username }) {
  // Discord serves hCaptcha Enterprise: captcha_rqdata must be forwarded as
  // the `data` param or the solve will not validate. Challenges are invisible.
  const params = {
    key: apiKey,
    method: 'hcaptcha',
    sitekey,
    pageurl: pageUrl,
    invisible: '1',
    ...(rqdata ? { data: rqdata } : {}),
    json: '1',
  };
  const url = `${solverBaseUrl()}/in.php`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });
    } catch (err) {
      throw networkError(url, err);
    }
    if (!res.ok && [429, 500, 502, 503].includes(res.status) && attempt < SUBMIT_RETRY_DELAYS_MS.length) {
      const wait = SUBMIT_RETRY_DELAYS_MS[attempt];
      logger.warn('captcha', `Solver HTTP ${res.status} — retrying submit in ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    const data = parseReply(await res.text().catch(() => ''), res.status);
    if (data.status === 1) return String(data.request);
    if (TRANSIENT_SUBMIT_ERRORS.has(String(data.request)) && attempt < SUBMIT_RETRY_DELAYS_MS.length) {
      const wait = SUBMIT_RETRY_DELAYS_MS[attempt];
      logger.warn('captcha', `Solver busy (${data.request})${username ? ` for ${username}` : ''} — retrying submit in ${wait / 1000}s (attempt ${attempt + 2})…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Solver rejected the task: ${describeError(data.request)}`);
  }
}

function describeError(code) {
  const known = {
    ERROR_WRONG_USER_KEY: 'bad API key format (CaptchaAI keys are 32 chars — re-copy it from the dashboard)',
    ERROR_KEY_DOES_NOT_EXIST: 'key not recognised — re-copy it from the CaptchaAI dashboard',
    ERROR_ZERO_BALANCE: 'no available threads/balance on the CaptchaAI account',
    ERROR_NO_SLOT_AVAILABLE: 'no solver slot free right now (transient — retry)',
    ERROR_ZERO_CAPTCHA_FILESIZE: 'empty captcha payload sent',
    ERROR_WRONG_FILE_EXTENSION: 'bad file type sent',
    ERROR_TOO_BIG_CAPTCHA_FILESIZE: 'captcha payload too large',
    ERROR_WRONG_ID_FORMAT: 'bad task id when polling',
    ERROR_CAPTCHA_UNSOLVABLE: 'solver could not solve it (often wrong sitekey for the page)',
    ERROR_BAD_PARAMETERS: 'bad parameters — usually a missing/wrong sitekey or pageurl',
    ERROR_PAGEURL: 'missing pageurl parameter',
    ERROR_WRONG_GOOGLEKEY: 'sitekey blank or malformed',
    ERROR_BAD_TOKEN_OR_PAGEURL: 'token/sitekey mismatch for the page',
  };
  const c = String(code || 'unknown error');
  return known[c] ? `${c} — ${known[c]}` : c;
}

async function pollSolution({ apiKey, taskId, timeoutMs = 120000, username }) {
  const who = username ? ` for ${username}` : '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(FIRST_POLL_DELAY_MS);
  const started = Date.now();
  for (;;) {
    const qs = new URLSearchParams({ key: apiKey, action: 'get', id: String(taskId), json: '1' });
    const url = `${solverBaseUrl()}/res.php?${qs}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw networkError(url, err);
    }
    const data = parseReply(await res.text().catch(() => ''), res.status);
    if (data.request === 'CAPCHA_NOT_READY') {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Solver timed out after ~${Math.round(timeoutMs / 1000)}s${who}.`);
      }
      await sleep(POLL_EVERY_MS);
      continue;
    }
    if (data.status === 1 && data.request) return String(data.request);
    throw new Error(`Solver failed: ${describeError(data.request)}`);
  }
}

/**
 * Solve a Discord captcha challenge. Returns the solution token string.
 * Every step is logged so the dashboard shows progress.
 */
async function solveDiscordCaptcha({ settings, sitekey, service, pageUrl, rqdata, username }) {
  const who = username ? ` for ${username}` : '';
  if (!hasKey(settings)) {
    throw new Error('Captcha required but no CaptchaAI key is saved in Settings.');
  }
  if (!sitekey) {
    throw new Error('Discord sent a captcha challenge without a sitekey — cannot solve automatically.');
  }
  if (service && String(service).toLowerCase() !== 'hcaptcha') {
    throw new Error(`Unsupported captcha service "${service}" — only hCaptcha is handled.`);
  }
  const target = pageUrl || 'https://discord.com/channels/@me';
  logger.info('captcha', `Submitting hCaptcha challenge${who} to CaptchaAI… (sitekey ${String(sitekey).slice(0, 8)}…, page ${target}${rqdata ? ', enterprise rqdata attached' : ''})`);
  const taskId = await submitHcaptcha({
    apiKey: settings.captchaApiKey,
    sitekey,
    pageUrl: target,
    rqdata,
    username,
  });
  logger.info('captcha', `Solver accepted task ${taskId}${who}, waiting for solution…`);
  const token = await pollSolution({ apiKey: settings.captchaApiKey, taskId, username });
  logger.info('captcha', `Captcha solved${who}, retrying…`);
  return token;
}

/** Check key validity / threads. Returns the raw balance string. */
async function getBalance(apiKey) {
  const qs = new URLSearchParams({ key: apiKey, action: 'getbalance', json: '1' });
  const url = `${solverBaseUrl()}/res.php?${qs}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw networkError(url, err);
  }
  const data = parseReply(await res.text().catch(() => ''), res.status);
  if (data.status !== 1) {
    throw new Error(`Balance check failed: ${describeError(data.request)}`);
  }
  return String(data.request);
}

module.exports = { solveDiscordCaptcha, getBalance, hasKey, solverBaseUrl };
