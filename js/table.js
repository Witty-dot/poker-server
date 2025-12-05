// =====================================================================
// ===============   TABLE.JS — логика стола + звук   ==================
// =====================================================================

import { SoundManager, SOUND_EVENTS } from './soundManager.js';

// -----------------------------------------------------
//  Query-параметры (tableId/limitId)
// -----------------------------------------------------

function getQueryParam(name) {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

const tableIdFromUrl = getQueryParam('tableId') || null;
// На будущее под лимиты; серверу можно уже сейчас отправлять, он просто проигнорит
const limitIdFromUrl = getQueryParam('limitId') || 'nl_10_20';

// -----------------------------------------------------
//  Socket.io подключение
// -----------------------------------------------------

const socket = io({
  transports: ['websocket', 'polling'],
  query: {
    tableId: tableIdFromUrl || '',
    limitId: limitIdFromUrl || ''
  }
});

let myPlayerId = null;
let lastState = null;
let turnTimerInterval = null;
let lastSeenLogMessage = null;
let lastSeenDealerDetails = null;
let lastHeroMessage = null;

let heroFlipTimeout = null;
let heroFlipInProgress = false;

// =====================================================================
// ===============   SOUND MANAGER ДЛЯ СТОЛА   ==========================
// =====================================================================

const sound = new SoundManager({
  basePath: '/sound',
  profile: 'normal',
  masterVolume: 1.0
});

let soundWarmupDone = false;

function warmupSounds() {
  if (soundWarmupDone) return;
  soundWarmupDone = true;
  sound.unlock();
  sound.preloadAll();
}

// Первый любой тап/клик — разогрев звука (iOS и мобилки)
document.addEventListener('pointerdown', warmupSounds, { once: true });

// =====================================================================
// ===============   DOM CACHE   =======================================
// =====================================================================

const seatEls          = Array.from(document.querySelectorAll('.seat'));
const dealerChipEl     = document.getElementById('dealerChip');
const dealerSlotEls    = Array.from(document.querySelectorAll('.dealer-slot'));

const tableEl          = document.getElementById('table');

const potEl            = document.getElementById('pot');
const potValueEl       = potEl ? potEl.querySelector('span') : null;
const boardEl          = document.getElementById('board');
const sidePotsEl       = document.getElementById('sidePots');

const heroNameEl       = document.getElementById('heroName');
const heroStackEl      = document.getElementById('heroStack');
const heroCardsSlots   = Array.from(document.querySelectorAll('.hero-card-slot'));
const heroLastActionEl = document.getElementById('heroLastAction');
const heroPositionEl   = document.getElementById('heroPosition');
const heroBestHandEl   = document.getElementById('heroBestHand');

const tableInfoEl      = document.getElementById('tableInfo');
const dealerShortEl    = document.getElementById('dealerShort');
const chatEl           = document.getElementById('chat');

const tableTitleEl     = document.getElementById('tableTitle');
const tableNameEl      = document.getElementById('tableName');
const tablePlayersEl   = document.getElementById('tablePlayers');
const minBuyinEl       = document.getElementById('minBuyin');
const maxBuyinEl       = document.getElementById('maxBuyin');

const seatButton       = document.getElementById('btnLeave');
const exitButton       = document.getElementById('btnExit');
const logoArea         = document.getElementById('logoArea'); 

const chatInputEl      = document.getElementById('chatInput');
const chatSendEl       = document.getElementById('chatSend');

// Actions
const foldButton       = document.getElementById('foldButton');
const checkCallButton  = document.getElementById('checkCallButton');
const betRaiseButton   = document.getElementById('betRaiseButton');
const allInButton      = document.getElementById('allInButton');

const betRangeEl       = document.getElementById('betRange');
const betAmountEl      = document.getElementById('betAmount');
const betPercentLabel  = document.getElementById('betPercentLabel');
const presetButtons    = Array.from(document.querySelectorAll('[data-bet-preset]'));

// =====================================================================
// ===============   HELPERS   =========================================
// =====================================================================

function suitToColor(suit) {
  return (suit === '♥' || suit === '♦') ? 'red' : 'black';
}

function cardKey(card) {
  if (!card) return '';
  return String(card.rank) + String(card.suit);
}

function createCardEl(card) {
  const div = document.createElement('div');
  div.className = 'card ' + suitToColor(card.suit);

  const rankEl = document.createElement('div');
  rankEl.className = 'card-rank';
  rankEl.textContent = card.rank;

  const suitEl = document.createElement('div');
  suitEl.className = 'card-suit';
  suitEl.textContent = card.suit;

  div.appendChild(rankEl);
  div.appendChild(suitEl);
  return div;
}

function createCardBackEl() {
  const div = document.createElement('div');
  div.className = 'card card-back';
  const inner = document.createElement('div');
  inner.className = 'card-back-inner';
  inner.textContent = 'MB';
  div.appendChild(inner);
  return div;
}

function clearTurnTimer() {
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerInterval = null;
}

function appendChatLine(type, text) {
  if (!chatEl || !text) return;
  const line = document.createElement('div');
  if (type === 'dealer') line.className = 'chat-line-dealer';
  else if (type === 'system') line.className = 'chat-line-system';
  else if (type === 'player') line.className = 'chat-line-player';
  line.textContent = text;
  chatEl.appendChild(line);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function formatNumber(n) {
  return Number(n).toLocaleString('ru-RU');
}

// =====================================================================
// ===============   HEADER RENDER   ===================================
// =====================================================================

function renderHeader(state) {
  if (!state) return;

  const players = state.players || [];
  const maxPlayers = state.maxPlayers || 6;

  const sb = state.smallBlind || 0;
  const bb = state.bigBlind || 0;

  if (tableTitleEl) {
    tableTitleEl.textContent = `TABLE · NL ${sb}/${bb}`;
  }

  if (tableNameEl) {
    const tableLabel =
      state.tableName ||
      (state.tableId ? `Стол #${state.tableId}` : 'Стол Midnight Black');
    tableNameEl.textContent = tableLabel;
  }

  if (tablePlayersEl) {
    tablePlayersEl.textContent = `${players.length} / ${maxPlayers} игроков`;
  }

  if (minBuyinEl) {
    const min = state.minBuyin || 0;
    minBuyinEl.textContent = min
      ? `Мин. бай-ин: ${formatNumber(min)} MBC`
      : 'Мин. бай-ин: —';
  }

  if (maxBuyinEl) {
    const max = state.maxBuyin || 0;
    maxBuyinEl.textContent = max
      ? `Макс. бай-ин: ${formatNumber(max)} MBC`
      : `Макс. бай-ин: —`;
  }
}

// =====================================================================
// ===============   SEATS RENDER   ====================================
// =====================================================================

function positionDealerChip(state) {
  if (!dealerChipEl || !tableEl) return;

  const players = state.players || [];
  const btnIdx = players.findIndex(p => p.id === state.buttonPlayerId);

  // Нет активного баттона → фишку прячем
  if (btnIdx < 0 || btnIdx >= seatEls.length) {
    dealerChipEl.style.display = 'none';
    return;
  }

  const seatEl = seatEls[btnIdx];

  // Ищем слот тем же индексом или по data-seat
  let slotEl = dealerSlotEls[btnIdx] || null;
  if (!slotEl && seatEl && seatEl.dataset.seat) {
    slotEl = tableEl.querySelector(
      `.dealer-slot[data-seat="${seatEl.dataset.seat}"]`
    );
  }

  if (!seatEl || !slotEl) {
    dealerChipEl.style.display = 'none';
    return;
  }

  const slotRect  = slotEl.getBoundingClientRect();
  const tableRect = tableEl.getBoundingClientRect();

  // Размер фишки подгоняем под слот
  const chipSize = Math.min(slotRect.width, slotRect.height);
  dealerChipEl.style.width  = chipSize + 'px';
  dealerChipEl.style.height = chipSize + 'px';

  // Центруем фишку относительно слота
  const leftInsideTable =
    slotRect.left - tableRect.left + (slotRect.width  - chipSize) / 2;
  const topInsideTable  =
    slotRect.top  - tableRect.top  + (slotRect.height - chipSize) / 2;

  dealerChipEl.style.left = leftInsideTable + 'px';
  dealerChipEl.style.top  = topInsideTable  + 'px';
  dealerChipEl.style.display = 'block';
}

function renderSeats(state) {
  const players = state.players || [];

  seatEls.forEach((seatEl, idx) => {
    const slotPlayer = players[idx];
    const nameEl  = seatEl.querySelector('.seat-name');
    const stackEl = seatEl.querySelector('.seat-stack');

    if (!slotPlayer) {
      seatEl.classList.add('seat--empty');
      seatEl.classList.remove('active');
      if (nameEl)  nameEl.textContent  = 'Свободно';
      if (stackEl) stackEl.textContent = '';
      return;
    }

    seatEl.classList.remove('seat--empty');
    if (nameEl)  nameEl.textContent  = slotPlayer.name || ('Игрок ' + (idx + 1));
    if (stackEl) stackEl.textContent = formatNumber(slotPlayer.stack || 0);

    if (slotPlayer.id === state.currentTurn) {
      seatEl.classList.add('active');
    } else {
      seatEl.classList.remove('active');
    }
  });

  if (state.buttonPlayerId) {
    positionDealerChip(state);
  } else if (dealerChipEl) {
    dealerChipEl.style.display = 'none';
  }
}

// =====================================================================
// ===============   BOARD & POT RENDER   ==============================
// =====================================================================

function renderBoardAndPot(state, comboKeys) {
  comboKeys = comboKeys || [];

  if (potEl && potValueEl) {
    const totalPot = state.totalPot || 0;
    potValueEl.textContent = formatNumber(totalPot);
    potEl.style.display = totalPot > 0 ? 'block' : 'none';
  }

  if (boardEl) {
    boardEl.innerHTML = '';
    (state.communityCards || []).forEach(card => {
      const el = createCardEl(card);
      if (comboKeys.includes(cardKey(card))) el.classList.add('card--highlight');
      boardEl.appendChild(el);
    });
  }

  if (sidePotsEl) {
    const pots = state.potDetails || [];
    sidePotsEl.textContent = pots.length ? pots.join(' | ') : '';
  }

  if (tableInfoEl) {
    const stages = {
      waiting:  'Ожидание раздачи',
      preflop:  'Префлоп',
      flop:     'Флоп',
      turn:     'Тёрн',
      river:    'Ривер',
      showdown: 'Шоудаун'
    };
    const stageName = stages[state.stage] || '—';
    const sb = state.smallBlind || 0;
    const bb = state.bigBlind || 0;
    tableInfoEl.textContent =
      `Live · Hold'em · Блайнды ${sb}/${bb} · ${stageName}`;
  }

  if (dealerShortEl) {
    let txt = state.tableMessage ||
              (state.dealerDetails ? String(state.dealerDetails).split('\n')[0] : '');
    if (txt && txt.length > 110) txt = txt.slice(0, 107) + '…';
    dealerShortEl.textContent = txt || '';
  }

  if (state.tableMessage && state.tableMessage !== lastSeenLogMessage) {
    appendChatLine('dealer', state.tableMessage);
    lastSeenLogMessage = state.tableMessage;
  }

  if (state.dealerDetails && state.dealerDetails !== lastSeenDealerDetails) {
    String(state.dealerDetails).split('\n').forEach(l => appendChatLine('system', l));
    lastSeenDealerDetails = state.dealerDetails;
  }

  if (state.message && state.message !== lastHeroMessage) {
    appendChatLine('system', state.message);
    lastHeroMessage = state.message;
  }
}

// =====================================================================
// ===============   HERO RENDER   =====================================
// =====================================================================

function getHeroHint(state) {
  if (!state) return '—';
  const players = state.players || [];
  const me = players.find(p => p.id === myPlayerId);
  if (!state.yourTurn) {
    return 'Ожидание других игроков';
  }
  if (!me) return 'Ваш ход';

  const currentBet = state.currentBet || 0;
  const myBet = me.betThisStreet || 0;
  const toCall = currentBet - myBet;
  const stack = me.stack || 0;

  if (toCall <= 0) {
    return 'Вы можете чекнуть или сделать ставку.';
  }

  if (stack <= toCall) {
    return 'Вы можете уравнять олл-ин или сбросить карты.';
  }

  return 'Вы можете коллировать, сделать рейз или сбросить карты.';
}

function renderHero(state, comboKeys, prevState) {
  const players = state.players || [];
  const me = players.find(p => p.id === myPlayerId);
  comboKeys = comboKeys || [];
  prevState = prevState || null;

  if (heroFlipTimeout) {
    clearTimeout(heroFlipTimeout);
    heroFlipTimeout = null;
    heroFlipInProgress = false;
  }

  if (heroNameEl)  heroNameEl.textContent  = me ? (me.name || 'Hero') : 'Hero';
  if (heroStackEl) heroStackEl.textContent = me ? formatNumber(me.stack || 0) : 0;

  const stages = {
    waiting:  'Ожидание',
    preflop:  'Префлоп',
    flop:     'Флоп',
    turn:     'Тёрн',
    river:    'Ривер',
    showdown: 'Шоудаун'
  };
  if (heroPositionEl) {
    heroPositionEl.textContent = 'Стадия: ' + (stages[state.stage] || '—');
  }

  if (heroBestHandEl) {
    heroBestHandEl.textContent =
      state.yourBestHandType ? ('Комбинация: ' + state.yourBestHandType) : 'Комбинация: —';
  }

  const prevYourCards = prevState && prevState.yourCards ? prevState.yourCards : [];
  const currYourCards = state.yourCards || [];

  const justDealtPreflop =
    prevState &&
    prevYourCards.length === 0 &&
    currYourCards.length === 2 &&
    state.stage === 'preflop';

  if (justDealtPreflop) {
    heroFlipInProgress = true;
  }

  heroCardsSlots.forEach((slot, idx) => {
    if (!slot) return;
    slot.innerHTML = '';
    const card = currYourCards[idx];
    if (!card) return;

    let el;
    if (heroFlipInProgress) {
      el = createCardBackEl();
    } else {
      el = createCardEl(card);
      if (comboKeys.includes(cardKey(card))) el.classList.add('card--highlight');
      el.style.width = '100%';
      el.style.height = '100%';
    }
    el.style.width = '100%';
    el.style.height = '100%';
    slot.appendChild(el);
  });

  if (heroFlipInProgress) {
    heroFlipTimeout = setTimeout(() => {
      heroFlipInProgress = false;
      if (!lastState) return;
      const keys = (lastState.yourBestHandCards || []).map(cardKey);
      renderHero(lastState, keys, lastState);
    }, 600);
  }

  clearTurnTimer();
  const hintText = getHeroHint(state);

  if (state.yourTurn) {
    if (state.turnDeadline) {
      const deadline = state.turnDeadline;
      const upd = () => {
        const diffMs = deadline - Date.now();
        const sec = Math.max(0, Math.ceil(diffMs / 1000));
        if (heroLastActionEl) {
          heroLastActionEl.textContent = `${hintText} · ${sec} с`;
        }

        if (sec <= 0) clearTurnTimer();
      };
      upd();
      turnTimerInterval = setInterval(upd, 250);
    } else if (heroLastActionEl) {
      heroLastActionEl.textContent = hintText;
    }
  } else if (heroLastActionEl) {
    heroLastActionEl.textContent = hintText;
  }

  const disable = !state.yourTurn;
  [foldButton, checkCallButton, betRaiseButton, allInButton].forEach(btn => {
    if (!btn) return;
    btn.disabled = disable;
    btn.classList.toggle('is-disabled', disable);
  });
}

// =====================================================================
// ===============   JOIN / LEAVE LOGIC   ==============================
// =====================================================================

function isMeSeated(state) {
  if (!myPlayerId || !state || !state.players) return false;
  const me = state.players.find(p => p.id === myPlayerId);
  if (!me) return false;
  return !me.isPaused && me.stack > 0;
}

function getSeatUiState(state) {
  if (!myPlayerId || !state || !state.players) return 'notSeated';

  const me = state.players.find(p => p.id === myPlayerId);
  if (!me || me.stack <= 0) return 'notSeated';

  if (me.isPaused) return 'paused';
  return 'playing';
}

function updateSeatButton(state) {
  if (!seatButton) return;

  const uiState = getSeatUiState(state);

  // Сброс оформляющих классов
  seatButton.classList.remove('btn-join', 'btn-leave');
  seatButton.disabled = false;

  // По умолчанию иконку выхода прячем
  if (exitButton) {
    exitButton.classList.remove('btn-icon-exit--visible');
  }

  if (uiState === 'notSeated') {
    // Ещё не сидим за столом
    seatButton.textContent = 'Сесть за стол';
    seatButton.classList.add('btn-join');
  } else if (uiState === 'playing') {
    // Активно играем
    seatButton.textContent = 'Покинуть стол';
    seatButton.classList.add('btn-leave');
  } else if (uiState === 'paused') {
    // На паузе: большая кнопка "Сесть за стол", маленькая иконка выхода видна
    seatButton.textContent = 'Сесть за стол';
    seatButton.classList.add('btn-join');
    if (exitButton) {
      exitButton.classList.add('btn-icon-exit--visible');
    }
  }
}

// =====================================================================
// ===============   MAIN RENDER   =====================================
// =====================================================================

function renderState(state) {
  const prevState = lastState;
  lastState = state;
  const comboKeys = (state.yourBestHandCards || []).map(cardKey);

  renderHeader(state);
  renderSeats(state);
  renderBoardAndPot(state, comboKeys);
  renderHero(state, comboKeys, prevState);
  updateBetControls(state);
  updateSeatButton(state);
}

// =====================================================================
// ===============   BET CONTROLS   ====================================
// =====================================================================

function updateBetControls(state) {
  if (!betRangeEl || !betAmountEl) return;
  const me = (state.players || []).find(p => p.id === myPlayerId);
  if (!me) return;

  const stack = me.stack || 0;
  betAmountEl.max = stack;

  let val = parseInt(betAmountEl.value, 10);
  if (!Number.isFinite(val)) val = 0;
  if (val < 0) val = 0;
  if (val > stack) val = stack;
  betAmountEl.value = val;

  const percent = stack > 0 ? Math.round((val / stack) * 100) : 0;
  betRangeEl.value = String(percent);
  if (betPercentLabel) betPercentLabel.textContent = percent + '%';
}

function getDefaultBetAmount() {
  if (!lastState) return 10;
  const s = lastState;
  const bb = s.bigBlind || 10;
  const minRaise = s.minRaise || bb;

  if (!s.currentBet || s.currentBet === 0) return bb;
  return s.currentBet + minRaise;
}

// =====================================================================
// ===============   SOCKET LISTENERS   ================================
// =====================================================================

socket.on('connect', () => {
  myPlayerId = socket.id;
  console.log('[table.js] Connected →', myPlayerId, 'tableId=', tableIdFromUrl);
});

socket.on('disconnect', () => {
  clearTurnTimer();
  console.warn('[table.js] Disconnected');
});

socket.on('gameState', (state) => {
  if (!myPlayerId) myPlayerId = socket.id;
  renderState(state);
});

// История чата
socket.on('chatHistory', (history) => {
  if (!Array.isArray(history)) return;
  history.forEach(msg => {
    if (!msg || !msg.text) return;
    const name = msg.name || 'Игрок';
    appendChatLine('player', `${name}: ${msg.text}`);
  });
});

// Новое сообщение чата
socket.on('chatMessage', (msg) => {
  if (!msg || !msg.text) return;
  const name = msg.name || 'Игрок';
  appendChatLine('player', `${name}: ${msg.text}`);
});

// Сигналы звуков от сервера: { type: 'FOLD' | 'CALL' | ... }
socket.on('sound', (payload) => {
  if (!payload) return;
  const type = payload.type || payload;
  if (!type) return;
  sound.play(type);
});

// =====================================================================
// ===============   ACTION BUTTONS   ==================================
// =====================================================================

function wireActionButtons() {
  // FOLD — только экшен, звук прилетит от сервера
  if (foldButton) {
    foldButton.addEventListener('click', () => {
      socket.emit('action', { type: 'fold' });
    });
  }

  // CHECK / CALL — экшен, звук CHECK/CALL даёт сервер
  if (checkCallButton) {
    checkCallButton.addEventListener('click', () => {
      socket.emit('action', { type: 'call' });
    });
  }

  // BET / RAISE — экшен, сервер решает что это за звук (bet/raise/olllin)
  if (betRaiseButton) {
    betRaiseButton.addEventListener('click', () => {
      let amount = 0;
      if (betAmountEl) {
        const raw = parseInt(betAmountEl.value, 10);
        if (Number.isFinite(raw) && raw > 0) amount = raw;
      }
      if (amount <= 0) amount = getDefaultBetAmount();
      if (amount <= 0) return;
      socket.emit('action', { type: 'bet', amount });
    });
  }

  // ALL-IN — только экшен, звук ALLIN прилетит от сервера
  if (allInButton) {
    allInButton.addEventListener('click', () => {
      socket.emit('action', { type: 'allin' });
    });
  }

  // Слайдер ставки — без звука
  if (betRangeEl && betAmountEl) {
    betRangeEl.addEventListener('input', () => {
      const percent = parseInt(betRangeEl.value, 10) || 0;
      if (betPercentLabel) betPercentLabel.textContent = percent + '%';

      const players = lastState && lastState.players ? lastState.players : [];
      const me = players.find(p => p.id === myPlayerId) || null;
      const stack = me ? me.stack || 0 : 0;

      const amount = Math.floor((stack * percent) / 100);
      betAmountEl.value = amount;
    });
  }

  if (betAmountEl && betRangeEl) {
    betAmountEl.addEventListener('input', () => {
      if (!lastState) return;
      const players = lastState.players || [];
      const me = players.find(p => p.id === myPlayerId) || null;
      const stack = me ? me.stack || 0 : 0;

      let val = parseInt(betAmountEl.value, 10);
      if (!Number.isFinite(val) || val < 0) val = 0;
      if (val > stack) val = stack;
      betAmountEl.value = val;

      const percent = stack > 0 ? Math.round((val / stack) * 100) : 0;
      betRangeEl.value = String(Math.min(100, Math.max(0, percent)));
      if (betPercentLabel) {
        betPercentLabel.textContent = betRangeEl.value + '%';
      }
    });
  }

  
  if (presetButtons.length && betAmountEl) {
    presetButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        if (!lastState) return;

        const preset = btn.getAttribute('data-bet-preset');

        const players = lastState.players || [];
        const me = players.find(p => p.id === myPlayerId) || null;
        const stack = me ? me.stack || 0 : 0;
        const totalPot = lastState.totalPot || 0;

        let amount = 0;

        if (preset === 'max') {
          // максимум = жёсткий ALL-IN
          // ЗВУК ALLIN тут не играем, его даст сервер,
          // когда примет action { type: 'allin' }
          socket.emit('action', { type: 'allin' });
          return;
        }

        if (preset === '33') {
          amount = Math.floor(totalPot * 0.33);
        } else if (preset === '50') {
          amount = Math.floor(totalPot * 0.5);
        } else if (preset === '75') {
          amount = Math.floor(totalPot * 0.75);
        } else if (preset === '100') {
          amount = totalPot;
        }

        if (amount <= 0) {
          const pct = parseInt(preset, 10) || 0;
          amount = Math.floor(stack * pct / 100);
        }

        if (amount > stack) amount = stack;
        if (amount < 0) amount = 0;

        betAmountEl.value = amount;

        if (stack > 0 && betRangeEl) {
          const percent = Math.round((amount / stack) * 100);
          betRangeEl.value = String(Math.min(100, Math.max(0, percent)));
          if (betPercentLabel) {
            betPercentLabel.textContent = betRangeEl.value + '%';
          }
        }
      });
    });
  }

  // Анимация нажатия кнопок
  const pressable = document.querySelectorAll(
  '.action-btn, .btn-join, .btn-leave, .btn-icon-exit');
  pressable.forEach(btn => {
    const press = () => btn.classList.add('is-pressed');
    const release = () => btn.classList.remove('is-pressed');

    btn.addEventListener('touchstart', press, { passive: true });
    btn.addEventListener('mousedown', press);

    ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(ev => {
      btn.addEventListener(ev, release);
    });
  });
}

