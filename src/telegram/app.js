'use strict';

const { Bot } = require('../bot');
const BrowserManager = require('../browser');
const StealthFeatures = require('../stealth');
const { AI } = require('../ai');
const { Notifier } = require('../notifier');
const fmt = require('./format');
const { parseCommand, parseLimit, parseSetArgs, helpText } = require('./commands');
const { SETTINGS, validateSetting, mergeSettings } = require('../settings');

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📊 Статус', callback_data: 'cb:status' },
        { text: '📈 Статистика', callback_data: 'cb:stats' },
      ],
      [
        { text: '⚙️ Настройки', callback_data: 'cb:settings' },
        { text: '🎬 Видео', callback_data: 'cb:videos' },
      ],
      [
        { text: '💬 Комментарии', callback_data: 'cb:comments' },
        { text: '❓ Помощь', callback_data: 'cb:help' },
      ],
    ],
  },
};

const STOP_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '⏸ Пауза', callback_data: 'cb:pause' },
        { text: '⏹ Стоп', callback_data: 'cb:stop' },
      ],
      [
        { text: '📊 Статус', callback_data: 'cb:status' },
        { text: '⚙️ Настройки', callback_data: 'cb:settings' },
      ],
    ],
  },
};

function createApp({ config, db, logger, client }) {
  let activeBot = null;
  let notifier = null;

  const isAdmin = (userId) => config.adminIds.includes(Number(userId));
  const send = (chatId, text, extra = {}) => client.sendMessage(chatId, text, extra);

  async function handleUpdate(update) {
    if (update.message?.text) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
    return undefined;
  }

  /* ------------------------------ команды ------------------------------ */

  async function handleMessage(message) {
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = String(message.text || '').trim();

    if (!isAdmin(userId)) {
      logger.warn(`Отказ в доступе: user ${userId} (@${message.from?.username || '—'})`);
      await send(
        chatId,
        `⛔️ Доступ только для администратора.\n\nТвой Telegram ID: <code>${userId}</code>\n` +
          'Добавь его в TELEGRAM_ADMIN_IDS в .env и перезапусти бота.',
      );
      return;
    }

    const command = parseCommand(text);
    if (!command) {
      const hint = text.startsWith('/')
        ? 'Неизвестная команда. Нажми /start или /help.'
        : 'Это не команда — бот не реагирует на обычный текст, чтобы не запуститься случайно. Нажми /start.';
      await send(chatId, hint, MENU_KEYBOARD);
      return;
    }

    logger.info(`Команда /${command.name} ${command.args}`.trim());

    switch (command.name) {
      case 'start':
        await send(
          chatId,
          [
            '<b>🤖 ttcomm — бот TikTok с управлением из Telegram</b>',
            '',
            'Всё управление здесь: запуск, стоп, статистика, настройки.',
            'Начни с поиска: <code>/search удалённая работа</code>',
            'или листай ленту: /feed',
          ].join('\n'),
          MENU_KEYBOARD,
        );
        return;

      case 'help':
        await send(chatId, helpText(), MENU_KEYBOARD);
        return;

      case 'status':
        await sendStatus(chatId);
        return;

      case 'stats':
        await sendStats(chatId);
        return;

      case 'settings':
        await sendSettings(chatId);
        return;

      case 'videos':
        await sendVideos(chatId, parseLimit(command.args, { fallback: 10, max: 20 }));
        return;

      case 'comments':
        await sendComments(chatId, parseLimit(command.args, { fallback: 10, max: 20 }));
        return;

      case 'search':
        if (!command.args) {
          await send(chatId, 'Формат: <code>/search запрос</code>, например <code>/search remote jobs</code>');
          return;
        }
        await startSession(chatId, { mode: 'search', query: command.args });
        return;

      case 'feed':
        await startSession(chatId, { mode: 'feed', query: null });
        return;

      case 'stop':
        await stopSession(chatId);
        return;

      case 'pause':
        if (!activeBot?.running) return send(chatId, 'Бот не запущен.');
        activeBot.pause();
        return send(chatId, '⏸ Пауза. Продолжить: /resume');

      case 'resume':
        if (!activeBot?.running) return send(chatId, 'Бот не запущен.');
        activeBot.resume();
        return send(chatId, '▶️ Продолжаю работу.');

      case 'captcha':
        if (!activeBot?.running) return send(chatId, 'Бот не запущен.');
        activeBot.confirmCaptcha();
        return send(chatId, '▶️ Отметил капчу как решённую.');

      case 'set':
        return handleSet(chatId, command.args);

      case 'reset':
        return handleReset(chatId, command.args);

      case 'id':
        return send(chatId, `Твой Telegram ID: <code>${userId}</code>`);

      default:
        return send(chatId, 'Неизвестная команда.', MENU_KEYBOARD);
    }
  }

  /* ----------------------------- callbacks ----------------------------- */

  async function handleCallback(query) {
    const userId = query.from?.id;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = String(query.data || '');

    if (!isAdmin(userId)) {
      await client.answerCallbackQuery(query.id, 'Нет доступа', { showAlert: true });
      return;
    }

    if (data.startsWith('ap:') || data.startsWith('rj:')) {
      const decision = data.startsWith('ap:') ? 'approve' : 'reject';
      const id = data.slice(3);
      const accepted = activeBot?.decidePending(id, decision) ?? false;

      await client
        .editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] })
        .catch(() => {});
      await client.answerCallbackQuery(
        query.id,
        accepted
          ? decision === 'approve'
            ? '✅ Отправляю комментарий'
            : '🚫 Пропускаю'
          : 'Уже неактуально',
      );
      return;
    }

    await client.answerCallbackQuery(query.id);

    switch (data) {
      case 'cb:status':
        return sendStatus(chatId);
      case 'cb:stats':
        return sendStats(chatId);
      case 'cb:settings':
        return sendSettings(chatId);
      case 'cb:videos':
        return sendVideos(chatId, 10);
      case 'cb:comments':
        return sendComments(chatId, 10);
      case 'cb:help':
        return send(chatId, helpText(), MENU_KEYBOARD);
      case 'cb:stop':
        return stopSession(chatId);
      case 'cb:pause':
        if (!activeBot?.running) return send(chatId, 'Бот не запущен.');
        activeBot.pause();
        return send(chatId, '⏸ Пауза.');
      case 'cb:resume':
        if (!activeBot?.running) return send(chatId, 'Бот не запущен.');
        activeBot.resume();
        return send(chatId, '▶️ Продолжаю.');
      case 'cb:captcha_done':
        if (!activeBot?.running) return send(chatId, 'Бот не запущен.');
        activeBot.confirmCaptcha();
        return send(chatId, '▶️ Продолжаю после капчи.');
      default:
        return undefined;
    }
  }

  /* ----------------------------- действия ------------------------------ */

  async function startSession(chatId, { mode, query }) {
    if (activeBot?.running) {
      await send(chatId, '⚠️ Бот уже запущен. Сначала /stop.', STOP_KEYBOARD);
      return;
    }

    const stealth = new StealthFeatures(config);
    const bot = new Bot({
      config,
      db,
      ai: new AI(config, logger),
      browser: new BrowserManager(config, stealth, logger),
      stealth,
      logger,
    });

    activeBot = bot;
    notifier = new Notifier({ client, chatIds: config.adminIds, config, logger });
    notifier.attach(bot);

    await send(chatId, '🚀 Запускаю…', STOP_KEYBOARD);

    bot
      .run({ mode, query })
      .catch((error) => logger.error(`bot.run: ${error.stack || error.message}`))
      .finally(() => {
        notifier?.detach();
        notifier = null;
        activeBot = null;
      });
  }

  async function stopSession(chatId) {
    if (!activeBot?.running) {
      await send(chatId, 'Бот и так не запущен.');
      return;
    }
    await activeBot.stop('manual');
    await send(chatId, '⏹ Останавливаю. Итоги пришлю после завершения.');
  }

  /* --------------------------- информация ------------------------------ */

  async function sendStatus(chatId) {
    if (!activeBot) {
      await send(chatId, fmt.statusText({ running: false, lastAction: 'Бот не запущен' }), MENU_KEYBOARD);
      return;
    }
    await send(chatId, fmt.statusText(activeBot.getState()), STOP_KEYBOARD);
  }

  async function sendStats(chatId) {
    await send(chatId, fmt.statsText(db.getStats()));
  }

  async function sendSettings(chatId) {
    const state = activeBot?.getState();
    const settings = state?.settings || dbSettingsSnapshot();
    await send(chatId, fmt.settingsText(settings));
  }

  function dbSettingsSnapshot() {
    return mergeSettings(db.getSettingsMap(), config);
  }

  async function sendVideos(chatId, limit) {
    await send(chatId, fmt.videosText(db.getRecentVideos(limit)));
  }

  async function sendComments(chatId, limit) {
    await send(chatId, fmt.commentsText(db.getRecentComments(limit)));
  }

  /* ---------------------------- настройки ------------------------------ */

  async function handleSet(chatId, args) {
    const parsed = parseSetArgs(args);
    if (parsed.error) return send(chatId, escaped(parsed.error));

    if (!SETTINGS[parsed.key]) {
      return send(
        chatId,
        `Неизвестная настройка <code>${escaped(parsed.key)}</code>.\n\nДоступные:\n` +
          Object.keys(SETTINGS)
            .map((key) => `<code>${key}</code> — ${SETTINGS[key].label}`)
            .join('\n'),
      );
    }

    const check = validateSetting(parsed.key, parsed.rawValue);
    if (!check.ok) {
      return send(chatId, `❌ ${escaped(check.error)}\n\n${escaped(SETTINGS[parsed.key].description)}`);
    }

    db.setSetting(parsed.key, check.value);
    activeBot?.refreshSettings();

    const settings = activeBot?.getState().settings || dbSettingsSnapshot();
    await send(
      chatId,
      `✅ <code>${parsed.key}</code> = <b>${escaped(fmtValue(parsed.key, settings))}</b>` +
        (activeBot?.running ? '\nПрименено к текущей сессии.' : ''),
    );
  }

  async function handleReset(chatId, args) {
    const key = String(args || '').trim().toLowerCase();

    if (key === 'all') {
      for (const settingKey of Object.keys(SETTINGS)) db.deleteSetting(settingKey);
      activeBot?.refreshSettings();
      return send(chatId, '✅ Все настройки сброшены к значениям из .env');
    }

    if (!SETTINGS[key]) return send(chatId, 'Формат: <code>/reset ключ</code> или <code>/reset all</code>');

    db.deleteSetting(key);
    activeBot?.refreshSettings();
    const settings = activeBot?.getState().settings || dbSettingsSnapshot();
    return send(chatId, `♻️ <code>${key}</code> = <b>${escaped(fmtValue(key, settings))}</b>`);
  }

  /* ---------------------------- служебное ------------------------------ */

  async function bootstrap() {
    try {
      const me = await client.getMe();
      logger.info(`Telegram: @${me.username} (id ${me.id}), админов: ${config.adminIds.length}`);
    } catch (error) {
      logger.error(`getMe: ${error.message}`);
    }

    try {
      await client.setMyCommands([
        { command: 'start', description: 'Главное меню' },
        { command: 'status', description: 'Статус бота' },
        { command: 'search', description: 'Запустить поиск' },
        { command: 'feed', description: 'Запустить ленту' },
        { command: 'stop', description: 'Остановить' },
        { command: 'stats', description: 'Статистика' },
        { command: 'settings', description: 'Настройки' },
        { command: 'help', description: 'Справка' },
      ]);
    } catch (error) {
      logger.warn(`setMyCommands: ${error.message}`);
    }
  }

  function escaped(value) {
    return fmt.escapeHtml(value);
  }

  function fmtValue(key, settings) {
    const value = settings[key];
    if (typeof value === 'boolean') return value ? 'вкл' : 'выкл';
    return String(value);
  }

  function getActiveBot() {
    return activeBot;
  }

  return { handleUpdate, bootstrap, getActiveBot };
}

module.exports = { createApp, MENU_KEYBOARD };
