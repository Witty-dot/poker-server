// lobbyManager.js

// Лимиты, которые должны быть в лобби
const LIMITS = [
  // MICRO
  { id: 'NL1-2',      smallBlind: 1,    bigBlind: 2 },
  { id: 'NL2-5',      smallBlind: 2,    bigBlind: 5 },
  { id: 'NL5-10',     smallBlind: 5,    bigBlind: 10 },
  { id: 'NL10-20',    smallBlind: 10,   bigBlind: 20 },

  // LOW
  { id: 'NL25-50',    smallBlind: 25,   bigBlind: 50 },
  { id: 'NL50-100',   smallBlind: 50,   bigBlind: 100 },

  // MID
  { id: 'NL100-200',  smallBlind: 100,  bigBlind: 200 },
  { id: 'NL200-400',  smallBlind: 200,  bigBlind: 400 },
  { id: 'NL500-1000', smallBlind: 500,  bigBlind: 1000 },

  // HIGH
  { id: 'NL1K-2K',    smallBlind: 1000, bigBlind: 2000 },
  { id: 'NL2K-4K',    smallBlind: 2000, bigBlind: 4000 },
  { id: 'NL5K-10K',   smallBlind: 5000, bigBlind: 10000 },

  // NOSEBLEED
  { id: 'NL10K-20K',  smallBlind: 10000, bigBlind: 20000 },
  { id: 'NL20K-40K',  smallBlind: 20000, bigBlind: 40000 },
];

// Максимальное количество РЕАЛЬНЫХ столов на один лимит
const MAX_REAL_TABLES_PER_LIMIT = 6;

class LobbyManager {
  constructor() {
    // tableId -> tableInfo
    // tableInfo: { id, limitId, isVirtual, playersCount, status }
    this.tables = new Map();

    this.virtualCounter = 1;
    this.realCounter = 1;

    // На старте: по одному виртуальному слоту на каждый лимит
    LIMITS.forEach(limit => {
      this._normalizeLimitState(limit.id);
    });
  }

  getLimits() {
    return LIMITS;
  }

  // ==========================
  // ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
  // ==========================

  _getLimitConfig(limitId) {
    return LIMITS.find(l => l.id === limitId) || null;
  }

  _getByLimit(limitId) {
    const real = [];
    const virtual = [];

    for (const table of this.tables.values()) {
      if (table.limitId !== limitId) continue;
      if (table.isVirtual) virtual.push(table);
      else real.push(table);
    }

    return { real, virtual };
  }

  _createVirtual(limitId) {
    const id = `V-${limitId}-${this.virtualCounter++}`;
    const table = {
      id,
      limitId,
      isVirtual: true,
      playersCount: 0,
      status: 'open', // "слот" для нового стола
    };
    this.tables.set(id, table);
    return table;
  }

  _createReal(limitId) {
    const id = `T-${limitId}-${this.realCounter++}`;
    const table = {
      id,
      limitId,
      isVirtual: false,
      playersCount: 0,
      status: 'waiting', // пока без игроков
    };
    this.tables.set(id, table);
    return table;
  }

  /**
   * Нормализуем состояние для лимита:
   * - если нет реальных столов → держим ровно 1 виртуальный слот
   * - если есть хотя бы один реальный стол → тоже держим ровно 1 виртуальный слот
   * - лишние виртуальные/пустые ссылки убираем
   */
  _normalizeLimitState(limitId) {
    const { real, virtual } = this._getByLimit(limitId);

    // Удаляем "битые" реальные столы без игроков, если вдруг остались
    for (const t of real) {
      if (t.playersCount <= 0) {
        this.tables.delete(t.id);
      }
    }

    const updated = this._getByLimit(limitId);
    const realNow = updated.real;
    const virtualNow = updated.virtual;

    // Сколько виртуальных слотов нам нужно?
    // Логика: всегда ровно ОДИН виртуальный слот на лимит, вне зависимости от того,
    // есть реальный стол или нет. Он отвечает требованиям:
    // - "когда никого нет" → одна кнопка
    // - "когда кто-то уже играет" → один слот для следующего стола
    const neededVirtual = 1;

    // Если виртуалов больше нужного — удаляем лишние
    if (virtualNow.length > neededVirtual) {
      // оставляем первый, остальные удаляем
      for (let i = neededVirtual; i < virtualNow.length; i++) {
        this.tables.delete(virtualNow[i].id);
      }
    }

    // Если виртуалов меньше нужного — досоздаём
    if (virtualNow.length < neededVirtual) {
      this._createVirtual(limitId);
    }
  }

