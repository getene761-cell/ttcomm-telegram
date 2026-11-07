'use strict';

/**
 * Разбор команд и справка. Чистые функции без сети и БД.
 */

const COMMANDS = Object.freeze([
  { name: 'start', usage: '', description: 'Главное меню' },
  { name: 'help', usage: '', description: 'Список команд' },
  { name: 'status', usage: '', description: 'Что делает бот сейчас' },
  { name: 'search', usage: '<запрос>', description: 'Запустить поиск по запросу' },
  { name: 'feed', usage: '', description: 'Запустить листание ленты' },
  { name: 'stop', usage: '', description: 'Остановить бота' },
  { name: 'pause', usage: '', description: 'Пауза' },
  { name: 'resume', usage: '', description: 'Продолжить после паузы' },
  { name: 'stats', usage: '', description: 'Статистика за всё время' },
  { name: 'videos', usage: '[n]', description: 'Последние видео' },
  { name: 'comments', usage: '[n]', description: 'Последние комментарии' },
  { name: 'settings', usage: '', description: 'Текущие настройки' },
  { name: 'set', usage: '<ключ> <значение>', description: 'Изменить настройку' },
  { name: 'reset', usage: '<ключ|all>', description: 'Вернуть настройку к значению из .env' },
  { name: 'captcha', usage: '', description: 'Подтвердить, что капча решена' },
  { name: 'id', usage: '', description: 'Показать твой Telegram ID' },
]);

const COMMAND_NAMES = new Set(COMMANDS.map((command) => command.name));

const MENU = [
  ['status', '📊 Статус'],
  ['stats', '📈 Статистика'],
  ['settings', '⚙️ Настройки'],
  ['videos', '🎬 Видео'],
  ['comments', '💬 Комментарии'],
];

/**
 * '/search@my_bot remote jobs' -> { name: 'search', args: 'remote jobs' }
 * @returns {{name: string, args: string} | null}
 */
function parseCommand(text) {
  const value = String(text ?? '').trim();
  const match = value.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!COMMAND_NAMES.has(name)) return null;
  return { name, args: (match[2] || '').trim() };
}

function parseLimit(raw, { fallback = 10, max = 25 } = {}) {
  const value = Number.parseInt(String(raw || '').trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

/**
 * 'min_relevance_score 0.8' -> { key: 'min_relevance_score', rawValue: '0.8' }
 */
function parseSetArgs(args) {
  const text = String(args || '').trim();
  if (!text) return { error: 'Формат: /set ключ значение' };
  const [key, ...rest] = text.split(/\s+/);
  const rawValue = rest.join(' ').trim();
  if (!rawValue) return { error: 'Не хватает значения. Формат: /set ключ значение' };
  return { key: key.toLowerCase(), rawValue };
}

function helpText() {
  const lines = ['<b>🤖 ttcomm — управление через Telegram</b>', ''];
  for (const command of COMMANDS) {
    const usage = command.usage ? ` ${command.usage}` : '';
    lines.push(`/${command.name}${usage} — ${command.description}`);
  }
  lines.push('');
  lines.push('Настройки хранятся в SQLite и перекрывают .env.');
  lines.push('Все действия доступны только администраторам из TELEGRAM_ADMIN_IDS.');
  return lines.join('\n');
}

module.exports = {
  COMMANDS,
  COMMAND_NAMES,
  MENU,
  parseCommand,
  parseLimit,
  parseSetArgs,
  helpText,
};
