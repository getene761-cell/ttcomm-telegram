'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Bot } = require('../src/bot');
const { Database } = require('../src/db');

class FakeBrowser {
  constructor() {
    this.shouldStop = () => false;
    this.onCaptcha = null;
    this.posted = [];
    this.failNext = false;
  }

  async connect() {}
  async checkLogin() { return true; }
  async checkForCaptcha() { return false; }
  async getVideoDetails() { return { counts: { likes: '10', comments: '2', shares: '1' } }; }
  async getComments() { return [{ username: 'u', text: 'nice', likes: '5' }]; }

  async *scrollSearch() {
    yield { id: 'v1', author: 'alice', description: 'remote work tips', url: 'https://tiktok.com/@alice/video/1' };
    yield { id: 'v2', author: 'bob', description: 'career advice', url: 'https://tiktok.com/@bob/video/2' };
  }

  async postComment(text) {
    if (this.failNext) return { ok: false, error: 'field not found' };
    this.posted.push(text);
    return { ok: true };
  }

  async disconnect() {}
  getCaptchaStatus() { return false; }
}

const fakeStealth = {
  randomDelay: () => 1,
  humanDelay: async () => {},
  wait: async () => {},
};

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

function baseConfig(overrides = {}) {
  return {
    minRelevanceScore: 0.7,
    commentDelaySeconds: 0,
    maxCommentsPerHour: 20,
    videoDelayMin: 0.001,
    videoDelayMax: 0.002,
    sessionMaxMinutes: 120,
    approvalMode: false,
    approvalTimeoutSeconds: 60,
    commentLanguage: 'ru',
    statusUpdateSeconds: 15,
    ...overrides,
  };
}

function makeBot({ config = baseConfig(), ai, browser } = {}) {
  const db = new Database(':memory:');
  const bot = new Bot({
    config,
    db,
    ai:
      ai || {
        analyze: async () => ({
          relevant: true,
          score: 0.95,
          reason: 'fits',
          category: 'work',
          commentContext: {
            mainTheme: 'jobs',
            sentiment: 'positive',
            engagementLevel: 'high',
            suggestedApproach: 'support',
          },
        }),
        generateComment: async ({ video }) => ({
          comment: `Комментарий к ${video.id}`,
          confidence: 0.8,
          reasoning: 'ok',
        }),
      },
    browser: browser || new FakeBrowser(),
    stealth: fakeStealth,
    logger: silentLogger,
  });
  return { bot, db };
}

test('сессия публикует комментарии без подтверждения и сохраняет статистику', async () => {
  const browser = new FakeBrowser();
  const { bot, db } = makeBot({ browser });
  const ended = [];
  bot.on('session:end', (event) => ended.push(event));

  await bot.run({ mode: 'search', query: 'remote work' });

  assert.equal(browser.posted.length, 2);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].stats.videos, 2);
  assert.equal(ended[0].stats.comments, 2);
  assert.equal(ended[0].reason, 'exhausted');
  assert.equal(db.getStats().total_comments, 2);
  assert.equal(db.getStats().total_videos, 2);
});

test('нерелевантное видео не комментируется', async () => {
  const browser = new FakeBrowser();
  const { bot } = makeBot({
    browser,
    ai: {
      analyze: async () => ({
        relevant: false,
        score: 0.1,
        reason: 'no',
        category: 'other',
        commentContext: { mainTheme: 'x', sentiment: 'mixed', engagementLevel: 'low', suggestedApproach: 'support' },
      }),
      generateComment: async () => {
        throw new Error('не должно вызываться');
      },
    },
  });

  await bot.run({ mode: 'search', query: 'q' });
  assert.equal(browser.posted.length, 0);
});

test('approval mode: комментарий ждёт решения и уходит после подтверждения', async () => {
  const browser = new FakeBrowser();
  const { bot } = makeBot({ browser, config: baseConfig({ approvalMode: true }) });

  const seen = [];
  bot.on('comment:pending', (pending) => {
    seen.push(pending.text);
    setImmediate(() => bot.decidePending(pending.id, 'approve'));
  });

  await bot.run({ mode: 'search', query: 'q' });

  assert.equal(seen.length, 2);
  assert.equal(browser.posted.length, 2);
});

test('approval mode: отклонённый комментарий не публикуется', async () => {
  const browser = new FakeBrowser();
  const { bot } = makeBot({ browser, config: baseConfig({ approvalMode: true }) });

  bot.on('comment:pending', (pending) => {
    setImmediate(() => bot.decidePending(pending.id, 'reject'));
  });

  await bot.run({ mode: 'search', query: 'q' });

  assert.equal(browser.posted.length, 0);
  assert.equal(bot.stats.comments, 0);
  assert.equal(bot.stats.skipped, 2);
});

test('дубли комментариев не публикуются повторно', async () => {
  const browser = new FakeBrowser();
  const { bot, db } = makeBot({
    browser,
    ai: {
      analyze: async () => ({
        relevant: true,
        score: 0.9,
        reason: '',
        category: 'work',
        commentContext: { mainTheme: 'x', sentiment: 'mixed', engagementLevel: 'high', suggestedApproach: 'support' },
      }),
      generateComment: async () => ({ comment: 'Один и тот же текст', confidence: 0.7, reasoning: '' }),
    },
  });

  await bot.run({ mode: 'search', query: 'q' });

  assert.equal(browser.posted.length, 1);
  assert.equal(db.getStats().total_comments, 1);
});

test('stop() прерывает сессию и завершает её со статусом stopped', async () => {
  const browser = new FakeBrowser();
  const { bot } = makeBot({ browser, config: baseConfig({ videoDelayMin: 1, videoDelayMax: 2 }) });

  const ended = [];
  bot.on('session:end', (event) => ended.push(event));
  bot.on('action', (event) => {
    if (event.text.includes('Смотрю видео')) bot.stop('manual');
  });

  await bot.run({ mode: 'search', query: 'q' });

  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'stopped');
  assert.equal(browser.posted.length, 0);
});

test('ошибка публикации не роняет сессию', async () => {
  const browser = new FakeBrowser();
  browser.failNext = true;
  const { bot } = makeBot({ browser });

  await bot.run({ mode: 'search', query: 'q' });

  assert.equal(bot.stats.failed, 2);
  assert.equal(bot.stats.comments, 0);
});
