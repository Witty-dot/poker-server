// js/lobby.js
import { SoundManager, SOUND_EVENTS } from './soundManager.js';

// Один общий инстанс звука для лобби
const sound = new SoundManager({
  basePath: '/sound',
  profile: 'normal',
  masterVolume: 1.0,
});

// Разогрев по первому пользовательскому действию (обязательно для iOS/мобилок)
let soundWarmupDone = false;

function warmupSounds() {
  if (soundWarmupDone) return;
  soundWarmupDone = true;
  sound.unlock();
  sound.preloadAll();
}

document.addEventListener('pointerdown', warmupSounds, { once: true });

// ========================================
//  Состояние фильтров / сортировки
// ========================================

const state = {
  limit: 'all',         // all | micro | low | mid | high
  size: 'all',          // all | 6max | 9max
  onlyFree: false,
  onlyFast: false,
  sortBy: 'stakes',     // name | stakes | players | avgPot | hph
  sortDir: 'asc'
};

// ========================================
//  Данные лобби с сервера
// ========================================

/**
 * Текущий список столов для фронта.
 * Структура близка к прежнему MOCK_TABLES:
 * {
 *   id,            // tableId или синтетический id виртуального слота
 *   limitId,
 *   name,
 *   stakesSB,
 *   stakesBB,
 *   currency,
 *   maxPlayers,
 *   seated,
 *   avgPot,
 *   handsPerHour,
 *   speed,
 *   waitlist,
 *   isVip,
 *   isVirtual      // true для пустого слота "создать стол"
 * }
 */
let currentTables = [];

// ========================================
//  Утилиты
// ========================================

function formatChips(v) {
  return (Number(v) || 0).toLocaleString('ru-RU');
}

function stakesToLimitBand(bb) {
  if (bb <= 4) return 'micro';
  if (bb <= 20) return 'low';
  if (bb <= 100) return 'mid';
  return 'high';
}

// Преобразуем /api/lobby → currentTables
function buildTablesFromApi(apiData) {
  if (!Array.isArray(apiData)) return [];

  const res = [];

  apiData.forEach(limit => {
    const {
      limitId,
      name,
      smallBlind,
      bigBlind,
      tables,
      hasEmptyPlaceholder
    } = limit;

    const currency   = 'MBC';
    const maxPlayers = 6;
    const speed      = 'normal';
    const isVip      = false;

    // Реальные столы
    (tables || []).forEach((t, idx) => {
      res.push({
        id: t.tableId,
        limitId,
        name: `${name} #${idx + 1}`,
        stakesSB: smallBlind,
        stakesBB: bigBlind,
        currency,
        maxPlayers,
        seated: t.players,
        avgPot: 0,
        handsPerHour: 0,
        speed,
        waitlist: 0,
        isVip,
        isVirtual: false,
        stage: t.stage || 'waiting',
        status: t.status || 'playing'
      });
    });

    // Виртуальный слот "создать новый стол", если ещё можно
    if (hasEmptyPlaceholder) {
      const virtualId = `${limitId}#new`;
      res.push({
        id: virtualId,
        limitId,
        name: `${name} · новый стол`,
        stakesSB: smallBlind,
        stakesBB: bigBlind,
        currency,
        maxPlayers,
        seated: 0,
        avgPot: 0,
        handsPerHour: 0,
        speed,
        waitlist: 0,
        isVip,
        isVirtual: true,
        stage: 'waiting',
        status: 'empty'
      });
    }
  });

  return res;
}

// Загружаем /api/lobby
async function fetchLobbySnapshot() {
  try {
    const res = await fetch('/api/lobby', { cache: 'no-store' });
    if (!res.ok) {
      console.error('[lobby] /api/lobby failed', res.status);
      return;
    }
    const data = await res.json();
    currentTables = buildTablesFromApi(data);
  } catch (e) {
    console.error('[lobby] fetchLobbySnapshot error', e);
  }
}

// ========================================
//  Фильтрация и сортировка
// ========================================

function getFilteredTables() {
  let list = [...currentTables];

  // лимит (по BB)
  if (state.limit !== 'all') {
    list = list.filter(t => stakesToLimitBand(t.stakesBB) === state.limit);
  }

  // размер стола (когда появятся 9-max — просто подставим реальные данные)
  if (state.size === '6max') {
    list = list.filter(t => t.maxPlayers <= 6);
  } else if (state.size === '9max') {
    list = list.filter(t => t.maxPlayers >= 7);
  }

  // только свободные места
  if (state.onlyFree) {
    list = list.filter(t => t.seated < t.maxPlayers || t.isVirtual);
  }

  // только fast (когда появятся fast-столы)
  if (state.onlyFast) {
    list = list.filter(t => t.speed === 'fast');
  }

  // сортировка
  const dir = state.sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    let va, vb;
    switch (state.sortBy) {
      case 'name':
        va = a.name; vb = b.name;
        return va.localeCompare(vb) * dir;
      case 'stakes':
        va = a.stakesBB; vb = b.stakesBB;
        break;
      case 'players':
        // виртуальный слот считаем пустым
        va = a.isVirtual ? 0 : a.seated / a.maxPlayers;
        vb = b.isVirtual ? 0 : b.seated / b.maxPlayers;
        break;
      case 'avgPot':
        va = a.avgPot; vb = b.avgPot;
        break;
      case 'hph':
        va = a.handsPerHour; vb = b.handsPerHour;
        break;
      default:
        va = 0; vb = 0;
    }
    return (va - vb) * dir;
  });

  return list;
}

