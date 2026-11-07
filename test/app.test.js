'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/telegram/app');
const { Database } = require('../src/db');

const ADMIN_ID = 111;
const STRANGER_ID = 222;

const config = {
  adminIds: [ADMIN_ID],
  statusUpdateSeconds: 15,
  minRelevanceScore: 0.7,
  commentDelaySeconds: 30,
  maxCommentsPerHour: 20,
  videoDelayMin: 3,
  videoDelayMax: 8,
  sessionMaxMinutes: 120,
  approvalMode: true,
  approvalTimeoutSeconds: 300,
  commentLanguage: 'ru',
  openaiModel: 'gpt-4o-mini',
};

function createFakeClient() {
  const calls = [];
  return {
    calls,
    messages: () => calls.filter((call) => call.method === 'sendMessage'),
    lastText: () => calls.filter((call) => call.method === 'sendMessage').at(-1)?.params.text,
    sendMessage: async (chatId, text, extra = {}) => {
      calls.push({ method: 'sendMessage', params: { chat_id: chatId, text, ...extra } });
      return { message_id: calls.length };
    },
    editMessageText: async (chatId, messageId, text, extra = {}) => {
      calls.push({ method: 'editMessageText', params: { chat_id: chatId, message_id: messageId, text, ...extra } });
      return true;
    },
    editMessageReplyMarkup: async (chatId, messageId, markup) => {
      calls.push({ method: 'editMessageReplyMarkup', params: { chat_id: chatId, message_id: messageId, markup } });
      return true;
    },
    answerCallbackQuery: async (id, text, { showAlert = false } = {}) => {
      calls.push({ method: 'answerCallbackQuery', params: { id, text, show_alert: showAlert } });
      return true;
    },
    deleteMessage: async () => true,
    sendChatAction: async () => true,
    setMyCommands: async (commands) => {
      calls.push({ method: 'setMyCommands', params: { commands } });
      return true;
    },
    getMe: async () => ({ id: 1, username: 'test_bot' }),
  };
}

function makeApp() {
  const client = createFakeClient();
  const db = new Database(':memory:');
  const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };
  const app = createApp({ config, db, logger: silentLogger, client });
  return { app, client, db };
}

const messageUpdate = (text, userId = ADMIN_ID) => ({
  update_id: 1,
  message: { message_id: 1, text, from: { id: userId, username: 'admin' }, chat: { id: userId } },
});

test('посторонний пользователь получает отказ и свой id', async () => {
  const { app, client } = makeApp();
  await app.handleUpdate(messageUpdate('/start', STRANGER_ID));

  const text = client.lastText();
  assert.match(text, /Доступ только для администратора/);
  assert.match(text, /222/);
});

test('/start показывает меню с кнопками', async () => {
  const { app, client } = makeApp();
  await app.handleUpdate(messageUpdate('/start'));

  const message = client.messages().at(-1);
  assert.match(message.params.text, /ttcomm/);
  assert.ok(Array.isArray(message.params.reply_markup.inline_keyboard));
});

test('/id возвращает id администратора', async () => {
  const { app, client } = makeApp();
  await app.handleUpdate(messageUpdate('/id'));
  assert.match(client.lastText(), new RegExp(String(ADMIN_ID)));
});

test('обычный текст не запускает бота и приводит к подсказке', async () => {
  const { app, client, db } = makeApp();
  await app.handleUpdate(messageUpdate('привет, бот'));
  assert.match(client.lastText(), /не команда/);
  assert.equal(db.getStats().total_sessions, 0);
});

test('/search без аргумента не создаёт сессию', async () => {
  const { app, client, db } = makeApp();
  await app.handleUpdate(messageUpdate('/search'));
  assert.match(client.lastText(), /Формат/);
  assert.equal(db.getStats().total_sessions, 0);
});

test('/set сохраняет настройку, /settings её показывает', async () => {
  const { app, client, db } = makeApp();
  await app.handleUpdate(messageUpdate('/set min_relevance_score 0.9'));
  assert.match(client.lastText(), /0\.9/);
  assert.equal(db.getSetting('min_relevance_score'), '0.9');

  await app.handleUpdate(messageUpdate('/settings'));
  assert.match(client.lastText(), /0\.9/);
});

test('/set отклоняет некорректное значение', async () => {
  const { app, client, db } = makeApp();
  await app.handleUpdate(messageUpdate('/set min_relevance_score 5'));
  assert.match(client.lastText(), /Диапазон|диапазон/);
  assert.equal(db.getSetting('min_relevance_score'), undefined);
});

test('/set для неизвестного ключа перечисляет доступные', async () => {
  const { app, client } = makeApp();
  await app.handleUpdate(messageUpdate('/set nope 1'));
  assert.match(client.lastText(), /Неизвестная настройка/);
});

test('/reset all сбрасывает настройки', async () => {
  const { app, client, db } = makeApp();
  db.setSetting('approval_mode', '0');
  await app.handleUpdate(messageUpdate('/reset all'));
  assert.match(client.lastText(), /сброшены/);
  assert.equal(db.getSetting('approval_mode'), undefined);
});

test('/stats и /videos работают на пустой базе', async () => {
  const { app, client } = makeApp();
  await app.handleUpdate(messageUpdate('/stats'));
  assert.match(client.lastText(), /Статистика/);

  await app.handleUpdate(messageUpdate('/videos'));
  assert.match(client.lastText(), /ни одного видео/);
});

test('callback от постороннего получает alert, от админа — обрабатывается', async () => {
  const { app, client } = makeApp();

  await app.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'cb1',
      data: 'cb:stats',
      from: { id: STRANGER_ID },
      message: { message_id: 10, chat: { id: STRANGER_ID } },
    },
  });
  const denied = client.calls.find((call) => call.method === 'answerCallbackQuery');
  assert.equal(denied.params.show_alert, true);

  await app.handleUpdate({
    update_id: 3,
    callback_query: {
      id: 'cb2',
      data: 'cb:stats',
      from: { id: ADMIN_ID },
      message: { message_id: 11, chat: { id: ADMIN_ID } },
    },
  });
  assert.match(client.lastText(), /Статистика/);
});

test('bootstrap регистрирует команды в меню Telegram', async () => {
  const { app, client } = makeApp();
  await app.bootstrap();
  const call = client.calls.find((item) => item.method === 'setMyCommands');
  assert.ok(call);
  assert.ok(call.params.commands.some((command) => command.command === 'search'));
});
