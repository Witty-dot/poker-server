// lobbyManager.js

// Описание лимитов, которые должны быть в лобби
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

class LobbyManager {
  constructor() {
    this.tables = new Map(); // tableId -> tableInfo
    this.virtualCounter = 1;
    this.realCounter = 1;

    // На старте гарантируем по одному "виртуальному" столу на лимит
    LIMITS.forEach(limit => this.ensureVirtualForLimit(limit.id));
  }

  getLimits() {
    return LIMITS;
  }

  /**
   * Убедиться, что для лимита есть хотя бы один виртуальный пустой стол
   * (тот, за который ещё никто не сел).
   */
  ensureVirtualForLimit(limitId) {
    const hasVirtual = [...this.tables.values()].some(
      t => t.limitId === limitId && t.isVirtual === true
    );
    if (hasVirtual) return;

    const id = `V-${limitId}-${this.virtualCounter++}`;
    this.tables.set(id, {
      id,
      limitId,
      isVirtual: true,
      playersCount: 0,
      status: 'waiting', // waiting / playing / finished
    });
  }

  /**
   * Снимок лобби для фронта.
   * Здесь можно собрать всё, что нужно вывести в lobby.html.
   */
  getLobbySnapshot() {
    const result = [];

    for (const table of this.tables.values()) {
      const limit = LIMITS.find(l => l.id === table.limitId);
      if (!limit) continue;

      let lobbyStatus;
      if (table.isVirtual) {
        lobbyStatus = 'open';        // пустой “слот” стола
      } else if (table.playersCount === 0) {
        lobbyStatus = 'waiting';     // реальный стол, но игроков ещё нет
      } else {
        lobbyStatus = 'playing';     // за столом кто-то есть
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

    // Можно отсортировать по лимиту / id
    result.sort((a, b) => a.limitName.localeCompare(b.limitName));
    return result;
  }

  /**
   * Игрок хочет сесть за стол определённого лимита.
   * Если клик по виртуальному столу — создаём новый реальный,
   * удаляем виртуальный, и создаём ещё один виртуальный слот.
   */
  handleJoinRequest({ limitId, tableId, playerId }) {
    let table = tableId ? this.tables.get(tableId) : null;

    // Если кликнули по виртуальному или вообще без tableId → создаём реальный
    if (!table || table.isVirtual) {
      const realId = `T-${limitId}-${this.realCounter++}`;
      table = {
        id: realId,
        limitId,
        isVirtual: false,
        playersCount: 0,
        status: 'waiting',
      };
      this.tables.set(realId, table);

      // удаляем старый виртуальный слот, если был
      if (tableId && this.tables.has(tableId)) {
        this.tables.delete(tableId);
      }

      // и сразу создаём новый виртуальный слот для этого лимита
      this.ensureVirtualForLimit(limitId);
    }

    // Добавляем игрока на стол (логика количественная — без мест)
    table.playersCount += 1;
    table.status = table.playersCount > 0 ? 'playing' : 'waiting';

    return table;
  }

  /**
   * Игрок покидает стол.
   * Если стол опустел — можно либо:
   *   а) оставить его (playersCount = 0, status = waiting)
   *   б) удалить его, если он не нужен (оставив только виртуальный слот)
   *
   * Здесь я предлагаю:
   * — когда стол пустеет, мы его удаляем,
   * — в ensureVirtualForLimit всё равно есть пустой визуальный слот.
   */
  handleLeaveTable({ tableId, playerId }) {
    const table = this.tables.get(tableId);
    if (!table || table.isVirtual) return;

    table.playersCount = Math.max(0, table.playersCount - 1);

    if (table.playersCount === 0) {
      // Стол пуст – удаляем реальный
      this.tables.delete(tableId);
      // и гарантируем, что виртуальный для его лимита есть
      this.ensureVirtualForLimit(table.limitId);
    } else {
      table.status = 'playing';
    }
  }
}

module.exports = new LobbyManager();
