const { sendChannelMessage } = require('./discord');
const logger = require('./logger');

// Per-task timeout loops with jitter: nextDelay = interval + rand(0, jitter).
// Kept in this module so server routes stay thin.
class Scheduler {
  constructor(getState, persist) {
    this.getState = getState;
    this.persist = persist;
    this.timers = new Map(); // taskId -> Timeout
    this.counters = new Map(); // taskId -> round-robin index
  }

  minIntervalSeconds() {
    const n = Number(process.env.MIN_INTERVAL_SECONDS || 5);
    return Number.isFinite(n) && n > 0 ? n : 5;
  }

  startAll() {
    for (const task of this.getState().tasks) {
      if (task.enabled) this.schedule(task.id);
    }
  }

  stopAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  schedule(taskId) {
    this.unschedule(taskId);
    const task = this.getState().tasks.find((t) => t.id === taskId);
    if (!task || !task.enabled) return;
    const delay = this.nextDelayMs(task);
    logger.info('scheduler', `Task "${task.name}" next run in ${Math.round(delay / 1000)}s`);
    this.timers.set(
      taskId,
      setTimeout(() => this.run(taskId).catch(() => {}), delay)
    );
  }

  unschedule(taskId) {
    const existing = this.timers.get(taskId);
    if (existing) clearTimeout(existing);
    this.timers.delete(taskId);
  }

  nextDelayMs(task) {
    const base = Math.max(Number(task.intervalSeconds) || 60, this.minIntervalSeconds());
    const jitter = Math.max(Number(task.jitterSeconds) || 0, 0);
    return (base + Math.random() * jitter) * 1000;
  }

  pickMessage(task) {
    const msgs = (task.messages || []).filter((m) => String(m || '').trim());
    if (msgs.length === 0) return '';
    if (task.rotation === 'round-robin') {
      const i = this.counters.get(task.id) || 0;
      this.counters.set(task.id, (i + 1) % msgs.length);
      return msgs[i % msgs.length];
    }
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  async run(taskId) {
    const state = this.getState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || !task.enabled) return;

    try {
      const token = state.tokens.find((t) => t.id === task.tokenId);
      if (!token) throw new Error('Assigned token was removed.');
      const content = this.pickMessage(task);
      if (!content) throw new Error('Task has no messages to send.');
      await sendChannelMessage(token, task.channelId, content);
      task.lastRunAt = new Date().toISOString();
      task.lastError = null;
      task.runCount = (task.runCount || 0) + 1;
      logger.info('send', `✓ [${task.name}] sent via ${token.username || token.id}`, {
        taskId,
        channelId: task.channelId,
      });
    } catch (err) {
      task.lastError = err.message;
      logger.error('send', `✗ [${task ? task.name : taskId}] ${err.message}`, { taskId });
      // Back off after a rate limit instead of hammering the API.
      if (err.status === 429 && err.retryAfter) {
        this.persist();
        this.timers.set(
          taskId,
          setTimeout(
            () => this.run(taskId).catch(() => {}),
            Math.ceil(Number(err.retryAfter) * 1000) + 1000
          )
        );
        return;
      }
    }
    this.persist();
    this.schedule(taskId);
  }
}

module.exports = Scheduler;
