'use strict';

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { mergeSettings } = require('./settings');

class StopError extends Error {
  constructor() {
    super('Остановлено');
    this.name = 'StopError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ядро бота. Ничего не знает про Telegram — только события:
 *   session:start, action, video, captcha, comment:pending, comment:decided,
 *   comment:posted, error, session:end
 */
class Bot extends EventEmitter {
  constructor({ config, db, ai, browser, stealth, logger }) {
    super();
    this.config = config;
    this.db = db;
    this.ai = ai;
    this.browser = browser;
    this.stealth = stealth;
    this.logger = logger;

    this._running = false;
    this._stopRequested = false;
    this._paused = false;
    this._sleepers = new Set();
    this._pending = null;
    this._forceCaptchaDone = false;

    this.mode = 'search';
    this.query = null;
    this.sessionId = null;
    this.startedAt = null;
    this.stats = { videos: 0, comments: 0, skipped: 0, failed: 0 };
    this.lastAction = 'Готов к запуску';
    this.lastActionAt = Date.now();
    this.settings = mergeSettings(db.getSettingsMap(), config);

    this.browser.shouldStop = () => this._stopRequested;
    this.browser.onCaptcha = () => this.#handleCaptcha();
  }

  /* --------------------------- публичное API --------------------------- */

  get running() {
    return this._running;
  }

  get paused() {
    return this._paused;
  }

  get pending() {
    return this._pending;
  }

  refreshSettings() {
    this.settings = mergeSettings(this.db.getSettingsMap(), this.config);
    return this.settings;
  }

  async run({ mode = 'search', query = null } = {}) {
    if (this._running) throw new Error('Бот уже запущен');

    this._running = true;
    this._stopRequested = false;
    this._paused = false;
    this.mode = mode === 'feed' ? 'feed' : 'search';
    this.query = this.mode === 'search' ? String(query || '').trim() : null;
    this.startedAt = Date.now();
    this.stats = { videos: 0, comments: 0, skipped: 0, failed: 0 };
    this.hourly = { count: 0, windowStart: Date.now() };
    this.refreshSettings();

    let endReason = 'finished';

    try {
      this.emit('session:start', { mode: this.mode, query: this.query });
      this.#action('🔌 Подключаюсь к Chrome…');
      await this.browser.connect();

      this.#action('🔐 Проверяю авторизацию в TikTok…');
      if (!(await this.browser.checkLogin())) {
        throw new Error('Chrome не авторизован в TikTok. Войди в аккаунт в том окне Chrome и запусти снова.');
      }
      this.#action('✅ Авторизация в TikTok в порядке');

      this.sessionId = this.db.createSession({ mode: this.mode, query: this.query });

      this.#action(this.mode === 'search' ? `🔍 Ищу: «${this.query}»` : '📱 Листаю ленту «Для тебя»');

      const iterator =
        this.mode === 'feed' ? this.browser.scrollFeed() : this.browser.scrollSearch(this.query);

      while (!this._stopRequested) {
        await this.#waitWhilePaused();
        if (this._stopRequested) break;

        if (this.#sessionExpired()) {
          this.#action('⏰ Достигнут лимит времени сессии');
          endReason = 'timeout';
          break;
        }

        const { value: video, done } = await iterator.next();
        if (done) {
          this.#action('⏹️ Видео закончились');
          endReason = 'exhausted';
          break;
        }
        if (!video || this._stopRequested) continue;

        try {
          await this.#handleVideo(video);
        } catch (error) {
          if (error instanceof StopError || this._stopRequested) break;
          this.stats.failed += 1;
          this.logger?.warn?.(`Видео пропущено из-за ошибки: ${error.message}`);
          this.#action(`⚠️ Видео пропущено: ${error.message}`);
        }

        if (this.sessionId) this.db.updateSession(this.sessionId, this.stats);
        await this.#waitBetweenVideos();
      }

      if (this._stopRequested && endReason === 'finished') endReason = 'stopped';
    } catch (error) {
      if (error instanceof StopError || this._stopRequested) {
        endReason = 'stopped';
      } else {
        this.logger?.error?.(`Ошибка бота: ${error.message}`);
        this.#emitError(error);
        this.#action(`❌ Ошибка: ${error.message}`);
        endReason = 'error';
      }
    } finally {
      await this.#cleanup(endReason);
    }
  }

  async stop(reason = 'stopped') {
    this._stopRequested = true;
    this._paused = false;
    this.#rejectPending('reject');

    for (const waiter of this._sleepers) {
      clearTimeout(waiter.timer);
      waiter.reject(new StopError());
    }
    this._sleepers.clear();

    this.#action('⏹️ Останавливаюсь…');
    this.stopReason = reason;
    return true;
  }

  pause() {
    if (!this._running) return false;
    this._paused = true;
    this.#action('⏸️ Пауза');
    return true;
  }

  resume() {
    if (!this._running) return false;
    this._paused = false;
    this.#action('▶️ Продолжаю');
    return true;
  }

  confirmCaptcha() {
    this._forceCaptchaDone = true;
    return true;
  }

  decidePending(id, decision) {
    if (!this._pending || this._pending.id !== id) return false;
    this._pending.decide(decision);
    return true;
  }

  getState() {
    return {
      running: this._running,
      paused: this._paused,
      mode: this.mode,
      query: this.query,
      stats: { ...this.stats },
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      captcha: Boolean(this.browser?.getCaptchaStatus?.()),
      pending: this._pending
        ? {
            id: this._pending.id,
            text: this._pending.text,
            author: this._pending.video?.author,
            confidence: this._pending.confidence,
            expiresAt: this._pending.expiresAt,
          }
        : null,
      startedAt: this.startedAt,
      sessionId: this.sessionId,
      settings: { ...this.settings },
    };
  }

  /* --------------------------- обработка видео -------------------------- */

  async #handleVideo(video) {
    if (this.db.isVideoProcessed(video.id)) {
      this.stats.skipped += 1;
      this.#action(`⏭️ Уже обрабатывалось: @${video.author}`);
      return;
    }

    const videoId = this.db.saveVideo(video);
    this.stats.videos += 1;
    this.#action(`📹 №${this.stats.videos} @${video.author}: ${shorten(video.description, 70)}`);

    if (await this.browser.checkForCaptcha()) {
      await this.#handleCaptcha();
      if (this._stopRequested) return;
    }

    await this.#simulateWatching();

    const details = await this.browser.getVideoDetails();
    this.emit('video', { video, details, tracked: this.stats.videos });

    const comments = await this.browser.getComments(30);
    const analysis = await this.ai.analyze({ video, comments, details });
    if (!analysis) {
      this.#action('⚠️ AI не смог проанализировать видео — пропускаю');
      return;
    }

    this.db.updateVideoRelevance(videoId, analysis);
    this.#action(
      `📈 Релевантность ${(analysis.score * 100).toFixed(0)}% · ${analysis.category}` +
        (analysis.relevant ? '' : ' · не подходит'),
    );

    if (!analysis.relevant || analysis.score < Number(this.settings.min_relevance_score)) {
      this.stats.skipped += 1;
      return;
    }

    await this.#respectHourlyLimit();
    if (this._stopRequested) return;

    this.#action('✍️ Готовлю комментарий…');
    const generated = await this.ai.generateComment({ video, analysis, comments });
    if (!generated) {
      this.stats.skipped += 1;
      this.#action('🤐 Безопасный комментарий не получился — пропускаю');
      return;
    }

    if (this.db.hasCommentText(generated.comment)) {
      this.stats.skipped += 1;
      this.#action('♻️ Похожий комментарий уже публиковался');
      return;
    }

    const decision = await this.#requestApproval({
      video,
      text: generated.comment,
      confidence: generated.confidence,
      reasoning: generated.reasoning,
    });

    if (decision !== 'approve' || this._stopRequested) {
      this.stats.skipped += 1;
      this.#action(decision === 'timeout' ? '⌛️ Подтверждение не пришло — пропуск' : '🚫 Комментарий отклонён');
      return;
    }

    this.#action('📤 Публикую комментарий…');
    const result = await this.browser.postComment(generated.comment);

    if (!result.ok && result.error === 'captcha') {
      this.db.saveComment(videoId, generated.comment, false);
      this.stats.failed += 1;
      await this.#handleCaptcha();
      return;
    }

    this.db.saveComment(videoId, generated.comment, result.ok);
    if (result.ok) {
      this.stats.comments += 1;
      this.hourly.count += 1;
      this.emit('comment:posted', { video, text: generated.comment, tracked: this.stats.comments });
      this.#action('✅ Комментарий опубликован');
      await this.sleep(Number(this.settings.comment_delay_seconds) * 1000).catch(() => {});
    } else {
      this.stats.failed += 1;
      this.#action(`❌ Комментарий не опубликован: ${result.error}`);
    }
  }

  async #simulateWatching() {
    const watchMs = this.stealth.randomDelay(5000, 15000);
    this.#action(`👀 Смотрю видео ${Math.round(watchMs / 1000)} c…`);
    await this.sleep(watchMs).catch(() => {});
  }

  async #waitBetweenVideos() {
    const min = Number(this.settings.video_delay_min) * 1000;
    const max = Math.max(min, Number(this.settings.video_delay_max) * 1000);
    const delay = this.stealth.randomDelay(min, max);
    await this.#waitWhilePaused();
    if (this._stopRequested) return;
    await this.sleep(delay).catch(() => {});
  }

  async #respectHourlyLimit() {
    const max = Number(this.settings.max_comments_per_hour);
    const hourMs = 3600 * 1000;

    if (Date.now() - this.hourly.windowStart >= hourMs) {
      this.hourly = { count: 0, windowStart: Date.now() };
      return;
    }

    if (this.hourly.count < max) return;

    const waitMs = hourMs - (Date.now() - this.hourly.windowStart);
    this.#action(`⏸️ Лимит ${max} комм./час — пауза ${Math.ceil(waitMs / 60000)} мин`);
    await this.sleep(waitMs).catch(() => {});
    this.hourly = { count: 0, windowStart: Date.now() };
  }

  /* ---------------------------- подтверждение --------------------------- */

  async #requestApproval({ video, text, confidence, reasoning }) {
    if (!this.settings.approval_mode) return 'approve';

    const id = randomUUID();
    const timeoutSeconds = Number(this.settings.approval_timeout_seconds) || 300;

    return new Promise((resolve) => {
      const finish = (decision) => {
        if (this._pending?.id !== id) return;
        clearTimeout(timer);
        this._pending = null;
        this.emit('comment:decided', { id, decision });
        resolve(decision);
      };

      const timer = setTimeout(() => finish('timeout'), timeoutSeconds * 1000);

      this._pending = {
        id,
        video,
        text,
        confidence,
        reasoning,
        expiresAt: Date.now() + timeoutSeconds * 1000,
        decide: finish,
      };

      this.emit('comment:pending', {
        id,
        video,
        text,
        confidence,
        reasoning,
        timeoutSeconds,
      });
    });
  }

  #rejectPending(decision) {
    if (this._pending) this._pending.decide(decision);
  }

  /* ------------------------------- капча -------------------------------- */

  async #handleCaptcha() {
    this.#action('🧩 Капча! Реши её в окне Chrome — я подожду');
    this.emit('captcha', { active: true });
    this._forceCaptchaDone = false;

    while (!this._stopRequested && !this._forceCaptchaDone) {
      if (!(await this.browser.checkForCaptcha())) break;
      await sleep(3000);
    }

    this._forceCaptchaDone = false;
    this.emit('captcha', { active: false });
    if (!this._stopRequested) this.#action('✅ Капча пройдена — продолжаю');
  }

  /* ------------------------------ служебное ----------------------------- */

  #action(text) {
    this.lastAction = text;
    this.lastActionAt = Date.now();
    this.logger?.info?.(text);
    this.emit('action', { text, at: this.lastActionAt });
  }

  #emitError(error) {
    // Событие 'error' у EventEmitter без слушателя роняет процесс — проверяем.
    if (this.listenerCount('error') > 0) {
      this.emit('error', { message: error.message, stack: error.stack });
    }
  }

  #sessionExpired() {
    const limitMs = Number(this.settings.session_max_minutes) * 60 * 1000;
    return this.startedAt !== null && Date.now() - this.startedAt >= limitMs;
  }

  async #waitWhilePaused() {
    while (this._paused && !this._stopRequested) {
      await this.sleep(500).catch(() => {});
    }
  }

  sleep(ms) {
    if (this._stopRequested) return Promise.reject(new StopError());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this._sleepers.delete(waiter);
        resolve();
      }, ms);
      this._sleepers.add(waiter);
    });
  }

  async #cleanup(reason) {
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;

    this.#rejectPending('reject');
    await this.browser.disconnect().catch(() => {});

    if (this.sessionId) {
      this.db.endSession(this.sessionId, reason);
    }

    this._running = false;
    this._paused = false;

    this.emit('session:end', {
      reason,
      durationMs,
      stats: { ...this.stats },
      mode: this.mode,
      query: this.query,
    });
  }
}

function shorten(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return 'без описания';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

module.exports = { Bot, StopError };