  // ==========================
  //  ПУБЛИЧНЫЕ МЕТОДЫ
  // ==========================

  /**
   * Снимок лобби для фронта.
   * Здесь собираем всё, что фронт будет рисовать в lobby.html
   */
  getLobbySnapshot() {
    const result = [];

    for (const table of this.tables.values()) {
      const limit = this._getLimitConfig(table.limitId);
      if (!limit) continue;

      let lobbyStatus;
      if (table.isVirtual) {
        lobbyStatus = 'open'; // пустой слот
      } else if (table.playersCount === 0) {
        lobbyStatus = 'waiting';
      } else {
        lobbyStatus = 'playing';
      }

      result.push({
        id: table.id,
        limitId: table.limitId,
        limitName: limit.name,
        smallBlind: limit.smallBlind,
        bigBlind: limit.bigBlind,

        playersCount: table.playersCount,
        status: lobbyStatus,
        isVirtual: table.isVirtual,
      });
    }

    // отсортируем по лимиту/ID
    result.sort((a, b) => {
      if (a.limitName === b.limitName) {
        return a.id.localeCompare(b.id);
      }
      return a.limitName.localeCompare(b.limitName);
    });

    return result;
  }

  /**
   * Игрок хочет сесть за стол определённого лимита.
   *
   * Варианты:
   *  - клик по виртуальному слоту → создаём новый реальный стол, сажаем туда игрока,
   *    затем нормализуем (будет ещё один слот).
   *  - клик по конкретному реальному столу → просто добавляем игрока.
   *
   * Ограничение: не создаём больше MAX_REAL_TABLES_PER_LIMIT реальных столов на лимит.
   */
  handleJoinRequest({ limitId, tableId, playerId }) {
    if (!limitId) {
      throw new Error('limitId is required');
    }

    const limitCfg = this._getLimitConfig(limitId);
    if (!limitCfg) {
      throw new Error(`Unknown limitId: ${limitId}`);
    }

    let table = tableId ? this.tables.get(tableId) : null;

    const { real, virtual } = this._getByLimit(limitId);
    const realCount = real.length;

    const clickedVirtual = table && table.isVirtual;

    // Если:
    //  - не передали tableId, или
    //  - передали, но это виртуальный слот
    // тогда решаем, создавать ли новый реальный стол
    if (!table || clickedVirtual) {
      // 1) если лимит по количеству реальных столов ещё не выбран —
      //    можем создать новый реальный стол
      if (realCount < MAX_REAL_TABLES_PER_LIMIT) {
        const newReal = this._createReal(limitId);
        table = newReal;

        // если клик был по виртуальному — этот слот можно удалить,
        // _normalizeLimitState потом создаст новый при необходимости
        if (clickedVirtual) {
          this.tables.delete(tableId);
        }
      } else {
        // 2) лимит реальных столов исчерпан:
        //    пробуем посадить игрока на уже существующий стол
        if (real.length === 0) {
          // странный кейс, но на всякий — просто откажем
          return { error: 'MAX_TABLES_LIMIT_REACHED' };
        }

        // выбираем стол с наименьшим количеством игроков
        table = real.reduce((best, t) =>
          t.playersCount < best.playersCount ? t : best,
        real[0]);
      }
    }

    // На этом этапе table — реальный стол
    if (!table || table.isVirtual) {
      return { error: 'TABLE_NOT_AVAILABLE' };
    }

    table.playersCount += 1;
    table.status = table.playersCount > 0 ? 'playing' : 'waiting';

    // Нормализуем: чтобы было не больше одного виртуального слота
    this._normalizeLimitState(limitId);

    return { table };
  }

  /**
   * Игрок покидает стол.
   * Если стол опустел:
   *  - реальный стол удаляем,
   *  - нормализуем состояние лимита:
   *      * если нет реальных столов → оставляем один виртуальный слот;
   *      * если есть играющие → тоже один виртуальный слот.
   */
  handleLeaveTable({ tableId, playerId }) {
    const table = this.tables.get(tableId);
    if (!table || table.isVirtual) return;

    const limitId = table.limitId;

    table.playersCount = Math.max(0, table.playersCount - 1);

    if (table.playersCount === 0) {
      // "Если ноль человек за столом — стола не существует"
      this.tables.delete(tableId);
    } else {
      table.status = 'playing';
    }

    // Чистим лишние пустые / слот оставляем один
    this._normalizeLimitState(limitId);
  }
}

module.exports = new LobbyManager();
