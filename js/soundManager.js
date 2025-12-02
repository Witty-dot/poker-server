// js/soundManager.js
// ===============================
//  SoundManager с пулом HTMLAudio и контролем готовности
// ===============================

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
  RAISE: 'RAISE',
  
  CARD_DEAL: 'CARD_DEAL',
  CARD_BOARD: 'CARD_BOARD',
  DECK_SHUFFLE: 'DECK_SHUFFLE',
  POT_WIN: 'POT_WIN',

  TIMER_TICK: 'TIMER_TICK',
  TIMER_URGENT: 'TIMER_URGENT',
};

export const SOUND_DEFS = {
  // --- UI ---
  UI_CLICK_PRIMARY: {
    type: 'base',
    file: 'processed/base/wav/mixkit-cool-interface-click-tone-2568.wav',
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

  // --- Аctions (игровые) ---
  FOLD: {
    type: 'base',
    file: 'processed/base/wav/fold.wav',      // скидываем карты
    category: 'action',
  },
  CHECK: {
    type: 'base',
    file: 'processed/base/wav/check.wav', // двойной стук по столу
    category: 'action',
  },
  CALL: {
    type: 'base',
    file: 'processed/base/wav/call.wav', // мягкий, небольшая кучка фишек
    category: 'action',
  },
  BET: {
    type: 'base',
    file: 'processed/base/wav/bet.wav', // более тяжёлый стэк на стол
    category: 'action',
  },
  RAISE: {
    type: 'base',
    file: 'processed/base/wav/raise.wav', // “всё на стол”i
    category: 'action',
  },
  ALLIN: {
    type: 'base',
    file: 'processed/base/wav/raise.wav', // “всё на стол”i
    category: 'action',
  },
  // --- Карты/банк ---
  CARD_DEAL: {
    type: 'base',
    file: 'processed/base/wav/card_deal.wav',       // раздача карманок
    category: 'action',
  },
  CARD_BOARD: {
    type: 'base',
    file: 'processed/base/wav/card_board.wav',      // выкладывание на борд
    category: 'action',
  },
  DECK_SHUFFLE: {
    type: 'base',
    file: 'processed/base/wav/fx_deck_shuffle.wav',    // перемешивание перед раздачей
    category: 'ambient',
  },
  POT_WIN: {
    type: 'base',
    file: 'processed/base/wav/fx_pot_move_chips.wav',  // передвигаем стэк к игроку
    category: 'action',
  },

  // --- Таймер ---
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

    // Пул HTMLAudio: Map<url, Audio[]>
    this.htmlAudioCache = new Map();
    // Какие URL уже готовы к проигрыванию (canplaythrough был)
    this.readyUrls = new Set();

    // Сколько инстансов на звук держим в пуле
    this.poolSize = options.poolSize || 4;

    // Web Audio выключен – всегда HTMLAudio
    this.useHtmlAudioFallback = true;
  }

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

  _clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  _getEffectiveVolume(category) {
    const catVol = this.categoryVolumes[category] ?? 1.0;
    return this._clamp01(this.masterVolume * catVol);
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

  async preloadAll() {
    const urls = [];

    Object.keys(SOUND_DEFS).forEach((eventName) => {
      const url = this._resolveUrl(eventName);
      if (!url) return;
      urls.push(url);
    });

    await Promise.all(urls.map((url) => this._ensurePoolForUrl(url)));
  }

  async _ensurePoolForUrl(url) {
    if (this.htmlAudioCache.has(url)) return;

    const pool = [];
    for (let i = 0; i < this.poolSize; i++) {
      const audio = new Audio(url);
      audio.preload = 'auto';
      pool.push(audio);
    }
    this.htmlAudioCache.set(url, pool);

    await new Promise((resolve) => {
      let resolved = false;

      const markReady = () => {
        if (!resolved) {
          resolved = true;
          this.readyUrls.add(url);
          resolve();
        }
      };

      pool.forEach(a => {
        a.addEventListener('canplaythrough', markReady, { once: true });
        a.addEventListener('error', () => {
          console.warn('[SoundManager] preload error', url);
          markReady();
        }, { once: true });
      });

      setTimeout(markReady, 3000);
    });
  }

  async unlock() {
    // для HTMLAudio ничего не делаем, главное — вызов play() из user gesture
    return;
  }

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

    let pool = this.htmlAudioCache.get(url);

    // если пула ещё нет – создаём, но пока НЕ считаем url готовым
    if (!pool) {
      pool = [new Audio(url)];
      pool[0].preload = 'auto';
      this.htmlAudioCache.set(url, pool);

      // подписываемся на canplaythrough, чтобы отметить готовность
      const audio = pool[0];
      audio.addEventListener('canplaythrough', () => {
        this.readyUrls.add(url);
      }, { once: true });
      audio.addEventListener('error', () => {
        console.warn('[SoundManager] load error', url);
        this.readyUrls.add(url); // чтобы не висеть вечно
      }, { once: true });
    }

    // Если звук ещё не готов – просто игнорируем (НЕ накапливаем очередь)
    if (!this.readyUrls.has(url)) {
      return;
    }

    // ищем свободный инстанс
    let audio = pool.find(a => a.paused || a.ended);

    if (!audio) {
      if (pool.length < this.poolSize + 2) {
        const clone = pool[0].cloneNode(true);
        pool.push(clone);
        audio = clone;
      } else {
        audio = pool[0];
      }
    }

    try {
      audio.currentTime = 0;
      audio.volume = volume;
      audio.play().catch(() => {});
    } catch (e) {
      console.warn('[SoundManager] HTMLAudio play error', e);
    }
  }
}
