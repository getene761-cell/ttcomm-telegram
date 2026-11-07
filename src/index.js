#!/usr/bin/env node
'use strict';

const { loadConfig, ConfigError } = require('./config');
const { createLogger } = require('./logger');
const { Database } = require('./db');
const { TelegramClient } = require('./telegram/api');
const { createApp } = require('./telegram/app');

function loadEnvFile() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Не удалось прочитать .env: ${error.message}`);
    }
  }
}

async function main() {
  loadEnvFile();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      console.error('Заполни .env по образцу .env.example и запусти снова.\n');
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  logger.info('Запуск ttcomm (управление через Telegram)');

  const db = new Database(config.dbPath, { logger: logger.child('db') });
  const client = new TelegramClient(config.telegramToken, { logger: logger.child('telegram') });
  const app = createApp({ config, db, logger: logger.child('app'), client });

  await app.bootstrap();

  const controller = new AbortController();
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Получен ${signal}, останавливаюсь…`);
    controller.abort();

    try {
      await app.getActiveBot()?.stop('shutdown');
    } catch (error) {
      logger.warn(`Не удалось остановить бота: ${error.message}`);
    }

    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Необработанный rejection: ${reason?.stack || reason}`);
  });

  logger.info('Слушаю Telegram (long polling). Напиши боту /start.');
  await client.startPolling({ onUpdate: app.handleUpdate, signal: controller.signal });
}

main().catch((error) => {
  console.error('Фатальная ошибка:', error);
  process.exit(1);
});
