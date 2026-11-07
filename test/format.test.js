'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../src/telegram/format');

test('escapeHtml экранирует спецсимволы Telegram HTML', () => {
  assert.equal(fmt.escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.equal(fmt.escapeHtml(null), '');
  assert.equal(fmt.escapeHtml(42), '42');
});

test('formatDuration переводит миллисекунды в человеческий вид', () => {
  assert.equal(fmt.formatDuration(0), '0 с');
  assert.equal(fmt.formatDuration(45_000), '45 с');
  assert.equal(fmt.formatDuration(125_000), '2 мин 5 с');
  assert.equal(fmt.formatDuration(3_725_000), '1 ч 2 мин');
});

test('progressBar зажимает значение в диапазон 0..1', () => {
  assert.equal(fmt.progressBar(0, 5), '▱▱▱▱▱');
  assert.equal(fmt.progressBar(1, 5), '▰▰▰▰▰');
  assert.equal(fmt.progressBar(2, 4), '▰▰▰▰');
  assert.equal(fmt.progressBar(-1, 3), '▱▱▱');
});

test('statusText экранирует пользовательские данные', () => {
  const text = fmt.statusText({
    running: true,
    paused: false,
    mode: 'search',
    query: '<script>alert(1)</script>',
    stats: { videos: 2, comments: 1, skipped: 0, failed: 0 },
    captcha: false,
    lastAction: 'a < b & c',
    lastActionAt: Date.now(),
    startedAt: Date.now() - 60_000,
  });

  assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(text.includes('a &lt; b &amp; c'));
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('🟢 работает'));
});

test('statusText для остановленного бота не падает без статистики', () => {
  const text = fmt.statusText({ running: false, lastAction: 'Бот не запущен' });
  assert.ok(text.includes('⚪️ остановлен'));
});

test('pendingText экранирует текст комментария и ссылку', () => {
  const text = fmt.pendingText({
    id: '1',
    text: 'Привет <world>',
    confidence: 0.9,
    timeoutSeconds: 300,
    video: { author: 'user', description: 'desc', url: 'https://tiktok.com/@user' },
  });
  assert.ok(text.includes('Привет &lt;world&gt;'));
  assert.ok(text.includes('Уверенность: 90%'));
});

test('settingsText содержит все ключи настроек', () => {
  const { SETTING_KEYS } = require('../src/settings');
  const settings = Object.fromEntries(SETTING_KEYS.map((key) => [key, 'x']));
  const text = fmt.settingsText(settings);
  for (const key of SETTING_KEYS) assert.ok(text.includes(key), `нет ключа ${key}`);
});

test('commentsText и videosText работают с пустыми списками', () => {
  assert.match(fmt.videosText([]), /ни одного видео/);
  assert.match(fmt.commentsText([]), /ни одного комментария/);
});