// ========================================
//  Рендер
// ========================================

const rowsContainer  = document.getElementById('tableRows');
const tablesCountEl  = document.getElementById('tablesCount');
const playersCountEl = document.getElementById('playersCount');

function renderLobby() {
  const tables = getFilteredTables();

  // шапка (количество)
  const totalPlayers = tables
    .filter(t => !t.isVirtual)
    .reduce((s, t) => s + t.seated, 0);

  if (tablesCountEl)  tablesCountEl.textContent  = `${tables.length} столов`;
  if (playersCountEl) playersCountEl.textContent = `${totalPlayers} игроков онлайн`;

  if (!rowsContainer) return;

  rowsContainer.innerHTML = '';
  if (!tables.length) {
    const empty = document.createElement('div');
    empty.style.padding = '10px';
    empty.style.fontSize = '12px';
    empty.style.color = '#9a9aad';
    empty.textContent = 'Нет столов, подходящих под выбранные фильтры.';
    rowsContainer.appendChild(empty);
    return;
  }

  tables.forEach(table => {
    const row = document.createElement('div');
    row.className = 'table-row';

    const freeSeats = table.maxPlayers - table.seated;
    const fillPercent = table.isVirtual
      ? 0
      : Math.max(0, Math.min(100, (table.seated / table.maxPlayers) * 100));

    // 1. Имя стола + теги
    const cName = document.createElement('div');
    cName.innerHTML = `
      <div class="table-name-main">${table.name}</div>
      <div class="table-name-sub">
        ${table.maxPlayers}-max · ${
          table.speed === 'fast' ? 'Fast' : 'Regular'
        }${table.isVip ? ' · VIP' : ''}
      </div>
    `;

    // 2. Лимит
    const cStakes = document.createElement('div');
    cStakes.className = 'limit-text';
    cStakes.textContent = `NL ${table.stakesSB}/${table.stakesBB} ${table.currency}`;

    // 3. Игроки
    const cPlayers = document.createElement('div');
    cPlayers.className = 'players-cell';
    if (table.isVirtual) {
      cPlayers.innerHTML = `
        <span>—</span>
        <div class="players-bar">
          <div class="players-fill" style="width:0%"></div>
        </div>
      `;
    } else {
      cPlayers.innerHTML = `
        <span>${table.seated}/${table.maxPlayers}</span>
        <div class="players-bar">
          <div class="players-fill" style="width:${fillPercent}%"></div>
        </div>
      `;
    }

    // 4. Средний банк — пока ноль, потом подставим реальные
    const cAvg = document.createElement('div');
    cAvg.textContent = `${formatChips(table.avgPot)} ${table.currency}`;

    // 5. Руки/час + теги
    const cHph = document.createElement('div');
    const tags = [];
    if (table.speed === 'fast') tags.push('<span class="tag tag-fast">Fast</span>');
    if (table.isVip)           tags.push('<span class="tag tag-vip">VIP</span>');
    cHph.innerHTML = `
      <span class="nowrap">${table.handsPerHour || 0} рук/час</span>
      ${tags.length ? ' · ' + tags.join(' ') : ''}
    `;

    // 6. Кнопка
    const cAction = document.createElement('div');
    const btn = document.createElement('button');
    btn.className = 'btn-seat';

    if (table.isVirtual) {
      btn.textContent = 'Создать стол';
    } else if (freeSeats <= 0) {
      btn.classList.add('btn-seat-full');
      btn.textContent = table.waitlist > 0
        ? `Ожидание (${table.waitlist})`
        : 'Сесть в лист ожидания';
    } else {
      btn.textContent = 'Сесть за стол';
    }

    btn.addEventListener('click', () => {
      sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);
      openTable(table);
    });
    cAction.appendChild(btn);

    row.appendChild(cName);
    row.appendChild(cStakes);
    row.appendChild(cPlayers);
    row.appendChild(cAvg);
    row.appendChild(cHph);
    row.appendChild(cAction);

    rowsContainer.appendChild(row);
  });
}

// ========================================
//  Открытие стола
// ========================================

