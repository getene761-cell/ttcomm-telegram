'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { Notifier } = require('../src/notifier');

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClient() {
  const calls = [];
  return {
    calls,
    sendMessage: async (chatId, text, extra = {}) => {
      calls.push({ method: 'sendMessage', chatId, text, extra });
      return { message_id: calls.length };
    },
    editMessageText: async (chatId, messageId, text, extra = {}) => {
      calls.push({ method: 'editMessageText', chatId, messageId, text, extra });
      return true;
    },
  };
}

function fakeBot() {
  const bot = new EventEmitter();
  const state = {
    running: true,
    paused: false,
    mode: 'search',
    query: 'remote work',
    stats: { videos: 1, comments: 0, skipped: 0, failed: 0 },
    lastAction: 'Смотрю видео',
    lastActionAt: Date.now(),
    captcha: false,
    pending: null,
    startedAt: Date.now(),
    settings: {},
  };
  bot.getState = () => state;
  return bot;
}

const config = { statusUpdateSeconds: 0 };

test('старт сессии создаёт живой статус, /stop-финал редактирует его', async () => {
  const client = fakeClient();
  const notifier = new Notifier({ client, chatIds: [111], config, logger: null });
  const bot = fakeBot();
  notifier.attach(bot);

  bot.emit('session:start', { mode: 'search', query: 'remote work' });
  await wait();
  assert.ok(client.calls.some((call) => call.method === 'sendMessage' && /Сессия запущена/.test(call.text)));

  const live = client.calls.find((call) => call.method === 'sendMessage' && /Бот/.test(call.text));
  assert.ok(live);

  bot.emit('session:end', {
    reason: 'stopped',
    durationMs: 65_000,
    stats: { videos: 3, comments: 1, skipped: 2, failed: 0 },
  });
  await wait();

  const edit = client.calls.find((call) => call.method === 'editMessageText');
  assert.ok(edit);
  assert.match(edit.text, /Сессия завершена/);
  assert.match(edit.text, /1 мин 5 с/);

  notifier.detach();
  assert.equal(bot.listenerCount('session:start'), 0);
});

test('ожидающий комментарий приходит с кнопками подтверждения', async () => {
  const client = fakeClient();
  const notifier = new Notifier({ client, chatIds: [111, 222], config, logger: null });
  const bot = fakeBot();
  notifier.attach(bot);

  bot.emit('comment:pending', {
    id: 'uuid-1',
    text: 'Полезный комментарий',
    confidence: 0.8,
    timeoutSeconds: 120,
    video: { author: 'bob', description: 'career', url: 'https://tiktok.com/@bob/video/1' },
  });
  await wait();

  const messages = client.calls.filter((call) => call.method === 'sendMessage');
  assert.equal(messages.length, 2);
  const keyboard = messages[0].extra.reply_markup.inline_keyboard[0];
  assert.equal(keyboard[0].callback_data, 'ap:uuid-1');
  assert.equal(keyboard[1].callback_data, 'rj:uuid-1');

  notifier.detach();
});

test('капча и ошибки уходят отдельными сообщениями', async () => {
  const client = fakeClient();
  const notifier = new Notifier({ client, chatIds: [111], config, logger: null });
  const bot = fakeBot();
  notifier.attach(bot);

  bot.emit('captcha', { active: true });
  bot.emit('error', { message: 'Chrome отвалился' });
  await wait();

  const texts = client.calls.filter((call) => call.method === 'sendMessage').map((call) => call.text);
  assert.ok(texts.some((text) => /Капча/.test(text)));
  assert.ok(texts.some((text) => /Chrome отвалился/.test(text)));

  notifier.detach();
});
