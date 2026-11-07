'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { Database } = require('../src/db');

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttcomm-db-'));
  return path.join(dir, 'bot.db');
}

test('свежая БД: видео, комментарии, статистика', () => {
  const db = new Database(':memory:');

  const videoId = db.saveVideo({ id: 'v1', author: 'alice', description: 'desc', url: 'u' });
  assert.ok(videoId > 0);
  assert.equal(db.isVideoProcessed('v1'), true);
  assert.equal(db.isVideoProcessed('v2'), false);

  db.updateVideoRelevance(videoId, { relevant: true, score: 0.9, category: 'work' });
  db.saveComment(videoId, 'Отличный совет!', true);

  assert.equal(db.hasCommentText('отличный совет'), true);
  assert.equal(db.hasCommentText('Отличный совет!'), true);
  assert.equal(db.hasCommentText('другой текст'), false);

  const stats = db.getStats();
  assert.equal(stats.total_videos, 1);
  assert.equal(stats.relevant_videos, 1);
  assert.equal(stats.total_comments, 1);
  assert.equal(db.getRecentVideos(5).length, 1);
  assert.equal(db.getRecentComments(5).length, 1);

  db.close();
});

test('настройки: запись, чтение, удаление', () => {
  const db = new Database(':memory:');
  db.setSetting('min_relevance_score', '0.85');
  assert.equal(db.getSetting('min_relevance_score'), '0.85');
  db.deleteSetting('min_relevance_score');
  assert.equal(db.getSetting('min_relevance_score'), undefined);
  db.close();
});

test('миграция БД старой версии (без mode/query/normalized_text)', () => {
  const file = tempDbPath();
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tiktok_id TEXT UNIQUE, platform TEXT DEFAULT 'tiktok', author TEXT,
      description TEXT, url TEXT, is_relevant INTEGER DEFAULT 0,
      relevance_score REAL, category TEXT, analysis_data TEXT, processed_at TEXT
    );
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER, comment_text TEXT,
      success INTEGER DEFAULT 1, posted_at TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, ended_at TEXT,
      videos_analyzed INTEGER DEFAULT 0, comments_posted INTEGER DEFAULT 0, status TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  raw.prepare('INSERT INTO comments (comment_text) VALUES (?)').run('Привет, мир!');
  raw.close();

  const db = new Database(file);

  // кириллица + пунктуация нормализуются, поэтому дубль находится
  assert.equal(db.hasCommentText('привет, мир'), true);

  // появились новые колонки, поэтому создание сессии не падает
  const sessionId = db.createSession({ mode: 'search', query: 'q' });
  assert.ok(sessionId > 0);
  db.endSession(sessionId, 'stopped');

  db.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