async function openTable(table) {
  // Виртуальный слот → сначала создаём стол на сервере
  if (table.isVirtual) {
    try {
      const res = await fetch('/api/create-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limitId: table.limitId })
      });

      if (!res.ok) {
        console.error('[lobby] /api/create-table failed', res.status);
        sound.play(SOUND_EVENTS.UI_ERROR_SOFT);
        alert('Не удалось создать стол. Попробуйте ещё раз.');
        return;
      }

      const data = await res.json();
      if (!data.tableId) {
        sound.play(SOUND_EVENTS.UI_ERROR_SOFT);
        alert('Сервер не вернул идентификатор стола.');
        return;
      }

      const url = `/table.html?tableId=${encodeURIComponent(data.tableId)}`;
      window.location.href = url;
      return;
    } catch (e) {
      console.error('[lobby] openTable virtual error', e);
      sound.play(SOUND_EVENTS.UI_ERROR_SOFT);
      alert('Ошибка при создании стола.');
      return;
    }
  }

  // Обычный стол → переходим по tableId, чтобы гарантированно сесть именно за него
  const params = new URLSearchParams();
  if (table.id) {
    params.set('tableId', table.id);
  } else if (table.limitId) {
    // запасной вариант: только по лимиту
    params.set('limitId', table.limitId);
  }

  const url = `/table.html?${params.toString()}`;
  window.location.href = url;
}

// Быстрая посадка — выбираем лучший стол по текущим фильтрам
function quickSeat() {
  const tables = getFilteredTables()
    .filter(t => t.isVirtual || t.seated < t.maxPlayers);

  if (!tables.length) {
    sound.play(SOUND_EVENTS.UI_ERROR_SOFT);
    alert('Нет столов с свободными местами под текущие фильтры.');
    return;
  }

  // Сортируем по заполненности (виртуальный слот — самый пустой)
  tables.sort((a, b) => {
    const aFill = a.isVirtual ? 0 : a.seated / a.maxPlayers;
    const bFill = b.isVirtual ? 0 : b.seated / b.maxPlayers;
    const aScore = Math.abs(aFill - 0.7);
    const bScore = Math.abs(bFill - 0.7);
    if (aScore !== bScore) return aScore - bScore;
    // если одинаково — по лимиту (повыше сначала)
    return b.stakesBB - a.stakesBB;
  });

  sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);
  openTable(tables[0]);
}

// ========================================
//  Привязка UI
// ========================================

function wireFilters() {
  // лимиты
  document.querySelectorAll('[data-limit]').forEach(btn => {
    btn.addEventListener('click', () => {
      sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);
      const val = btn.getAttribute('data-limit');
      state.limit = val;

      document.querySelectorAll('[data-limit]').forEach(x => x.classList.remove('chip-active'));
      btn.classList.add('chip-active');

      renderLobby();
    });
  });

  // размер стола
  document.querySelectorAll('[data-size]').forEach(btn => {
    btn.addEventListener('click', () => {
      sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);
      const val = btn.getAttribute('data-size');
      state.size = val;

      document.querySelectorAll('[data-size]').forEach(x => x.classList.remove('chip-active'));
      btn.classList.add('chip-active');

      renderLobby();
    });
  });

  // чекбоксы-фильтры
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);
      const key = btn.getAttribute('data-filter');
      if (key === 'only-free') {
        state.onlyFree = !state.onlyFree;
      } else if (key === 'fast') {
        state.onlyFast = !state.onlyFast;
      }
      btn.classList.toggle('chip-active');
      renderLobby();
    });
  });

  // сортировка по заголовкам
  document.querySelectorAll('.table-list-header div[data-sort]').forEach(header => {
    header.addEventListener('click', () => {
      sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);
      const sortKey = header.getAttribute('data-sort');
      if (state.sortBy === sortKey) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortBy = sortKey;
        state.sortDir = sortKey === 'name' ? 'asc' : 'desc';
      }

      const arrows = document.querySelectorAll('[data-sort-arrow]');
      arrows.forEach(a => a.textContent = '▲');
      const currentArrow = document.querySelector(`[data-sort-arrow="${sortKey}"]`);
      if (currentArrow) {
        currentArrow.textContent = state.sortDir === 'asc' ? '▲' : '▼';
      }

      renderLobby();
    });
  });

  const quickSeatBtn = document.getElementById('btnQuickSeat');
  if (quickSeatBtn) {
    quickSeatBtn.addEventListener('click', () => {
      sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);
      quickSeat();
    });
  }
}

// старт
async function initLobby() {
  await fetchLobbySnapshot();    // первый снимок
  wireFilters();
  renderLobby();

  // периодический авто-обновлятор лобби (можно подкрутить интервал)
  setInterval(async () => {
    await fetchLobbySnapshot();
    renderLobby();
  }, 5000);
}

initLobby();
