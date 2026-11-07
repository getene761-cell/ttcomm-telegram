'use strict';

const fmt = require('./telegram/format');

/**
 * Мост «события бота -> сообщения в Telegram».
 * Живой статус редактируется не чаще раза в STATUS_UPDATE_SECONDS,
 * важные события (комментарий, капча, ошибка, конец сессии) приходят сразу.
 */
class Notifier {
  constructor({ client, chatIds, config, logger }) {
    this.client = client;
    this.chatIds = chatIds;
    this.config = config;
    this.logger = logger;

    this.bot = null;
    this.handlers = new Map();
    this.liveMessages = new Map();
    this.lastEditAt = 0;
    this.timer = null;
    this.editing = false;
    this.closed = false;
  }

  attach(bot) {
    this.bot = bot;
    this.closed = false;

    const register = (event, handler) => {
      const bound = (payload) => {
        Promise.resolve(handler.call(this, payload)).catch((error) => {
          this.logger?.warn?.(`Notifier ${event}: ${error.message}`);
        });
      };
      this.handlers.set(event, bound);
      bot.on(event, bound);
    };

    register('session:start', this.#onStart);
    register('action', this.#onAction);
    register('comment:pending', this.#onPending);
    register('comment:posted', this.#onPosted);
    register('captcha', this.#onCaptcha);
    register('error', this.#onError);
    register('session:end', this.#onEnd);
  }

  detach() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.bot) {
      for (const [event, handler] of this.handlers) this.bot.off(event, handler);
    }
    this.handlers.clear();
    this.bot = null;
  }

  async #broadcast(text, extra = {}) {
    await Promise.all(
      this.chatIds.map((chatId) =>
        this.client.sendMessage(chatId, text, extra).catch((error) => {
          this.logger?.warn?.(`Не удалось отправить сообщение ${chatId}: ${error.message}`);
        }),
      ),
    );
  }

  async #onStart(event) {
    for (const chatId of this.chatIds) {
      try {
        const message = await this.client.sendMessage(
          chatId,
          `<b>🚀 Сессия запущена</b>\nРежим: ${fmt.modeLabel(event.mode, event.query)}`,
          this.#keyboard([['status', '📊 Статус'], ['stop', '⏹ Стоп']]),
        );
        const status = await this.client.sendMessage(chatId, fmt.statusText(this.bot.getState()));
        this.liveMessages.set(chatId, status.message_id);
      } catch (error) {
        this.logger?.warn?.(`Не удалось создать статус-сообщение: ${error.message}`);
      }
    }
    this.lastEditAt = Date.now();
  }

  async #onAction() {
    this.#scheduleStatus();
  }

  #scheduleStatus() {
    if (this.closed) return;
    const minInterval = Number(this.config.statusUpdateSeconds) * 1000;
    const elapsed = Date.now() - this.lastEditAt;

    if (elapsed >= minInterval) {
      this.#refreshStatus().catch(() => {});
      return;
    }

    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#refreshStatus().catch(() => {});
    }, minInterval - elapsed);
  }

  async #refreshStatus() {
    if (this.closed || this.editing || this.liveMessages.size === 0) return;
    this.editing = true;
    this.lastEditAt = Date.now();

    const text = fmt.statusText(this.bot.getState());
    for (const [chatId, messageId] of this.liveMessages) {
      try {
        await this.client.editMessageText(chatId, messageId, text);
      } catch (error) {
        if (String(error.message).includes('message is not modified')) continue;
        this.logger?.debug?.(`Статус не обновился: ${error.message}`);
      }
    }

    this.editing = false;
  }

  async #onPending(pending) {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Отправить', callback_data: `ap:${pending.id}` },
            { text: '🚫 Пропустить', callback_data: `rj:${pending.id}` },
          ],
        ],
      },
    };
    await this.#broadcast(fmt.pendingText(pending), keyboard);
  }

  async #onPosted(event) {
    await this.#broadcast(fmt.commentPostedText(event));
  }

  async #onCaptcha(event) {
    if (!event.active) return;
    await this.#broadcast(fmt.captchaText(), {
      reply_markup: {
        inline_keyboard: [[{ text: '▶️ Продолжить', callback_data: 'cb:captcha_done' }]],
      },
    });
  }

  async #onError(event) {
    await this.#broadcast(fmt.errorText(event.message));
  }

  async #onEnd(event) {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const text = fmt.sessionEndText(event);
    let edited = 0;

    for (const [chatId, messageId] of this.liveMessages) {
      try {
        await this.client.editMessageText(chatId, messageId, text, {
          reply_markup: { inline_keyboard: [] },
        });
        edited += 1;
      } catch {
        await this.client.sendMessage(chatId, text).catch(() => {});
      }
    }

    if (edited === 0) {
      await this.#broadcast(text);
    }

    this.liveMessages.clear();
  }

  #keyboard(rows) {
    return {
      reply_markup: {
        inline_keyboard: rows.map(([action, label]) => [{ text: label, callback_data: `cb:${action}` }]),
      },
    };
  }
}

module.exports = { Notifier };
