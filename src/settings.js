'use strict';

/**
 * Настройки, которые можно менять из Telegram командой /set.
 * Значения хранятся в SQLite (таблица settings) и перекрывают .env.
 */

const SETTINGS = Object.freeze({
  min_relevance_score: {
    label: 'Мин. релевантность',
    description: 'Видео с оценкой ниже этого порога пропускаются',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    fromConfig: (config) => config.minRelevanceScore,
  },
  comment_delay_seconds: {
    label: 'Пауза после коммента',
    description: 'Сколько секунд ждать после успешного комментария',
    type: 'number',
    min: 0,
    max: 3600,
    step: 5,
    fromConfig: (config) => config.commentDelaySeconds,
  },
  max_comments_per_hour: {
    label: 'Лимит комментов/час',
    description: 'Максимум комментариев за скользящий час',
    type: 'number',
    min: 1,
    max: 60,
    step: 1,
    fromConfig: (config) => config.maxCommentsPerHour,
  },
  video_delay_min: {
    label: 'Мин. пауза между видео',
    description: 'Нижняя граница паузы перед следующим видео, сек',
    type: 'number',
    min: 1,
    max: 120,
    step: 1,
    fromConfig: (config) => config.videoDelayMin,
  },
  video_delay_max: {
    label: 'Макс. пауза между видео',
    description: 'Верхняя граница паузы перед следующим видео, сек',
    type: 'number',
    min: 1,
    max: 300,
    step: 1,
    fromConfig: (config) => config.videoDelayMax,
  },
  session_max_minutes: {
    label: 'Макс. длина сессии',
    description: 'Через сколько минут бот завершит работу сам',
    type: 'number',
    min: 1,
    max: 720,
    step: 5,
    fromConfig: (config) => config.sessionMaxMinutes,
  },
  approval_mode: {
    label: 'Ручное подтверждение',
    description: 'Если включено, каждый комментарий ждёт кнопки «Отправить»',
    type: 'bool',
    fromConfig: (config) => config.approvalMode,
  },
  approval_timeout_seconds: {
    label: 'Таймаут подтверждения',
    description: 'Сколько секунд ждать решения по комментарию',
    type: 'number',
    min: 15,
    max: 3600,
    step: 15,
    fromConfig: (config) => config.approvalTimeoutSeconds,
  },
  comment_language: {
    label: 'Язык комментариев',
    description: 'На каком языке писать комментарии',
    type: 'enum',
    values: ['ru', 'en', 'es', 'de', 'fr', 'pt', 'it'],
    fromConfig: (config) => config.commentLanguage,
  },
});

const SETTING_KEYS = Object.freeze(Object.keys(SETTINGS));

function isBoolTrue(raw) {
  return ['1', 'true', 'yes', 'on', 'да', 'вкл'].includes(String(raw).trim().toLowerCase());
}

function isBoolFalse(raw) {
  return ['0', 'false', 'no', 'off', 'нет', 'выкл'].includes(String(raw).trim().toLowerCase());
}

/**
 * Проверяет и нормализует значение настройки.
 * @returns {{ok: true, value: string|number|boolean} | {ok: false, error: string}}
 */
function validateSetting(key, raw) {
  const meta = SETTINGS[key];
  if (!meta) {
    return { ok: false, error: `Неизвестная настройка «${key}»` };
  }

  const text = String(raw ?? '').trim();
  if (!text) {
    return { ok: false, error: 'Значение не может быть пустым' };
  }

  if (meta.type === 'bool') {
    if (isBoolTrue(text)) return { ok: true, value: true };
    if (isBoolFalse(text)) return { ok: true, value: false };
    return { ok: false, error: 'Ожидается on/off (true/false)' };
  }

  if (meta.type === 'enum') {
    const value = text.toLowerCase();
    if (!meta.values.includes(value)) {
      return { ok: false, error: `Допустимые значения: ${meta.values.join(', ')}` };
    }
    return { ok: true, value };
  }

  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value)) {
    return { ok: false, error: 'Ожидается число' };
  }
  if (value < meta.min || value > meta.max) {
    return { ok: false, error: `Допустимый диапазон: ${meta.min}..${meta.max}` };
  }
  return { ok: true, value };
}

function defaultsFromConfig(config) {
  const result = {};
  for (const [key, meta] of Object.entries(SETTINGS)) {
    const value = meta.fromConfig(config);
    result[key] = meta.type === 'bool' ? (value ? '1' : '0') : String(value);
  }
  return result;
}

/**
 * Превращает строки из БД в нормальные типы.
 */
function parseStoredValue(key, raw) {
  const meta = SETTINGS[key];
  if (!meta) return raw;
  if (meta.type === 'bool') return isBoolTrue(raw);
  if (meta.type === 'number') return Number(raw);
  return String(raw);
}

function mergeSettings(stored, config) {
  const merged = {};
  const defaults = defaultsFromConfig(config);
  for (const key of SETTING_KEYS) {
    const raw = stored[key] ?? defaults[key];
    merged[key] = parseStoredValue(key, raw);
  }
  return merged;
}

module.exports = {
  SETTINGS,
  SETTING_KEYS,
  validateSetting,
  defaultsFromConfig,
  parseStoredValue,
  mergeSettings,
};
