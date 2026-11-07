'use strict';

/**
 * Минимальный клиент Telegram Bot API (long polling) на нативном fetch.
 * Без сторонних библиотек — только методы, которые реально используются.
 */

class TelegramError extends Error {
  constructor(message, { method, code, description } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.description = description;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TelegramClient {
  constructor(token, { logger, apiBase = 'https://api.telegram.org' } = {}) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.logger = logger;
  }

  get url() {
    return `${this.apiBase}/bot${this.token}`;
  }

  async call(method, params = {}, { timeoutMs = 40000 } = {}) {
    let lastError;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${this.url}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const data = await response.json().catch(() => null);

        if (response.ok && data?.ok) return data.result;

        const description = data?.description || `HTTP ${response.status}`;

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = data?.parameters?.retry_after ?? 2 ** attempt;
          lastError = new TelegramError(`Telegram ${method}: ${description}`, {
            method,
            code: response.status,
            description,
          });
          this.logger?.warn?.(`Telegram ${method} ${response.status}, повтор через ${retryAfter}s`);
          await sleep(Number(retryAfter) * 1000);
          continue;
        }

        throw new TelegramError(`Telegram ${method}: ${description}`, {
          method,
          code: response.status,
          description,
        });
      } catch (error) {
        if (error instanceof TelegramError) throw error;
        lastError = error;
        if (attempt < 2) await sleep(1000 * 2 ** attempt);
      }
    }

    throw lastError instanceof TelegramError
      ? lastError
      : new TelegramError(`Telegram ${method} недоступен: ${lastError?.message}`, { method });
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup = { inline_keyboard: [] }) {
    return this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  answerCallbackQuery(callbackQueryId, text, { showAlert = false } = {}) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || undefined,
      show_alert: showAlert,
    });
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  getMe() {
    return this.call('getMe');
  }

  /**
   * Бесконечный long polling. Ошибки не убивают цикл.
   */
  async startPolling({ onUpdate, signal, allowedUpdates = ['message', 'callback_query'] }) {
    let offset = 0;
    let backoff = 1000;

    while (!signal?.aborted) {
      try {
        const updates = await this.call(
          'getUpdates',
          { offset, timeout: 30, allowed_updates: allowedUpdates },
          { timeoutMs: 45000 },
        );

        backoff = 1000;
        for (const update of updates || []) {
          offset = update.update_id + 1;
          try {
            await onUpdate(update);
          } catch (error) {
            this.logger?.error?.(`Ошибка обработки апдейта: ${error.stack || error.message}`);
          }
        }
      } catch (error) {
        if (signal?.aborted) break;
        this.logger?.warn?.(`Long polling: ${error.message}; повтор через ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
}

module.exports = { TelegramClient, TelegramError };
