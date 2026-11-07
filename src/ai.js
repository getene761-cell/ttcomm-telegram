'use strict';

/**
 * Тонкий клиент OpenAI Chat Completions на нативном fetch.
 * Внешний пакет openai не нужен.
 */

class AIError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'AIError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

const LANGUAGE_NAMES = {
  ru: 'Russian',
  en: 'English',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  pt: 'Portuguese',
  it: 'Italian',
};

const BANNED_PATTERNS = [
  /\b(https?:\/\/|www\.)\S+/i,
  /\b(bot|бот[аеы]?|сервис|service|website|сайт|приложение|app|automated|автоматизац\w*)\b/i,
];

class AI {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.enabled = Boolean(config.openaiApiKey);
  }

  get model() {
    return this.config.openaiModel;
  }

  async chatJson({ system, user, temperature = 0.4, maxTokens = 700 }) {
    if (!this.enabled) {
      throw new AIError('OPENAI_API_KEY не задан');
    }

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    };

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${this.config.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.openaiApiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.openaiTimeoutMs),
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('retry-after')) || 2 ** attempt;
          throw new AIError(`OpenAI временно недоступен (${response.status})`, {
            status: response.status,
          });
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new AIError(`OpenAI ответил ${response.status}: ${text.slice(0, 300)}`, {
            status: response.status,
          });
        }

        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (!content) throw new AIError('Пустой ответ OpenAI');
        return JSON.parse(content);
      } catch (error) {
        lastError = error;
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          lastError = new AIError('Таймаут запроса к OpenAI');
        }
        const retryable = !(lastError instanceof AIError) || lastError.status === 429 || (lastError.status ?? 500) >= 500;
        if (!retryable || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }

    throw lastError instanceof AIError ? lastError : new AIError(`Ошибка OpenAI: ${lastError.message}`);
  }

  /**
   * Оценивает видео и его комментарии.
   * @returns {Promise<object|null>} null, если оценить не удалось
   */
  async analyze({ video, comments = [], details = null }) {
    if (!this.enabled) return null;

    const topComments = comments.slice(0, 15).map((c) => ({
      text: String(c.text || '').slice(0, 300),
      likes: parseLikes(c.likes),
      sentiment: quickSentiment(c.text),
    }));

    const prompt = `Video:
- Author: @${video.author}
- Description: ${String(video.description || '').slice(0, 500)}
- Likes: ${details?.counts?.likes ?? 'n/a'}
- Comments: ${details?.counts?.comments ?? 'n/a'}

Top comments:
${JSON.stringify(topComments, null, 2)}

Topic we look for: ${this.config.targetTopic}.
Analyse:
1. How relevant the video is to the topic (0..1).
2. What the comment section discusses and its sentiment.
3. Whether a helpful, non-promotional comment would fit naturally.
4. Risk of looking like spam.

Return JSON:
{
  "relevant": true/false,
  "score": 0.0-1.0,
  "reason": "short explanation",
  "category": "work|motivation|humor|career|other",
  "commentContext": {
    "mainTheme": "what people discuss",
    "sentiment": "positive|negative|mixed",
    "engagementLevel": "high|medium|low",
    "suggestedApproach": "empathy|solution|question|support"
  }
}`;

    try {
      const raw = await this.chatJson({
        system:
          'You are a careful social-media analyst. Judge relevance conservatively and return only JSON.',
        user: prompt,
        temperature: 0.2,
        maxTokens: 600,
      });
      return normalizeAnalysis(raw);
    } catch (error) {
      this.logger?.warn?.(`Анализ видео не удался: ${error.message}`);
      return null;
    }
  }

  /**
   * Генерирует комментарий. Возвращает null, если текст не прошёл проверки.
   */
  async generateComment({ video, analysis, comments = [] }) {
    if (!this.enabled) return null;

    const language = LANGUAGE_NAMES[this.config.commentLanguage] || 'English';
    const popular = comments
      .filter((c) => parseLikes(c.likes) > 10)
      .slice(0, 5);

    const prompt = `Video description: ${String(video.description || '').slice(0, 500)}
Category: ${analysis.category}
Thread theme: ${analysis.commentContext?.mainTheme || 'unknown'}
Sentiment: ${analysis.commentContext?.sentiment || 'mixed'}
Suggested approach: ${analysis.commentContext?.suggestedApproach || 'support'}
Popular comments:
${popular.map((c) => `- "${String(c.text).slice(0, 200)}" (${c.likes} likes)`).join('\n') || '- none'}

Write ONE natural comment in ${language}.
Rules:
- Match the tone of the thread, be specific to the video.
- Max 110 characters, no hashtags, no links.
- Never mention bots, automation, AI, apps, services or websites.
- No generic praise like "great video".
- Do not repeat popular comments.

Return JSON: {"comment": "...", "confidence": 0.0-1.0, "reasoning": "why it fits"}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let raw;
      try {
        raw = await this.chatJson({
          system: 'You write short, human, non-promotional social-media comments. Return only JSON.',
          user: attempt === 0 ? prompt : `${prompt}\nPrevious attempt was rejected: ${this.lastRejectReason || 'too generic'}. Write a more specific comment.`,
          temperature: 0.9,
          maxTokens: 300,
        });
      } catch (error) {
        this.logger?.warn?.(`Генерация комментария не удалась: ${error.message}`);
        return null;
      }

      const comment = String(raw?.comment || '').replace(/\s+/g, ' ').trim();
      const check = this.checkComment(comment);
      if (check.ok) {
        return {
          comment,
          confidence: clamp01(Number(raw?.confidence) || 0.5),
          reasoning: String(raw?.reasoning || ''),
        };
      }
      this.lastRejectReason = check.reason;
      this.logger?.debug?.(`Комментарий отклонён: ${check.reason}`);
    }

    return null;
  }

  checkComment(text) {
    if (!text) return { ok: false, reason: 'пустой текст' };
    if (text.length < 8) return { ok: false, reason: 'слишком короткий' };
    if (text.length > 150) return { ok: false, reason: 'слишком длинный' };
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.test(text)) return { ok: false, reason: `запрещённый фрагмент: ${pattern}` };
    }
    if (/[#@]\w+/u.test(text)) return { ok: false, reason: 'упоминания/хэштеги' };
    return { ok: true };
  }
}

function normalizeAnalysis(raw) {
  const score = clamp01(Number(raw?.score) || 0);
  const relevant = raw?.relevant === true && score > 0;
  return {
    relevant,
    score,
    reason: String(raw?.reason || ''),
    category: String(raw?.category || 'other'),
    commentContext: {
      mainTheme: String(raw?.commentContext?.mainTheme || 'unknown'),
      sentiment: String(raw?.commentContext?.sentiment || 'mixed'),
      engagementLevel: String(raw?.commentContext?.engagementLevel || 'low'),
      suggestedApproach: String(raw?.commentContext?.suggestedApproach || 'support'),
    },
  };
}

function parseLikes(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim().toUpperCase().replace(',', '.');
  const match = text.match(/([\d.]+)\s*([KМM])?/);
  if (!match) return 0;
  const number = Number(match[1]) || 0;
  const suffix = match[2];
  if (suffix === 'K' || suffix === 'К') return Math.round(number * 1000);
  if (suffix === 'M' || suffix === 'М') return Math.round(number * 1_000_000);
  return Math.round(number);
}

function quickSentiment(text) {
  const value = String(text || '');
  if (/bad|hate|worst|terrible|awful|sucks|annoying|frustrated|tired|ужас|ненавиж|бесит|достал/i.test(value)) {
    return 'negative';
  }
  if (/good|great|love|awesome|amazing|best|perfect|excellent|happy|класс|круто|люблю|супер/i.test(value)) {
    return 'positive';
  }
  return 'neutral';
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

module.exports = { AI, AIError, parseLikes, quickSentiment };
