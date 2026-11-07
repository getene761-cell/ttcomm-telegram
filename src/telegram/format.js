'use strict';

/**
 * Чистые функции форматирования сообщений (HTML для Telegram).
 * Никаких побочных эффектов — поэтому их легко тестировать.
 */

const { SETTINGS, SETTING_KEYS } = require('../settings');

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function shorten(text, max = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин ${seconds} с`;
  return `${seconds} с`;
}

function formatClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function progressBar(value, width = 10) {
  const clamped = Math.min(1, Math.max(0, Number(value) || 0));
  const filled = Math.round(clamped * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
}

function modeLabel(mode, query) {
  if (mode === 'feed') return 'лента «Для тебя»';
  if (mode === 'search') return `поиск «${escapeHtml(shorten(query || '', 60))}»`;
  return '—';
}

function stateLabel(state) {
  if (state.running) return state.paused ? '⏸ на паузе' : '🟢 работает';
  return '⚪️ остановлен';
}

function statusText(state) {
  const lines = [`<b>🤖 Бот</b>: ${stateLabel(state)}`];

  if (state.running) {
    lines.push(`<b>Режим</b>: ${modeLabel(state.mode, state.query)}`);
    if (state.startedAt) {
      lines.push(`<b>В работе</b>: ${formatDuration(Date.now() - state.startedAt)}`);
    }
    lines.push(
      `<b>Видео</b>: ${state.stats.videos} · <b>Комментариев</b>: ${state.stats.comments}` +
        ` · <b>Пропущено</b>: ${state.stats.skipped}` +
        (state.stats.failed ? ` · <b>Ошибок</b>: ${state.stats.failed}` : ''),
    );
    if (state.captcha) lines.push('🧩 <b>Капча</b>: жду решения в Chrome');
    if (state.pending) {
      lines.push(`✍️ <b>Ждёт подтверждения</b>: «${escapeHtml(shorten(state.pending.text, 80))}»`);
    }
  }

  lines.push('');
  lines.push(`<b>Последнее действие</b>: ${escapeHtml(shorten(state.lastAction, 200))}`);
  if (state.lastActionAt) lines.push(`<i>${formatClock(state.lastActionAt)}</i>`);

  return lines.join('\n');
}

function statsText(stats) {
  return [
    '<b>📊 Статистика за всё время</b>',
    '',
    `Сессий: <b>${stats.total_sessions}</b>`,
    `Видео обработано: <b>${stats.total_videos}</b>`,
    `Из них релевантных: <b>${stats.relevant_videos}</b>`,
    `Комментариев опубликовано: <b>${stats.total_comments}</b>`,
    `Неудачных публикаций: <b>${stats.failed_comments}</b>`,
  ].join('\n');
}

function settingValueText(key, value) {
  const meta = SETTINGS[key];
  if (!meta) return String(value);
  if (meta.type === 'bool') return value ? '🟢 вкл' : '⚪️ выкл';
  if (meta.type === 'number') return `${value}${key.endsWith('_seconds') ? ' с' : ''}`;
  return String(value);
}

function settingsText(settings) {
  const lines = ['<b>⚙️ Настройки</b>', ''];
  for (const key of SETTING_KEYS) {
    const meta = SETTINGS[key];
    lines.push(`<code>${key}</code> — ${meta.label}: <b>${escapeHtml(settingValueText(key, settings[key]))}</b>`);
  }
  lines.push('');
  lines.push('Изменить: <code>/set ключ значение</code>');
  return lines.join('\n');
}

function pendingText(pending) {
  const confidence = Math.round((Number(pending.confidence) || 0) * 100);
  return [
    '<b>✍️ Комментарий на подтверждении</b>',
    '',
    `🎬 @${escapeHtml(pending.video?.author || 'unknown')} — ${escapeHtml(
      shorten(pending.video?.description, 100),
    )}`,
    `🔗 ${escapeHtml(pending.video?.url || '')}`,
    '',
    `<blockquote>${escapeHtml(pending.text)}</blockquote>`,
    '',
    `Уверенность: ${confidence}% · время на решение: ${Math.round(
      (pending.timeoutSeconds || 0) / 60,
    )} мин`,
  ].join('\n');
}

function commentPostedText(event) {
  return [
    '<b>✅ Комментарий опубликован</b>',
    `🎬 @${escapeHtml(event.video?.author || 'unknown')}`,
    `💬 <i>${escapeHtml(shorten(event.text, 200))}</i>`,
    event.video?.url ? `🔗 ${escapeHtml(event.video.url)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function captchaText() {
  return [
    '<b>🧩 Капча</b>',
    '',
    'TikTok просит подтверждение. Реши капчу в окне Chrome — бот продолжит автоматически.',
    'Если она уже пройдена, нажми «Продолжить».',
  ].join('\n');
}

function errorText(message) {
  return `<b>❌ Ошибка бота</b>\n\n<code>${escapeHtml(shorten(message, 500))}</code>`;
}

function sessionEndText(event) {
  const reasons = {
    stopped: 'остановлен вручную',
    timeout: 'истёк лимит времени',
    exhausted: 'видео закончились',
    error: 'завершён из-за ошибки',
    finished: 'завершён',
  };
  return [
    '<b>🏁 Сессия завершена</b>',
    '',
    `Причина: ${reasons[event.reason] || event.reason}`,
    `Длительность: ${formatDuration(event.durationMs)}`,
    `Видео: <b>${event.stats.videos}</b> · Комментариев: <b>${event.stats.comments}</b>`,
    `Пропущено: ${event.stats.skipped} · Ошибок: ${event.stats.failed}`,
  ].join('\n');
}

function videosText(rows) {
  if (!rows.length) return 'Пока ни одного видео не обработано.';
  const lines = ['<b>🎬 Последние видео</b>', ''];
  for (const row of rows) {
    const score = row.relevance_score == null ? '—' : `${Math.round(row.relevance_score * 100)}%`;
    lines.push(
      `${row.is_relevant ? '✅' : '➖'} @${escapeHtml(row.author || 'unknown')} · ${score} · ` +
        `${escapeHtml(shorten(row.description, 60))}`,
    );
  }
  return lines.join('\n');
}

function commentsText(rows) {
  if (!rows.length) return 'Пока ни одного комментария.';
  const lines = ['<b>💬 Последние комментарии</b>', ''];
  for (const row of rows) {
    lines.push(
      `${row.success ? '✅' : '❌'} <i>${escapeHtml(shorten(row.comment_text, 120))}</i> — ` +
        `@${escapeHtml(row.author || 'unknown')}`,
    );
  }
  return lines.join('\n');
}

module.exports = {
  escapeHtml,
  shorten,
  formatDuration,
  formatClock,
  progressBar,
  modeLabel,
  statusText,
  statsText,
  settingsText,
  pendingText,
  commentPostedText,
  captchaText,
  errorText,
  sessionEndText,
  videosText,
  commentsText,
};
