'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const ICONS = { error: '✖', warn: '▲', info: '•', debug: '·' };

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

class Logger {
  constructor(level = 'info', { sink = process.stdout } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.sink = sink;
  }

  child(scope) {
    const parent = this;
    return {
      error: (msg, ...args) => parent._write('error', scope, msg, args),
      warn: (msg, ...args) => parent._write('warn', scope, msg, args),
      info: (msg, ...args) => parent._write('info', scope, msg, args),
      debug: (msg, ...args) => parent._write('debug', scope, msg, args),
    };
  }

  error(msg, ...args) {
    this._write('error', 'app', msg, args);
  }

  warn(msg, ...args) {
    this._write('warn', 'app', msg, args);
  }

  info(msg, ...args) {
    this._write('info', 'app', msg, args);
  }

  debug(msg, ...args) {
    this._write('debug', 'app', msg, args);
  }

  _write(level, scope, msg, args) {
    if (LEVELS[level] > this.level) return;
    const parts = [`${timestamp()} ${ICONS[level]} [${scope}]`, String(msg)];
    for (const arg of args) {
      if (arg instanceof Error) parts.push(arg.stack || arg.message);
      else if (typeof arg === 'object' && arg !== null) parts.push(safeJson(arg));
      else parts.push(String(arg));
    }
    this.sink.write(`${parts.join(' ')}\n`);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createLogger(level) {
  return new Logger(level);
}

module.exports = { createLogger, Logger, LEVELS };
