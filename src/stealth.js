'use strict';

/**
 * Человекоподобное поведение: задержки, движение мыши, набор текста, скролл.
 */
class StealthFeatures {
  constructor(config = {}) {
    this.config = config;
    this.actionCount = 0;
    this.lastActionTime = Date.now();
    this.delays = {
      typing: { min: 50, max: 150 },
      beforeClick: { min: 300, max: 800 },
      afterClick: { min: 1000, max: 2000 },
      scrolling: { min: 2000, max: 4000 },
      reading: { min: 3000, max: 6000 },
      beforeComment: { min: 2000, max: 4000 },
      default: { min: 500, max: 1500 },
    };
  }

  randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async humanDelay(actionType = 'default') {
    const delay = this.delays[actionType] || this.delays.default;
    const ms = this.randomDelay(delay.min, delay.max);
    if (Math.random() < 0.1) {
      await this.wait(this.randomDelay(100, 300));
    }
    await this.wait(ms);
  }

  async humanMouseMove(page, element) {
    try {
      const box = await element.boundingBox();
      if (!box) return;

      const startX = Math.random() * 800;
      const startY = Math.random() * 600;
      const steps = this.randomDelay(3, 6);

      for (let i = 0; i <= steps; i += 1) {
        const progress = i / steps;
        const ease = progress * progress * (3 - 2 * progress);
        const x = startX + (box.x + box.width / 2 - startX) * ease;
        const y = startY + (box.y + box.height / 2 - startY) * ease;
        const jitterX = (Math.random() - 0.5) * 2;
        const jitterY = (Math.random() - 0.5) * 2;
        await page.mouse.move(x + jitterX, y + jitterY);
        await this.wait(this.randomDelay(10, 30));
      }

      await this.wait(this.randomDelay(100, 300));
    } catch {
      // элемент мог исчезнуть — это нормально
    }
  }

  async humanType(page, text, makeTypos = true) {
    const chars = text.split('');
    for (let i = 0; i < chars.length; i += 1) {
      if (makeTypos && Math.random() < 0.02 && i > 0 && i < chars.length - 1) {
        const wrongChar = String.fromCharCode(chars[i].charCodeAt(0) + 1);
        await page.keyboard.type(wrongChar);
        await this.wait(this.randomDelay(100, 300));
        await page.keyboard.press('Backspace');
        await this.wait(this.randomDelay(50, 150));
      }

      await page.keyboard.type(chars[i]);

      const baseDelay = this.randomDelay(50, 150);
      const variableDelay = Math.random() < 0.1 ? baseDelay * 2 : baseDelay;
      await this.wait(variableDelay);

      if (Math.random() < 0.05) {
        await this.wait(this.randomDelay(300, 800));
      }
    }
  }

  async simulateReading(text) {
    const wordsPerMinute = this.randomDelay(180, 250);
    const words = String(text || '').split(' ').length;
    const readingTime = (words / wordsPerMinute) * 60 * 1000;
    const actualTime = this.randomDelay(
      Math.max(1000, readingTime * 0.7),
      Math.max(1200, readingTime * 1.3),
    );
    await this.wait(actualTime);
  }

  async humanScroll(page, direction = 'down') {
    const scrollAmount = this.randomDelay(100, 300);
    const smoothness = this.randomDelay(3, 7);
    for (let i = 0; i < smoothness; i += 1) {
      const partialScroll = scrollAmount / smoothness;
      await page.evaluate(
        (scroll, dir) => {
          window.scrollBy(0, dir === 'down' ? scroll : -scroll);
        },
        partialScroll,
        direction,
      );
      await this.wait(this.randomDelay(50, 150));
    }
  }

  shouldRandomizeAction(probability = 0.2) {
    return Math.random() < probability;
  }

  wait(ms) {
    const variance = ms * 0.1;
    const actualMs = ms + (Math.random() - 0.5) * variance;
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, actualMs)));
  }

  getSessionViewport() {
    return {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
  }

  async setupStealthMode(page) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };

      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);

      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    await page.setViewport(this.getSessionViewport());
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });
  }
}

module.exports = StealthFeatures;
