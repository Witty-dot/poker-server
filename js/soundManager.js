// js/soundManager.js
// ===============================
//  SoundManager с пулом HTMLAudio-клонов
// ===============================

// 1. Карта событий
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

// 2. Маппинг событий -> файлов
export const SOUND_DEFS = {
  // UI-клики
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

  // Игровые действия (композитные – пока сведены в один wav каждый)
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
    this.profile  = options.profile || 'quiet';

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

    // Сколько инстансов на звук держим в пуле
    this.poolSize = options.poolSize || 4;

    // Web Audio выключен, форсим HTMLAudio
    this.useHtmlAudioFallback = true;
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

  // ========= ПРЕДЗАГРУЗКА =========

  async preloadAll() {
    const urls = [];

    Object.keys(SOUND_DEFS).forEach((eventName) => {
      const url = this._resolveUrl(eventName);
      if (!url) return;
      urls.push(url);
    });

    await Promise.all(
      urls.map((url) => this._ensurePoolForUrl(url))
    );
  }

  async _ensurePoolForUrl(url) {
    // уже есть пул
    if (this.htmlAudioCache.has(url)) return;

    const pool = [];
    for (let i = 0; i < this.poolSize; i++) {
      const audio = new Audio(url);
      audio.preload = 'auto';
      pool.push(audio);
    }

    this.htmlAudioCache.set(url, pool);

    // дождаться, пока хотя бы один сможет играть
    await new Promise((resolve) => {
      let resolved = false;
      pool.forEach(a => {
        a.addEventListener('canplaythrough', () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, { once: true });
        a.addEventListener('error', () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, { once: true });
      });
      // если вообще не придёт ни один ивент — всё равно не зависаем
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 3000);
    });
  }

  // iOS unlock – для HTMLAudio почти не нужен
  async unlock() {
    // ничего не делаем, главное – play() вызывать из обработчика клика
    return;
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

    let pool = this.htmlAudioCache.get(url);

    // если пул ещё не создан (например, preloadAll не успели) — создаём на лету
    if (!pool) {
      pool = [new Audio(url)];
      pool[0].preload = 'auto';
      this.htmlAudioCache.set(url, pool);
    }

    // ищем свободный инстанс
    let audio = pool.find(a => a.paused || a.ended);

    // если свободного нет — клонируем первый, но не раздуваем до бесконечности
    if (!audio) {
      if (pool.length < this.poolSize + 2) { // небольшой запас сверх poolSize
        const clone = pool[0].cloneNode(true);
        pool.push(clone);
        audio = clone;
      } else {
        // если даже запас забит — берём самый "старый" и жёстко переигрываем
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
