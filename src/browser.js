'use strict';

const puppeteer = require('puppeteer-core');

const SELECTORS = {
  loginButton: 'button[data-e2e="top-login-button"], [data-e2e="login-button"]',
  videosTab: '[data-e2e="search-video-tab"], a[href*="/search/video"]',
  searchCard: '[data-e2e="search_top-item"], [data-e2e="search-item"]',
  videoLink: 'a[href*="/video/"]',
  commentList: '[data-e2e="comment-list"], [class*="CommentList"]',
  commentIcon: '[data-e2e="comment-icon"], [data-e2e="video-comment-icon"]',
  commentItem: '[data-e2e="comment-item"], [class*="CommentItem"]',
  commentInput: [
    '[data-e2e="comment-input"]',
    'div[contenteditable="true"][data-e2e*="comment"]',
    'div[contenteditable="true"][class*="comment-input"]',
    'div[contenteditable="true"][class*="CommentInput"]',
  ],
  commentPost: '[data-e2e="comment-post"], button[type="submit"]:not([disabled])',
  captcha: [
    '.captcha-slider',
    '#captcha-verify-image',
    '[class*="captcha"]',
    '[id*="captcha"]',
    '.secsdk-captcha-drag-icon',
    '.verify-captcha-slider',
  ],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Управление уже запущенным Chrome по CDP.
 * Chrome должен быть запущен с --remote-debugging-port=9222 и залогинен в TikTok.
 */
class BrowserManager {
  constructor(config, stealth, logger) {
    this.config = config;
    this.stealth = stealth;
    this.logger = logger;
    this.browser = null;
    this.page = null;
    this.isConnected = false;
    this.captchaDetected = false;
    // Выставляются Bot-ом: как узнать про остановку и что делать при капче.
    this.shouldStop = () => false;
    this.onCaptcha = null;
  }

  async connect() {
    if (this.isConnected && this.browser?.connected) return true;

    const options = {
      defaultViewport: null,
      protocolTimeout: 120000,
    };

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (this.config.chromeWsEndpoint) {
          this.browser = await puppeteer.connect({
            browserWSEndpoint: this.config.chromeWsEndpoint,
            ...options,
          });
        } else {
          this.browser = await puppeteer.connect({
            browserURL: this.config.chromeEndpoint,
            ...options,
          });
        }

        const pages = await this.browser.pages();
        this.page = pages.find((p) => p.url().includes('tiktok.com')) || pages[0] || (await this.browser.newPage());
        await this.stealth.setupStealthMode(this.page);

        this.isConnected = true;
        this.logger?.info?.(`Подключено к Chrome (вкладка: ${this.page.url() || 'новая'})`);
        return true;
      } catch (error) {
        lastError = error;
        this.logger?.warn?.(`Попытка ${attempt}/3 подключиться к Chrome не удалась: ${error.message}`);
        await sleep(1000 * attempt);
      }
    }

    throw new Error(
      `Не удалось подключиться к Chrome (${this.config.chromeEndpoint}). ` +
        `Проверь, что он запущен с --remote-debugging-port=9222. Детали: ${lastError?.message}`,
    );
  }

  async checkLogin() {
    if (!this.isConnected) throw new Error('Нет подключения к Chrome');
    await this.page.goto('https://www.tiktok.com', { waitUntil: 'networkidle2', timeout: 45000 });

    try {
      await this.page.waitForSelector(SELECTORS.loginButton, { timeout: 8000 });
      this.logger?.warn?.('TikTok: кнопка входа найдена — пользователь не авторизован');
      return false;
    } catch {
      // кнопки нет — вероятно, залогинены
    }

    const hasProfile = await this.page.evaluate(
      () =>
        Boolean(
          document.querySelector('[data-e2e="profile-icon"], [data-e2e="upload-icon"], a[href*="/@"] img'),
        ),
    );
    return hasProfile;
  }

  async *scrollFeed() {
    const url = await this.page.url();
    if (!url.includes('foryou') && !/tiktok\.com\/?$/.test(url)) {
      await this.page.goto('https://www.tiktok.com', { waitUntil: 'networkidle2', timeout: 45000 });
      await this.stealth.humanDelay('reading');
    }
    yield* this.scrollVideos('feed');
  }

  async *scrollSearch(searchQuery) {
    const url = `https://www.tiktok.com/search?q=${encodeURIComponent(searchQuery)}`;
    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await this.stealth.humanDelay('reading');

    try {
      const videosTab = await this.page.$(SELECTORS.videosTab);
      if (videosTab) {
        await this.stealth.humanMouseMove(this.page, videosTab);
        await this.stealth.humanDelay('beforeClick');
        await videosTab.click();
        await this.stealth.humanDelay('afterClick');
      }
    } catch {
      this.logger?.debug?.('Вкладка «Видео» не найдена, продолжаем со страницы поиска');
    }

    yield* this.scrollVideos('search');
  }

  async *scrollVideos(mode) {
    const processed = new Set();
    let attempts = 0;
    let emptyRounds = 0;

    while (attempts < 150 && emptyRounds < 6) {
      attempts += 1;
      if (this.shouldStop()) return;

      if (await this.checkForCaptcha()) {
        this.captchaDetected = true;
        this.logger?.warn?.('Обнаружена капча — ждём решения');
        if (this.onCaptcha) await this.onCaptcha();
        if (this.shouldStop()) return;
        continue;
      }
      this.captchaDetected = false;

      if (mode === 'search') {
        const videos = await this.extractSearchVideos();
        let foundNew = false;

        for (const video of videos) {
          if (processed.has(video.id)) continue;
          processed.add(video.id);
          foundNew = true;
          emptyRounds = 0;

          await this.navigateToVideo(video);
          const fullVideo = await this.extractCurrentVideo();
          if (fullVideo) yield fullVideo;

          await this.page.goBack({ waitUntil: 'networkidle2' }).catch(() => {});
          await this.stealth.humanDelay('scrolling');
        }

        if (!foundNew) {
          emptyRounds += 1;
          this.logger?.debug?.(`Нет новых видео (${emptyRounds}/6), скроллим`);
          await this.stealth.humanScroll(this.page, 'down');
          await this.stealth.humanDelay('scrolling');
        }
      } else {
        const video = await this.extractCurrentVideo();
        if (video && !processed.has(video.id)) {
          processed.add(video.id);
          emptyRounds = 0;
          yield video;
        } else {
          emptyRounds += 1;
        }

        await this.page.keyboard.press('ArrowDown');
        await this.stealth.humanDelay('scrolling');
      }
    }

    this.logger?.info?.(`Сессия прокрутки завершена: найдено ${processed.size} видео`);
  }

  async extractSearchVideos() {
    return this.page.evaluate((selectors) => {
      const results = [];
      const containers = document.querySelectorAll(selectors.searchCard);

      containers.forEach((container) => {
        const link = container.querySelector(selectors.videoLink);
        if (!link || !link.href.includes('/video/')) return;

        const videoId = link.href.match(/video\/(\d+)/)?.[1];
        if (!videoId) return;

        const author = link.href.match(/@([^/]+)/)?.[1] || 'unknown';

        const descSelectors = [
          '[data-e2e="search-card-desc"]',
          '[class*="video-card-caption"]',
          '[class*="caption"]',
          'h3',
          '[title]',
        ];
        let description = '';
        for (const selector of descSelectors) {
          const element = container.querySelector(selector);
          if (element) {
            description = element.textContent || element.title || '';
            break;
          }
        }

        results.push({
          id: videoId,
          url: link.href,
          author,
          description: description.trim(),
          platform: 'tiktok',
        });
      });

      return results;
    }, SELECTORS);
  }

  async extractCurrentVideo() {
    try {
      await this.stealth.humanDelay('default');
      return await this.page.evaluate(() => {
        const currentUrl = window.location.href;
        const videoId = currentUrl.match(/video\/(\d+)/)?.[1];
        const authorElement = document.querySelector('[data-e2e="video-author"], a[href*="/@"]');
        const author =
          authorElement?.textContent?.trim() ||
          authorElement?.href?.split('/@')[1]?.split(/[/?]/)[0] ||
          'unknown';
        const description =
          document.querySelector('[data-e2e="video-desc"], h1')?.textContent?.trim() || '';

        if (!videoId) {
          return {
            id: `feed_${author.replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`,
            url: currentUrl,
            author,
            description,
            platform: 'tiktok',
          };
        }

        return { id: videoId, url: currentUrl, author, description, platform: 'tiktok' };
      });
    } catch (error) {
      this.logger?.warn?.(`Не удалось прочитать видео: ${error.message}`);
      return null;
    }
  }

  async navigateToVideo(video) {
    try {
      await this.page.goto(video.url, { waitUntil: 'networkidle2', timeout: 45000 });
      await this.stealth.humanDelay('reading');
    } catch (error) {
      this.logger?.warn?.(`Переход к видео не удался: ${error.message}`);
    }
  }

  async getVideoDetails() {
    try {
      await this.stealth.humanDelay('reading');
      return await this.page.evaluate(() => {
        const selectors = {
          likes: ['[data-e2e="like-count"]', '[data-e2e="video-like-count"]'],
          comments: ['[data-e2e="comment-count"]', '[data-e2e="video-comment-count"]'],
          shares: ['[data-e2e="share-count"]', '[data-e2e="video-share-count"]'],
        };
        const read = (list) => {
          for (const selector of list) {
            const element = document.querySelector(selector);
            if (element) return element.textContent.trim() || '0';
          }
          return '0';
        };
        return {
          counts: {
            likes: read(selectors.likes),
            comments: read(selectors.comments),
            shares: read(selectors.shares),
          },
        };
      });
    } catch {
      return { counts: { likes: '0', comments: '0', shares: '0' } };
    }
  }

  async getComments(limit = 30) {
    try {
      const isOpen = await this.page.evaluate(
        (selector) => Boolean(document.querySelector(selector)),
        SELECTORS.commentList,
      );

      if (!isOpen) {
        const button = await this.page.$(SELECTORS.commentIcon);
        if (button) {
          await this.stealth.humanMouseMove(this.page, button);
          await this.stealth.humanDelay('beforeClick');
          await button.click();
          await this.stealth.humanDelay('afterClick');
          await this.page
            .waitForSelector(SELECTORS.commentList, { timeout: 10000 })
            .catch(() => null);
        }
      }

      await this.stealth.simulateReading('Читаем комментарии под видео');
      return await this.page.evaluate(
        (selectors, max) => {
          const rows = [];
          for (const container of document.querySelectorAll(selectors.commentItem)) {
            const username =
              container.querySelector('[data-e2e="comment-username"], a[href*="/@"]')?.textContent?.trim() || '';
            const text =
              container
                .querySelector('[data-e2e="comment-text"], [class*="comment-text"], span[class*="text"]')
                ?.textContent?.trim() || '';
            const likes =
              container.querySelector('[data-e2e="comment-like-count"], [class*="like"] span')?.textContent?.trim() ||
              '0';
            if (username && text) rows.push({ username, text, likes });
            if (rows.length >= max) break;
          }
          return rows;
        },
        SELECTORS,
        limit,
      );
    } catch (error) {
      this.logger?.warn?.(`Не удалось прочитать комментарии: ${error.message}`);
      return [];
    }
  }

  /**
   * Публикует комментарий.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async postComment(text) {
    try {
      if (await this.checkForCaptcha()) {
        return { ok: false, error: 'captcha' };
      }

      const isOpen = await this.page.evaluate(
        (selector) => Boolean(document.querySelector(selector)),
        SELECTORS.commentList,
      );
      if (!isOpen) await this.getComments(1);

      let input = null;
      for (const selector of SELECTORS.commentInput) {
        input = await this.page.$(selector);
        if (input) break;
      }
      if (!input) return { ok: false, error: 'поле ввода комментария не найдено' };

      await this.stealth.humanMouseMove(this.page, input);
      await this.stealth.humanDelay('beforeClick');
      await input.click();
      await this.stealth.humanDelay('default');

      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('A');
      await this.page.keyboard.up('Control');
      await this.stealth.wait(120);

      await this.stealth.humanType(this.page, text);
      await this.stealth.humanDelay('afterClick');

      const postButton = await this.page.$(SELECTORS.commentPost);
      if (postButton) {
        await this.stealth.humanMouseMove(this.page, postButton);
        await this.stealth.humanDelay('beforeClick');
        await postButton.click();
      } else {
        await this.page.keyboard.press('Enter');
      }

      await this.stealth.humanDelay('afterClick');
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.stealth.wait(1500);

      if (await this.checkForCaptcha()) {
        return { ok: false, error: 'captcha' };
      }

      return { ok: true };
    } catch (error) {
      this.logger?.warn?.(`Ошибка публикации комментария: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async checkForCaptcha() {
    try {
      const found = await this.page.evaluate((selectors) => {
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
          }
        }
        return false;
      }, SELECTORS.captcha);
      this.captchaDetected = found;
      return found;
    } catch {
      return false;
    }
  }

  async waitForCaptchaSolved() {
    while (!this.shouldStop()) {
      if (!(await this.checkForCaptcha())) {
        this.captchaDetected = false;
        return true;
      }
      await sleep(3000);
    }
    return false;
  }

  getCaptchaStatus() {
    return this.captchaDetected;
  }

  async disconnect() {
    if (!this.browser) return;
    try {
      await this.browser.disconnect();
    } catch {
      // уже отключён
    } finally {
      this.browser = null;
      this.page = null;
      this.isConnected = false;
      this.captchaDetected = false;
    }
  }
}

module.exports = BrowserManager;
module.exports.SELECTORS = SELECTORS;
