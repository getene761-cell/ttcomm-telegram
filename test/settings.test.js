'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SETTINGS,
  SETTING_KEYS,
  validateSetting,
  defaultsFromConfig,
  mergeSettings,
  parseStoredValue,
} = require('../src/settings');

const config = {
  minRelevanceScore: 0.7,
  commentDelaySeconds: 30,
  maxCommentsPerHour: 20,
  videoDelayMin: 3,
  videoDelayMax: 8,
  sessionMaxMinutes: 120,
  approvalMode: true,
  approvalTimeoutSeconds: 300,
  commentLanguage: 'ru',
};

test('validateSetting принимает числа в допустимом диапазоне', () => {
  assert.deepEqual(validateSetting('min_relevance_score', '0.85'), { ok: true, value: 0.85 });
  assert.deepEqual(validateSetting('min_relevance_score', '0,5'), { ok: true, value: 0.5 });
  assert.equal(validateSetting('min_relevance_score', '1.5').ok, false);
  assert.equal(validateSetting('min_relevance_score', 'abc').ok, false);
});

test('validateSetting понимает булевы значения по-русски и по-английски', () => {
  for (const value of ['true', 'on', '1', 'да', 'вкл']) {
    assert.deepEqual(validateSetting('approval_mode', value), { ok: true, value: true });
  }
  for (const value of ['false', 'off', '0', 'нет', 'выкл']) {
    assert.deepEqual(validateSetting('approval_mode', value), { ok: true, value: false });
  }
  assert.equal(validateSetting('approval_mode', 'maybe').ok, false);
});

test('validateSetting проверяет enum и неизвестные ключи', () => {
  assert.deepEqual(validateSetting('comment_language', 'EN'), { ok: true, value: 'en' });
  assert.equal(validateSetting('comment_language', 'klingon').ok, false);
  assert.equal(validateSetting('nope', '1').ok, false);
});

test('defaultsFromConfig даёт значение для каждого ключа', () => {
  const defaults = defaultsFromConfig(config);
  for (const key of SETTING_KEYS) {
    assert.ok(defaults[key] !== undefined, `нет значения для ${key}`);
  }
  assert.equal(defaults.min_relevance_score, '0.7');
  assert.equal(defaults.approval_mode, '1');
});

test('mergeSettings: БД перекрывает значения из конфига, типы восстанавливаются', () => {
  const merged = mergeSettings(
    { min_relevance_score: '0.9', approval_mode: '0', comment_language: 'en' },
    config,
  );
  assert.equal(merged.min_relevance_score, 0.9);
  assert.equal(merged.approval_mode, false);
  assert.equal(merged.comment_language, 'en');
  assert.equal(merged.max_comments_per_hour, 20);
});

test('parseStoredValue корректно читает bool/number/string', () => {
  assert.equal(parseStoredValue('approval_mode', '1'), true);
  assert.equal(parseStoredValue('approval_mode', 'false'), false);
  assert.equal(parseStoredValue('min_relevance_score', '0.4'), 0.4);
  assert.equal(parseStoredValue('comment_language', 'de'), 'de');
});

test('у каждой настройки есть описание и метка', () => {
  for (const key of SETTING_KEYS) {
    const meta = SETTINGS[key];
    assert.ok(meta.label, `нет label у ${key}`);
    assert.ok(meta.description, `нет description у ${key}`);
    assert.ok(['number', 'bool', 'enum'].includes(meta.type), `странный тип у ${key}`);
  }
});