// =====================================================================
// ===============   SEAT BUTTON   =====================================
// =====================================================================

function wireSeatButton() {
  if (!seatButton) return;

  seatButton.addEventListener('click', () => {
    sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);

    // Нет стейта — пробуем просто сесть
    if (!lastState) {
      socket.emit('joinTable', {
        playerName: 'Hero',
        tableId: tableIdFromUrl,
        limitId: limitIdFromUrl
      });
      socket.emit('setPlaying', { playing: true });
      return;
    }

    const uiState = getSeatUiState(lastState);

    if (uiState === 'notSeated') {
      // Сесть за стол
      socket.emit('joinTable', {
        playerName: 'Hero',
        tableId: tableIdFromUrl,
        limitId: limitIdFromUrl
      });
      socket.emit('setPlaying', { playing: true });
    } else if (uiState === 'playing') {
      // ТЗ: полный выход со стола.
      // Сервер пометит игрока pendingLeave: true,
      // автофолдит при получении хода и освободит кресло после раздачи.
      socket.emit('leaveTable');
    } else if (uiState === 'paused') {
      // Вернуться в игру с паузы
      socket.emit('setPlaying', { playing: true });
    }
  });
}

function wireExitButton() {
  if (!exitButton) return;

  exitButton.addEventListener('click', () => {
    sound.play(SOUND_EVENTS.UI_CLICK_PRIMARY);

    if (!lastState || !lastState.players) return;
    const me = lastState.players.find(p => p.id === myPlayerId);
    if (!me) return;

    // Полный выход со стола.
    // На сервере нужно реализовать обработчик события 'leaveTable'.
    socket.emit('leaveTable');
  });
}

// =====================================================================
// ===============   CHAT WIRES   ======================================
// =====================================================================

function wireChat() {
  if (!chatInputEl || !chatSendEl) return;

  const send = () => {
    const text = chatInputEl.value.trim();
    if (!text) return;
    appendChatLine('player', `Вы: ${text}`);
    socket.emit('chatMessage', { text });
    chatInputEl.value = '';
  };

  chatSendEl.addEventListener('click', () => {
    sound.play(SOUND_EVENTS.UI_CLICK_SECONDARY);
    send();
  });
  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sound.play(SOUND_EVENTS.UI_CLICK_SECONDARY);
      send();
    }
  });
}

// =====================================================================
// ===============   INIT   ============================================
// =====================================================================

(function init() {
  wireActionButtons();
  wireSeatButton();
  wireExitButton();
  wireChat();
})();
