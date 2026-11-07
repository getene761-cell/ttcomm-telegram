'use strict';

/**
 * Загрузка и валидация конфигурации из переменных окружения.
 *
 * Принцип: всё, что нельзя поменять на лету, живёт в .env;
 * то, что можно крутить из Telegram, — в таблице settings (см. src/settings.js).
 */

class ConfigError extends Error {
  constructor(messages) {
    super(`Некорректная конфигурация:\n- ${messages.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = messages;
  }
}

const DEFAULTS = Object.freeze({
  logLevel: 'info',
  dbPath: './data/bot.db',
  chromeEndpoint: 'http://127.0.0.1:9222',
  chromeWsEndpoint: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  openaiTimeoutMs: 60000,
  targetTopic: 'job search, careers, remote work, productivity',
  commentLanguage: 'ru',
  minRelevanceScore: 0.7,
  commentDelaySeconds: 30,
  maxCommentsPerHour: 20,
  videoDelayMin: 3,
  videoDelayMax: 8,
  sessionMaxMinutes: 120,
  approvalMode: true,
  approvalTimeoutSeconds: 300,
  statusUpdateSeconds: 15,
  maxCommentsPerRun: 200,
});

function readNumber(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError([`${name} должен быть числом, получено: ${JSON.stringify(raw)}`]);
  }
  if (value < min || value > max) {
    throw new ConfigError([`${name} должен быть в диапазоне ${min}..${max}, получено: ${value}`]);
  }
  return value;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'да'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'нет'].includes(normalized)) return false;
  throw new ConfigError([`${name} должен быть true/false, получено: ${JSON.stringify(raw)}`]);
}

function readString(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).trim();
}

function readIdList(env, name) {
  const raw = env[name];
  if (!raw) return [];
  const ids = String(raw)
    .split(/[,\s;]+/)
    .filter(Boolean)
    .map((part) => {
      if (!/^\d+$/.test(part)) {
        throw new ConfigError([`${name}: "${part}" не похоже на Telegram user id (только цифры)`]);
      }
      return Number(part);
    });
  return [...new Set(ids)];
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Readonly<typeof DEFAULTS & {telegramToken: string, adminIds: number[]}>}
 */
function loadConfig(env = process.env) {
  const problems = [];

  let telegramToken = '';
  try {
    telegramToken = readString(env, 'TELEGRAM_BOT_TOKEN', '');
  } catch (error) {
    problems.push(...error.problems);
  }

  let adminIds = [];
  try {
    adminIds = readIdList(env, 'TELEGRAM_ADMIN_IDS');
  } catch (error) {
    problems.push(...error.problems);
  }

  const numeric = {
    minRelevanceScore: ['MIN_RELEVANCE_SCORE', DEFAULTS.minRelevanceScore, { min: 0, max: 1 }],
    commentDelaySeconds: ['COMMENT_DELAY_SECONDS', DEFAULTS.commentDelaySeconds, { min: 0, max: 3600 }],
    maxCommentsPerHour: ['MAX_COMMENTS_PER_HOUR', DEFAULTS.maxCommentsPerHour, { min: 1, max: 60 }],
    videoDelayMin: ['VIDEO_DELAY_MIN', DEFAULTS.videoDelayMin, { min: 1, max: 120 }],
    videoDelayMax: ['VIDEO_DELAY_MAX', DEFAULTS.videoDelayMax, { min: 1, max: 300 }],
    sessionMaxMinutes: ['SESSION_MAX_MINUTES', DEFAULTS.sessionMaxMinutes, { min: 1, max: 720 }],
    approvalTimeoutSeconds: ['APPROVAL_TIMEOUT_SECONDS', DEFAULTS.approvalTimeoutSeconds, { min: 15, max: 3600 }],
    statusUpdateSeconds: ['STATUS_UPDATE_SECONDS', DEFAULTS.statusUpdateSeconds, { min: 3, max: 600 }],
    maxCommentsPerRun: ['MAX_COMMENTS_PER_RUN', DEFAULTS.maxCommentsPerRun, { min: 1, max: 5000 }],
    openaiTimeoutMs: ['OPENAI_TIMEOUT_MS', DEFAULTS.openaiTimeoutMs, { min: 1000, max: 300000 }],
  };

  const config = {
    ...DEFAULTS,
    telegramToken,
    adminIds,
    openaiApiKey: readString(env, 'OPENAI_API_KEY', ''),
  };

  for (const [key, [name, fallback, range]] of Object.entries(numeric)) {
    try {
      config[key] = readNumber(env, name, fallback, range);
    } catch (error) {
      problems.push(...error.problems);
    }
  }

  for (const [key, name, fallback] of [
    ['approvalMode', 'APPROVAL_MODE', DEFAULTS.approvalMode],
  ]) {
    try {
      config[key] = readBool(env, name, fallback);
    } catch (error) {
      problems.push(...error.problems);
    }
  }

  for (const [key, name, fallback] of [
    ['logLevel', 'LOG_LEVEL', DEFAULTS.logLevel],
    ['dbPath', 'DB_PATH', DEFAULTS.dbPath],
    ['chromeEndpoint', 'CHROME_ENDPOINT', DEFAULTS.chromeEndpoint],
    ['chromeWsEndpoint', 'CHROME_WS_ENDPOINT', DEFAULTS.chromeWsEndpoint],
    ['openaiBaseUrl', 'OPENAI_BASE_URL', DEFAULTS.openaiBaseUrl],
    ['openaiModel', 'OPENAI_MODEL', DEFAULTS.openaiModel],
    ['targetTopic', 'TARGET_TOPIC', DEFAULTS.targetTopic],
    ['commentLanguage', 'COMMENT_LANGUAGE', DEFAULTS.commentLanguage],
  ]) {
    config[key] = readString(env, name, fallback);
  }

  if (!telegramToken) {
    problems.push('TELEGRAM_BOT_TOKEN не задан — получи токен у @BotFather и добавь в .env');
  } else if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(telegramToken)) {
    problems.push('TELEGRAM_BOT_TOKEN выглядит некорректно (ожидается формат 123456:AA...)');
  }

  if (adminIds.length === 0) {
    problems.push('TELEGRAM_ADMIN_IDS не задан — укажи свой Telegram user id (узнать: @userinfobot)');
  }

  if (config.videoDelayMax < config.videoDelayMin) {
    problems.push('VIDEO_DELAY_MAX должен быть >= VIDEO_DELAY_MIN');
  }

  if (!config.chromeEndpoint && !config.chromeWsEndpoint) {
    problems.push('Нужен CHROME_ENDPOINT или CHROME_WS_ENDPOINT для подключения к Chrome');
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return Object.freeze(config);
}

module.exports = { loadConfig, ConfigError, DEFAULTS };
