'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Хранилище состояния бота.
 *
 * Используется встроенный в Node модуль node:sqlite (Node >= 22.16),
 * поэтому нативной сборки и пакета sqlite3 здесь нет.
 */
class Database {
  constructor(filePath, { logger } = {}) {
    this.logger = logger;
    this.filePath = filePath;
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tiktok_id TEXT UNIQUE,
        platform TEXT DEFAULT 'tiktok',
        author TEXT,
        description TEXT,
        url TEXT,
        is_relevant INTEGER DEFAULT 0,
        relevance_score REAL,
        category TEXT,
        analysis_data TEXT,
        processed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER,
        comment_text TEXT,
        normalized_text TEXT,
        success INTEGER DEFAULT 1,
        posted_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (video_id) REFERENCES videos(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT,
        query TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        videos_analyzed INTEGER DEFAULT 0,
        comments_posted INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running'
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_videos_processed ON videos(processed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_comments_posted ON comments(posted_at DESC);
    `);

    this.migrate();
  }

  /**
   * SQLite lower() не умеет кириллицу, поэтому нормализуем текст в JS
   * и храним отдельной колонкой (нужно для поиска дублей).
   */
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(comments)').all().map((column) => column.name);
    if (!columns.includes('normalized_text')) {
      this.db.exec('ALTER TABLE comments ADD COLUMN normalized_text TEXT');
    }

    const stale = this.db
      .prepare('SELECT id, comment_text FROM comments WHERE normalized_text IS NULL')
      .all();
    if (stale.length > 0) {
      const update = this.db.prepare('UPDATE comments SET normalized_text = ? WHERE id = ?');
      for (const row of stale) update.run(normalizeComment(row.comment_text), row.id);
    }

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_comments_normalized ON comments(normalized_text)');
  }

  /* ----------------------------- videos ----------------------------- */

  saveVideo(video) {
    this.db
      .prepare(
        `INSERT INTO videos (tiktok_id, platform, author, description, url)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tiktok_id) DO NOTHING`,
      )
      .run(
        video.id,
        video.platform || 'tiktok',
        video.author || 'unknown',
        video.description || '',
        video.url || '',
      );

    const row = this.db.prepare('SELECT id FROM videos WHERE tiktok_id = ?').get(video.id);
    return row ? Number(row.id) : null;
  }

  updateVideoRelevance(videoId, analysis) {
    this.db
      .prepare(
        `UPDATE videos
         SET is_relevant = ?, relevance_score = ?, category = ?, analysis_data = ?
         WHERE id = ?`,
      )
      .run(
        analysis?.relevant ? 1 : 0,
        Number(analysis?.score) || 0,
        analysis?.category || 'other',
        JSON.stringify(analysis ?? {}),
        videoId,
      );
  }

  isVideoProcessed(tiktokId) {
    const row = this.db.prepare('SELECT 1 AS found FROM videos WHERE tiktok_id = ?').get(tiktokId);
    return Boolean(row);
  }

  /* ---------------------------- comments ---------------------------- */

  hasCommentText(text) {
    const normalized = normalizeComment(text);
    if (!normalized) return false;
    const row = this.db
      .prepare('SELECT 1 AS found FROM comments WHERE normalized_text = ? LIMIT 1')
      .get(normalized);
    return Boolean(row);
  }

  saveComment(videoId, comment, success) {
    const result = this.db
      .prepare('INSERT INTO comments (video_id, comment_text, normalized_text, success) VALUES (?, ?, ?, ?)')
      .run(videoId, comment, normalizeComment(comment), success ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  getRecentComments(limit = 10) {
    return this.db
      .prepare(
        `SELECT c.id, c.comment_text, c.success, c.posted_at,
                v.author, v.url, v.platform
         FROM comments c
         LEFT JOIN videos v ON c.video_id = v.id
         ORDER BY c.posted_at DESC, c.id DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  /* ---------------------------- sessions ---------------------------- */

  createSession({ mode, query } = {}) {
    const result = this.db
      .prepare('INSERT INTO sessions (mode, query) VALUES (?, ?)')
      .run(mode || null, query || null);
    return Number(result.lastInsertRowid);
  }

  updateSession(id, stats) {
    this.db
      .prepare('UPDATE sessions SET videos_analyzed = ?, comments_posted = ? WHERE id = ?')
      .run(stats.videos || 0, stats.comments || 0, id);
  }

  endSession(id, status = 'stopped') {
    this.db
      .prepare(`UPDATE sessions SET ended_at = datetime('now'), status = ? WHERE id = ?`)
      .run(status, id);
  }

  /* ----------------------------- stats ------------------------------ */

  getStats() {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions) AS total_sessions,
           (SELECT COUNT(*) FROM videos) AS total_videos,
           (SELECT COUNT(*) FROM videos WHERE is_relevant = 1) AS relevant_videos,
           (SELECT COUNT(*) FROM comments WHERE success = 1) AS total_comments,
           (SELECT COUNT(*) FROM comments WHERE success = 0) AS failed_comments`,
      )
      .get();

    return {
      total_sessions: Number(row.total_sessions),
      total_videos: Number(row.total_videos),
      relevant_videos: Number(row.relevant_videos),
      total_comments: Number(row.total_comments),
      failed_comments: Number(row.failed_comments),
    };
  }

  getRecentVideos(limit = 10) {
    return this.db
      .prepare('SELECT * FROM videos ORDER BY processed_at DESC, id DESC LIMIT ?')
      .all(limit);
  }

  /* ---------------------------- settings ---------------------------- */

  getSettingsMap() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const map = {};
    for (const row of rows) map[row.key] = row.value;
    return map;
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : undefined;
  }

  setSetting(key, value) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  close() {
    try {
      this.db.close();
    } catch (error) {
      this.logger?.warn?.(`Не удалось закрыть БД: ${error.message}`);
    }
  }
}

module.exports = { Database };

/** Нормализация текста комментария для поиска дублей (кириллица + пунктуация). */
function normalizeComment(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[.!?…,;:—–-]+$/u, '')
    .trim();
}
