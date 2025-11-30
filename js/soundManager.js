// js/soundManager.js
// ===============================
//  Web Audio SoundManager
// ===============================

// 1. Карта событий (как и раньше)
export const SOUND_EVENTS = {
  UI_CLICK_PRIMARY: 'UI_CLICK_PRIMARY',
  UI_CLICK_SECONDARY: 'UI_CLICK_SECONDARY',
  UI_ERROR_SOFT: 'UI_ERROR_SOFT',
  UI_ERROR_HARD: 'UI_ERROR_HARD',

  FOLD: 'FOLD',
  CHECK: 'CHECK',
  CALL: 'CALL',
  BET: 'BET',
  ALLIN: 'ALLIN',

  CARD_DEAL: 'CARD_DEAL',
  CARD_BOARD: 'CARD_BOARD',
  DECK_SHUFFLE: 'DECK_SHUFFLE',
  POT_WIN: 'POT_WIN',

  TIMER_TICK: 'TIMER_TICK',
  TIMER_URGENT: 'TIMER_URGENT',
};

// 2. Какие файлы за какими событиями закреплены
export const SOUND_DEFS = {
  // UI-клики
  UI_CLICK_PRIMARY: {
    type: 'base',
    file: 'processed/base/wav/mixkit-cool-interface-click-tone-2568.wav', // можно сменить на более мягкий
    category: 'ui',
  },
  UI_CLICK_SECONDARY: {
    type: 'base',
    file: 'processed/base/wav/mixkit-interface-click-1126.wav',
    category: 'ui',
  },
  UI_ERROR_SOFT: {
    type: 'base',
    file: 'processed/base/wav/mixkit-click-error-1110.wav',
    category: 'ui',
  },
  UI_ERROR_HARD: {
    type: 'base',
    file: 'processed/base/wav/mixkit-negative-tone-interface-tap-2569.wav',
    category: 'ui',
  },

  // Игровые действия (композитные)
  FOLD:   { type: 'composite', name: 'fold',   category: 'action' },
  CHECK:  { type: 'composite', name: 'check',  category: 'action' },
  CALL:   { type: 'composite', name: 'call',   category: 'action' },
  BET:    { type: 'composite', name: 'bet',    category: 'action' },
  ALLIN:  { type: 'composite', name: 'allin',  category: 'action' },

  // Карты / фишки / таймер
  CARD_DEAL: {
    type: 'base',
    file: 'processed/base/wav/mixkit-poker-card-flick-2002.wav',
    category: 'action',
  },
  CARD_BOARD: {
    type: 'base',
    file: 'processed/base/wav/mixkit-poker-card-placement-2001.wav',
    category: 'action',
  },
  DECK_SHUFFLE: {
    type: 'base',
    file: 'processed/base/wav/mixkit-thin-metal-card-deck-shuffle-3175.wav',
    category: 'ambient',
  },
  POT_WIN: {
    type: 'base',
    file: 'processed/base/wav/mixkit-clinking-coins-1993.wav',
    category: 'action',
  },

  TIMER_TICK: {
    type: 'base',
    file: 'processed/base/wav/mixkit-tick-tock-clock-timer-1045.wav',
    category: 'ambient',
  },
  TIMER_URGENT: {
    type: 'base',
    file: 'processed/base/wav/mixkit-fast-wall-clock-ticking-1063.wav',
    category: 'ambient',
  },
};

// ===============================
//   КЛАСС МЕНЕДЖЕРА ЗВУКА
// ===============================

export class SoundManager {
  constructor(options = {}) {
    this.basePath = options.basePath || '/sound';
    this.profile  = options.profile || 'normal';

    this.masterVolume = this._clamp01(
      typeof options.masterVolume === 'number' ? options.masterVolume : 1.0
    );
    this.categoryVolumes = {
      ui: 1.0,
      action: 1.0,
      ambient: 1.0,
      ...(options.categoryVolumes || {}),
    };

    this.muted = false;

    // Web Audio
    this.audioContext = null;        // создаём лениво
    this.buffers = new Map();        // url -> AudioBuffer
    this.loading = new Map();        // url -> Promise<AudioBuffer>

    // fallback для старых браузеров
    this.useHtmlAudioFallback = !(
      typeof window !== 'undefined' &&
      (window.AudioContext || window.webkitAudioContext)
    );
    this.htmlAudioCache = new Map();
  }

  // ========= ПУБЛИЧНЫЕ НАСТРОЙКИ =========

  setProfile(profile) {
    if (profile === 'normal' || profile === 'quiet' || profile === 'loud') {
      this.profile = profile;
    }
  }

  setMasterVolume(volume) {
    this.masterVolume = this._clamp01(volume);
  }

  setCategoryVolume(category, volume) {
    if (!(category in this.categoryVolumes)) return;
    this.categoryVolumes[category] = this._clamp01(volume);
  }

