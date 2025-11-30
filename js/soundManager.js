// js/soundManager.js

// 1. Константы событий (чтобы не писать строки руками)
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

// 2. Описание, какой звук к какому событию привязан
//   profile: используется только для композитных (fold/call/bet/allin/check)
//   base: одиночные wav из processed/base/wav
export const SOUND_DEFS = {
  // UI
  UI_CLICK_PRIMARY: {
    type: 'base',
    file: 'processed/base/wav/mixkit-select-click-1109.wav',
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

  // Игровые действия (композитные, с профилями громкости)
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

/**
 * Простой аудио-менеджер для браузера
 * - preloadAll() прогревает звуки
 * - play(eventName) проигрывает
 * - mute/unmute, setMasterVolume, setProfile(normal/quiet/loud)
 */
export class SoundManager {
  constructor(options = {}) {
    // Базовый путь к /sound
    this.basePath = options.basePath || '/sound';

    // Профиль громкости композитных звуков (normal / quiet / loud)
    this.profile = options.profile || 'normal';

    // Громкости
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

    // Кэш Audio-объектов (по финальному URL)
    this.audioCache = new Map();
  }

  setProfile(profile) {
    if (profile === 'normal' || profile === 'quiet' || profile === 'loud') {
      this.profile = profile;
    } else {
      console.warn('[SoundManager] Unknown profile:', profile);
    }
  }

  setMasterVolume(volume) {
    this.masterVolume = this._clamp01(volume);
  }

  setCategoryVolume(category, volume) {
    if (!(category in this.categoryVolumes)) return;
    this.categoryVolumes[category] = this._clamp01(volume);
  }

  mute() {
    this.muted = true;
  }

  unmute() {
    this.muted = false;
  }

  toggleMute() {
    this.muted = !this.muted;
  }

  _clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  // Посчитать итоговую громкость (master * category)
  _getEffectiveVolume(category) {
    const catVol = this.categoryVolumes[category] ?? 1.0;
    return this.masterVolume * catVol;
  }

  // Получить URL к файлу по событию
  _resolveUrl(eventName) {
    const def = SOUND_DEFS[eventName];
    if (!def) {
      console.warn('[SoundManager] No sound def for', eventName);
      return null;
    }

    if (def.type === 'base') {
      // /sound/processed/base/wav/имя.wav
      return `${this.basePath}/${def.file}`;
    }

    if (def.type === 'composite') {
      // /sound/processed/composite/wav/normal/fold_normal.wav
      const profile = this.profile;
      const fileName = `${def.name}_${profile}.wav`;
      return `${this.basePath}/processed/composite/wav/${profile}/${fileName}`;
    }

    console.warn('[SoundManager] Unknown sound type for', eventName);
    return null;
  }

  // Предзагрузка всех звуков (по текущему профилю)
  preloadAll() {
    const promises = [];

    Object.keys(SOUND_DEFS).forEach((eventName) => {
      const url = this._resolveUrl(eventName);
      if (!url) return;

      if (this.audioCache.has(url)) return;

      const audio = new Audio(url);
      this.audioCache.set(url, audio);

      const p = new Promise((resolve) => {
        audio.addEventListener('canplaythrough', () => resolve(), { once: true });
        audio.addEventListener(
          'error',
          () => {
            console.warn('[SoundManager] Error preloading', url);
            resolve();
          },
          { once: true }
        );
      });

      promises.push(p);
    });

    return Promise.all(promises);
  }

  // Проиграть звук события
  play(eventName) {
    const def = SOUND_DEFS[eventName];
    if (!def) {
      console.warn('[SoundManager] Unknown sound event', eventName);
      return;
    }

    if (this.muted) return;

    const url = this._resolveUrl(eventName);
    if (!url) return;

    let audio = this.audioCache.get(url);

    // Если не предзагружали — создаём на лету
    if (!audio) {
      audio = new Audio(url);
      this.audioCache.set(url, audio);
    }

    // Клонируем, чтобы можно было накладывать одинаковый звук несколько раз подряд
    const instance = audio.cloneNode(true);

    const volume = this._getEffectiveVolume(def.category);
    instance.volume = this._clamp01(volume);

    instance.currentTime = 0;
    instance.play().catch(() => {
      // браузер может блокировать без жеста пользователя — игнорируем
    });
  }
}
