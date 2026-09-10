const logger = require('./logger');

// CaptchaAI-compatible solver plumbing.
//
// When Discord answers a join/send with a captcha challenge (a payload with
// `captcha_sitekey` / `captcha_service`), the dashboard shows it in the logs
// and — if the user stored a CaptchaAI API key in Settings — we attempt to
// solve it through the provider and retry the request with the solution.
//
// The exact HTTP shape differs between solver providers, so the endpoint is
// overridable via CAPTCHAAI_API_URL. The default targets a CapSolver-style
// `createTask` flow; if the provider answers differently the attempt is
// logged as failed and the join is marked `captcha_failed` instead of
// silently pretending it worked.

function solverBaseUrl() {
  return (
    process.env.CAPTCHAAI_API_URL || 'https://api.captcha.ai/capsolver'
  ).replace(/\/+$/, '');
}

function hasKey(settings) {
  return Boolean(settings?.captchaApiKey);
}

async function createHcaptchaTask({ apiKey, sitekey, pageUrl, rqdata }) {
  const res = await fetch(`${solverBaseUrl()}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: pageUrl || 'https://discord.com',
        websiteKey: sitekey,
        ...(rqdata ? { enterprisePayload: { rqdata } } : {}),
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errorId || !data.taskId) {
    throw new Error(
      `Solver rejected the task: ${data.errorDescription || data.error || `HTTP ${res.status}`}`
    );
  }
  return data.taskId;
}

async function pollTaskResult({ apiKey, taskId, timeoutMs = 90000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${solverBaseUrl()}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === 'ready') return data.solution;
    if (data.status === 'failed' || data.errorId) {
      throw new Error(`Solver failed: ${data.errorDescription || data.error || 'unknown'}`);
    }
  }
  throw new Error('Solver timed out waiting for a solution.');
}

/**
 * Attempt to solve a Discord captcha challenge. Returns the solution token
 * string, or throws. Every step is logged so the dashboard shows progress.
 */
async function solveDiscordCaptcha({ settings, sitekey, service, rqdata, username }) {
  const who = username ? ` for ${username}` : '';
  if (!hasKey(settings)) {
    throw new Error('Captcha required but no CaptchaAI key is saved in Settings.');
  }
  if ((service || '').toLowerCase() !== 'hcaptcha') {
    throw new Error(`Unsupported captcha service "${service || 'unknown'}" — only hCaptcha is handled.`);
  }
  logger.info('captcha', `Solving ${service || 'hCaptcha'} challenge${who} via solver…`);
  const taskId = await createHcaptchaTask({
    apiKey: settings.captchaApiKey,
    sitekey,
    rqdata,
  });
  logger.info('captcha', `Solver accepted task ${taskId}${who}, waiting for solution…`);
  const solution = await pollTaskResult({ apiKey: settings.captchaApiKey, taskId });
  const token = solution?.gRecaptchaResponse || solution?.token || solution?.text;
  if (!token) throw new Error('Solver returned an empty solution.');
  logger.info('captcha', `Captcha solved${who}, retrying…`);
  return token;
}

module.exports = { solveDiscordCaptcha, hasKey, solverBaseUrl };
