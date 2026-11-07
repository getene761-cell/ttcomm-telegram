'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCommand, parseLimit, parseSetArgs, helpText, COMMANDS } = require('../src/telegram/commands');

test('parseCommand понимает простые и адресные команды', () => {
  assert.deepEqual(parseCommand('/search'), { name: 'search', args: '' });
  assert.deepEqual(parseCommand('/search remote   jobs '), { name: 'search', args: 'remote   jobs' });
  assert.deepEqual(parseCommand('/feed@my_bot'), { name: 'feed', args: '' });
  assert.deepEqual(parseCommand('  /SET min_relevance_score 0.8 '), {
    name: 'set',
    args: 'min_relevance_score 0.8',
  });
});

test('parseCommand отсекает мусор, обычный текст и неизвестные команды', () => {
  assert.equal(parseCommand('привет'), null);
  assert.equal(parseCommand('/unknown'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand('/шутка'), null);
});

test('parseLimit ограничивает значение', () => {
  assert.equal(parseLimit('', { fallback: 7 }), 7);
  assert.equal(parseLimit('abc', { fallback: 7 }), 7);
  assert.equal(parseLimit('5', { fallback: 7 }), 5);
  assert.equal(parseLimit('999', { fallback: 7, max: 25 }), 25);
  assert.equal(parseLimit('-3', { fallback: 4 }), 4);
});

test('parseSetArgs разбирает ключ и значение', () => {
  assert.deepEqual(parseSetArgs('min_relevance_score 0.8'), {
    key: 'min_relevance_score',
    rawValue: '0.8',
  });
  assert.deepEqual(parseSetArgs('comment_language RU'), { key: 'comment_language', rawValue: 'RU' });
  assert.ok(parseSetArgs('').error);
  assert.ok(parseSetArgs('min_relevance_score').error);
});

test('helpText перечисляет все команды', () => {
  const text = helpText();
  for (const command of COMMANDS) {
    assert.ok(text.includes(`/${command.name}`), `в справке нет /${command.name}`);
  }
});
