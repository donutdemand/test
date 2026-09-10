const $ = (id) => document.getElementById(id);
const api = {
  async get(p) { const r = await fetch(p); return r.json(); },
  async send(p, method, body) {
    const r = await fetch(p, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  },
};

let tokens = [];
let tasks = [];

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refresh() {
  const [t, k] = await Promise.all([api.get('/api/tokens'), api.get('/api/tasks')]);
  tokens = t.tokens || [];
  tasks = k.tasks || [];
  $('statTokens').textContent = tokens.length;
  $('statTasks').textContent = tasks.filter((x) => x.enabled).length + '/' + tasks.length;
  renderTokens();
  renderTasks();
  syncSelects();
}

function renderTokens() {
  const box = $('tokenList');
  if (!tokens.length) {
    box.innerHTML = '<div class="hint">No tokens yet — paste your first bot token above to get started.</div>';
    return;
  }
  box.innerHTML = tokens.map((t) => `
    <div class="token-card">
      <div class="avatar">${esc((t.username || '?')[0].toUpperCase())}</div>
      <div class="meta">
        <strong>${esc(t.username)} <span class="badge ${esc(t.authType)}">${esc(t.authType)}</span></strong>
        <code>${esc(t.masked)} · ${esc(t.userId || '')}</code>
      </div>
      <button class="btn small danger" onclick="removeToken('${t.id}')">Remove</button>
    </div>`).join('');
}

function taskTokenName(id) {
  const t = tokens.find((x) => x.id === id);
  return t ? t.username : '(removed token)';
}

function renderTasks() {
  const box = $('taskList');
  if (!tasks.length) {
    box.innerHTML = '<div class="hint">No tasks yet — create one above and it will start sending on its timer.</div>';
    return;
  }
  box.innerHTML = tasks.map((t) => `
    <div class="task-card">
      <div class="top">
        <strong><span class="dot ${t.enabled ? 'on' : 'off'}"></span>${esc(t.name)}</strong>
        <span class="badge ${t.enabled ? 'bot' : 'user'}">${t.enabled ? 'running' : 'paused'}</span>
      </div>
      <div class="detail">
        🔑 <code>${esc(taskTokenName(t.tokenId))}</code> → #<code>${esc(t.channelId)}</code><br/>
        ⏱ every ${esc(t.intervalSeconds)}s${t.jitterSeconds ? ` +0–${esc(t.jitterSeconds)}s jitter` : ''} · ${esc(t.rotation)} · ${esc((t.messages || []).length)} message(s) · sent ${esc(t.runCount || 0)}×
        ${t.lastRunAt ? `<br/>last run: ${esc(new Date(t.lastRunAt).toLocaleString())}` : ''}
      </div>
      ${t.lastError ? `<div class="err">⚠ ${esc(t.lastError)}</div>` : ''}
      <div class="actions">
        <button class="btn small ghost" onclick="toggleTask('${t.id}')">${t.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn small danger" onclick="deleteTask('${t.id}')">Delete</button>
      </div>
    </div>`).join('');
}

function syncSelects() {
  for (const id of ['taskToken', 'testToken']) {
    const sel = $(id);
    sel.innerHTML = tokens.length
      ? tokens.map((t) => `<option value="${t.id}">${esc(t.username)} (${esc(t.authType)})</option>`).join('')
      : '<option value="">— add a token first —</option>';
  }
}

window.removeToken = async (id) => {
  if (!confirm('Remove this token? Its tasks will be paused.')) return;
  try { await api.send(`/api/tokens/${id}`, 'DELETE'); await refresh(); toast('Token removed'); }
  catch (e) { toast(e.message); }
};

window.toggleTask = async (id) => {
  try { await api.send(`/api/tasks/${id}/toggle`, 'POST'); await refresh(); }
  catch (e) { toast(e.message); }
};

window.deleteTask = async (id) => {
  if (!confirm('Delete this task?')) return;
  try { await api.send(`/api/tasks/${id}`, 'DELETE'); await refresh(); toast('Task deleted'); }
  catch (e) { toast(e.message); }
};

$('tokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('tokenInput').value.trim();
  if (!v) return;
  try {
    const r = await api.send('/api/tokens', 'POST', { token: v });
    $('tokenInput').value = '';
    await refresh();
    toast(r.failed?.length ? `Added ${r.added.length}, ${r.failed.length} failed` : 'Token added ✓');
    if (r.failed?.length) toast(r.failed[0].error);
  } catch (err) { toast(err.message); }
});

$('bulkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const parts = $('bulkInput').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return;
  try {
    const r = await api.send('/api/tokens', 'POST', { tokens: parts });
    $('bulkInput').value = '';
    await refresh();
    toast(`Bulk add: ${r.added.length} added, ${(r.failed || []).length} failed`);
  } catch (err) { toast(err.message); }
});

$('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('taskName').value.trim(),
    tokenId: $('taskToken').value,
    channelId: $('taskChannel').value.trim(),
    messages: $('taskMessages').value.split('\n').map((s) => s.trim()).filter(Boolean),
    rotation: $('taskRotation').value,
    intervalSeconds: Number($('taskInterval').value),
    jitterSeconds: Number($('taskJitter').value),
    enabled: $('taskEnabled').checked,
  };
  try {
    await api.send('/api/tasks', 'POST', body);
    $('taskName').value = ''; $('taskChannel').value = ''; $('taskMessages').value = '';
    await refresh();
    toast('Task created ✓');
  } catch (err) { toast(err.message); }
});

$('testForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api.send('/api/send-test', 'POST', {
      tokenId: $('testToken').value,
      channelId: $('testChannel').value.trim(),
      message: $('testMessage').value,
    });
    toast('Test message sent ✓');
  } catch (err) { toast(err.message); }
});

$('clearLogs').addEventListener('click', () => { $('logView').innerHTML = ''; });

function addLog(entry) {
  const el = document.createElement('div');
  el.className = `log-${entry.level}`;
  el.innerHTML = `<span class="log-ts">${esc(new Date(entry.ts).toLocaleTimeString())}</span><strong>[${esc(entry.scope)}]</strong> ${esc(entry.message)}`;
  const view = $('logView');
  view.appendChild(el);
  while (view.children.length > 300) view.removeChild(view.firstChild);
  view.scrollTop = view.scrollHeight;
}

async function boot() {
  try { await refresh(); }
  catch (e) { toast('Could not reach server: ' + e.message); }
  try {
    const { logs } = await api.get('/api/logs?limit=100');
    (logs || []).forEach(addLog);
  } catch { /* ignore */ }
  const src = new EventSource('/api/events');
  src.onmessage = (ev) => {
    try { addLog(JSON.parse(ev.data)); } catch { /* ignore */ }
  };
}

boot();