  mute()  { this.muted = true;  }
  unmute(){ this.muted = false; }
  toggleMute() { this.muted = !this.muted; }

  // ========= ВНУТРЕННЕЕ =========

  _clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  _getEffectiveVolume(category) {
    const catVol = this.categoryVolumes[category] ?? 1.0;
    return this._clamp01(this.masterVolume * catVol);
  }

  _getAudioContext() {
    if (this.useHtmlAudioFallback) return null;

    if (!this.audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx();
    }
    // iOS может держать контекст в suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
    return this.audioContext;
  }

  _resolveUrl(eventName) {
    const def = SOUND_DEFS[eventName];
    if (!def) return null;

    if (def.type === 'base') {
      return `${this.basePath}/${def.file}`;
    }

    if (def.type === 'composite') {
      const profile = this.profile;
      const fileName = `${def.name}_${profile}.wav`;
      return `${this.basePath}/processed/composite/wav/${profile}/${fileName}`;
    }

    return null;
  }

  // Загрузить AudioBuffer для url (с кешем)
  async _loadBuffer(url) {
    // если уже загружаем — вернуть текущий промис
    if (this.loading.has(url)) {
      return this.loading.get(url);
    }

    const ctx = this._getAudioContext();
    if (!ctx) return null;

    const p = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        // decodeAudioData иногда требует колбэка, но промис-версия уже норм
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        this.buffers.set(url, audioBuffer);
        return audioBuffer;
      } catch (err) {
        console.warn('[SoundManager] Failed to load', url, err);
        return null;
      } finally {
        this.loading.delete(url);
      }
    })();

    this.loading.set(url, p);
    return p;
  }

  // ========= ПРЕДЗАГРУЗКА =========

  /**
   * Предзагрузка всех звуков (по текущему профилю).
   * Обязательно вызывать после первого пользовательского жеста
   * (tap/click), чтобы iOS не ругалась.
   */
  async preloadAll() {
    const urls = [];

    Object.keys(SOUND_DEFS).forEach((eventName) => {
      const url = this._resolveUrl(eventName);
      if (!url) return;
      urls.push(url);
    });

    if (this.useHtmlAudioFallback) {
      // Для fallback создаём <audio> и даём им прогрузиться
      await Promise.all(
        urls.map((url) => {
          if (this.htmlAudioCache.has(url)) return Promise.resolve();
          return new Promise((resolve) => {
            const audio = new Audio(url);
            audio.preload = 'auto';
            audio.addEventListener('canplaythrough', () => resolve(), { once: true });
            audio.addEventListener('error', () => resolve(), { once: true });
            this.htmlAudioCache.set(url, audio);
          });
        })
      );
      return;
    }

    const ctx = this._getAudioContext();
    if (!ctx) return;

    await Promise.all(
      urls.map(async (url) => {
        if (this.buffers.has(url)) return;
        const buffer = await this._loadBuffer(url);
        return buffer;
      })
    );
  }

  // Небольшой хак для iOS: “разбудить” аудио по первому тапу
  async unlock() {
    const ctx = this._getAudioContext();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (_) {}
    }

    // можно проиграть ультра-короткий тихий звук, но это опционально
  }

  // ========= ВОСПРОИЗВЕДЕНИЕ =========

  play(eventName) {
    const def = SOUND_DEFS[eventName];
    if (!def) {
      console.warn('[SoundManager] Unknown event', eventName);
      return;
    }
    if (this.muted) return;

    const url = this._resolveUrl(eventName);
    if (!url) return;

    const volume = this._getEffectiveVolume(def.category);

    // ---- Fallback через HTMLAudio, если Web Audio недоступен ----
    if (this.useHtmlAudioFallback) {
      let audio = this.htmlAudioCache.get(url);
      if (!audio) {
        audio = new Audio(url);
        audio.preload = 'auto';
        this.htmlAudioCache.set(url, audio);
      }

      try {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = volume;
        audio.play().catch(() => {});
      } catch (_) {}
      return;
    }

    // ---- Основной путь: Web Audio API ----
    const ctx = this._getAudioContext();
    if (!ctx) return;

    // если уже есть буфер — играем сразу
    const buffered = this.buffers.get(url);
    if (buffered) {
      this._playBuffer(ctx, buffered, volume);
      return;
    }

    // если ещё не загружен — подгружаем и после этого играем
    this._loadBuffer(url).then((buffer) => {
      if (!buffer) return;
      this._playBuffer(ctx, buffer, volume);
    });
  }

  _playBuffer(ctx, buffer, volume) {
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gainNode = ctx.createGain();
      gainNode.gain.value = volume;

      source.connect(gainNode).connect(ctx.destination);
      source.start(0);
    } catch (err) {
      console.warn('[SoundManager] play buffer error', err);
    }
  }
}
