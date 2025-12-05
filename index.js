// index.js – многостоловый сервер Midnight Black Poker
// -----------------------------------------------

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createDeck, dealCards } = require('./poker');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// корень проекта
const rootDir = __dirname;

// ---------- СТАТИКА ДЛЯ ФРОНТА ----------

// всё из корня: index.html, table.html, lobby.html, js, css, картинки и т.п.
app.use(express.static(rootDir));

// js/
app.use('/js', express.static(path.join(rootDir, 'js')));

// css/
app.use('/css', express.static(path.join(rootDir, 'css')));

// главная
app.get('/', (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

// стол (сам html отдаётся статикой, но пусть будет явный роут)
app.get('/table.html', (req, res) => {
  res.sendFile(path.join(rootDir, 'table.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ================= Оценка покерных рук =================

const RANK_TO_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5,
  '6': 6, '7': 7, '8': 8, '9': 9,
  'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

function getStraightHighFromRanks(sortedDescRanks) {
  const uniq = [...new Set(sortedDescRanks)];
  if (uniq.length < 5) return 0;

  const hasA = uniq.includes(14);
  if (hasA && [5, 4, 3, 2].every(v => uniq.includes(v))) {
    return 5; // A-5 стрейт
  }

  for (let i = 0; i <= uniq.length - 5; i++) {
    let ok = true;
    for (let j = 0; j < 4; j++) {
      if (uniq[i + j] - 1 !== uniq[i + j + 1]) {
        ok = false;
        break;
      }
    }
    if (ok) return uniq[i];
  }
  return 0;
}

function evaluate5(cards5) {
  const ranks = cards5.map(c => RANK_TO_VALUE[c.rank]).sort((a, b) => b - a);
  const suits = cards5.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const rankCount = {};
  for (const r of ranks) {
    rankCount[r] = (rankCount[r] || 0) + 1;
  }
  const entries = Object.entries(rankCount).map(([r, c]) => ({
    rank: parseInt(r, 10),
    count: c
  }));
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.rank - a.rank;
  });

  const straightHigh = getStraightHighFromRanks(ranks);
  const isStraight = straightHigh > 0;

  function ranksToPattern(list) {
    return list.reduce((acc, r) => acc * 15 + r, 0);
  }

  // Straight flush
  if (isFlush && isStraight) {
    let high = straightHigh;
    let straightRanks;
    if (high === 5) straightRanks = [5, 4, 3, 2, 1];
    else straightRanks = [high, high - 1, high - 2, high - 3, high - 4];
    return 8 * 1e10 + ranksToPattern(straightRanks);
  }

  // Four of a kind
  if (entries[0].count === 4) {
    const fourRank = entries[0].rank;
    const kicker = entries[1].rank;
    return 7 * 1e10 + ranksToPattern([fourRank, kicker]);
  }

  // Full house
  if (entries[0].count === 3 && entries[1].count >= 2) {
    const tripleRank = entries[0].rank;
    const pairRank = entries[1].rank;
    return 6 * 1e10 + ranksToPattern([tripleRank, pairRank]);
  }

  // Flush
  if (isFlush) {
    return 5 * 1e10 + ranksToPattern(ranks);
  }

  // Straight
  if (isStraight) {
    let high = straightHigh;
    let straightRanks;
    if (high === 5) straightRanks = [5, 4, 3, 2, 1];
    else straightRanks = [high, high - 1, high - 2, high - 3, high - 4];
    return 4 * 1e10 + ranksToPattern(straightRanks);
  }

  // Trips
  if (entries[0].count === 3) {
    const tripleRank = entries[0].rank;
    const kickers = [];
    for (let i = 1; i < entries.length; i++) {
      for (let j = 0; j < entries[i].count; j++) {
        kickers.push(entries[i].rank);
      }
    }
    kickers.sort((a, b) => b - a);
    const ordered = [tripleRank, ...kickers.slice(0, 2)];
    return 3 * 1e10 + ranksToPattern(ordered);
  }

  // Two pair
  if (entries[0].count === 2 && entries[1].count === 2) {
    const highPair = entries[0].rank;
    const lowPair = entries[1].rank;
    let kicker = null;
    for (let i = 2; i < entries.length; i++) {
      if (entries[i].count === 1) {
        kicker = entries[i].rank;
        break;
      }
    }
    if (kicker == null) kicker = entries[0].rank;
    const ordered = [highPair, lowPair, kicker];
    return 2 * 1e10 + ranksToPattern(ordered);
  }

  // One pair
  if (entries[0].count === 2) {
    const pairRank = entries[0].rank;
    const kickers = [];
    for (let i = 1; i < entries.length; i++) {
      for (let j = 0; j < entries[i].count; j++) {
        kickers.push(entries[i].rank);
      }
    }
    kickers.sort((a, b) => b - a);
    const ordered = [pairRank, ...kickers.slice(0, 3)];
    return 1 * 1e10 + ranksToPattern(ordered);
  }

  // High card
  return ranksToPattern(ranks);
}

// теперь возвращаем и счёт, и сами 5 лучших карт
function evaluate7(cards7) {
  let bestScore = 0;
  let bestHand = null;
  const n = cards7.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const hand5 = [cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]];
            const score = evaluate5(hand5);
            if (score > bestScore || bestHand === null) {
              bestScore = score;
              bestHand = hand5;
            }
          }
        }
      }
    }
  }
  return { score: bestScore, hand: bestHand };
}

function describeHandScore(score) {
  const category = Math.floor(score / 1e10);
  switch (category) {
    case 8: return 'Стрит-флэш';
    case 7: return 'Каре';
    case 6: return 'Фулл-хаус';
    case 5: return 'Флэш';
    case 4: return 'Стрит';
    case 3: return 'Сет';
    case 2: return 'Две пары';
    case 1: return 'Пара';
    default: return 'Старшая карта';
  }
}

function cardToString(card) {
  if (!card) return '';
  return String(card.rank) + String(card.suit);
}

/**
 * ВЫБИРАЕМ РОВНО ТО КОЛ-ВО КАРТ, ЧТО СОСТАВЛЯЕТ КОМБИНАЦИЮ
 * (старшая – 1, пара – 2, сет – 3, каре – 4, остальное – 5)
 */
function extractComboCards(score, hand5) {
  if (!hand5 || hand5.length === 0) return [];
  const category = Math.floor(score / 1e10);

  // разбиваем по рангу
  const byRank = {};
  for (const c of hand5) {
    const v = RANK_TO_VALUE[c.rank];
    if (!byRank[v]) byRank[v] = [];
    byRank[v].push(c);
  }
  const rankKeysDesc = Object.keys(byRank)
    .map(x => parseInt(x, 10))
    .sort((a, b) => b - a);

  // Старшая карта
  if (category === 0) {
    let bestCard = hand5[0];
    let bestRank = RANK_TO_VALUE[bestCard.rank];
    for (const c of hand5) {
      const v = RANK_TO_VALUE[c.rank];
      if (v > bestRank) {
        bestRank = v;
        bestCard = c;
      }
    }
    return [bestCard];
  }

  // Пара
  if (category === 1) {
    for (const r of rankKeysDesc) {
      const arr = byRank[r];
      if (arr.length >= 2) return arr.slice(0, 2);
    }
    return hand5.slice(0, 2);
  }

  // Две пары
  if (category === 2) {
    const res = [];
    for (const r of rankKeysDesc) {
      const arr = byRank[r];
      if (arr.length >= 2) {
        res.push(...arr.slice(0, 2));
        if (res.length >= 4) break;
      }
    }
    return res.length ? res.slice(0, 4) : hand5.slice(0, 4);
  }

  // Сет
  if (category === 3) {
    for (const r of rankKeysDesc) {
      const arr = byRank[r];
      if (arr.length >= 3) return arr.slice(0, 3);
    }
    return hand5.slice(0, 3);
  }

  // Каре
  if (category === 7) {
    for (const r of rankKeysDesc) {
      const arr = byRank[r];
      if (arr.length >= 4) return arr.slice(0, 4);
    }
    return hand5.slice(0, 4);
  }

  // Стрит, флэш, фулл-хаус, стрит-флэш — всегда 5 карт
  return hand5.slice(0, 5);
}

// ================= КОНФИГ ЛИМИТОВ И МУЛЬТИТЕЙБЛ =================

// ================= КОНФИГ ЛИМИТОВ И МУЛЬТИТЕЙБЛ =================

const TABLE_LIMITS = [
  // MICRO
  { id: 'nl_1_2',     name: 'NL 1 / 2',     smallBlind: 1,    bigBlind: 2,    maxTables: 6 },
  { id: 'nl_2_4',     name: 'NL 2 / 4',     smallBlind: 2,    bigBlind: 4,    maxTables: 6 },

  // LOW
  { id: 'nl_3_6',     name: 'NL 3 / 6',     smallBlind: 3,    bigBlind: 6,    maxTables: 6 },
  { id: 'nl_5_10',    name: 'NL 5 / 10',    smallBlind: 5,    bigBlind: 10,   maxTables: 6 },
  { id: 'nl_10_20',   name: 'NL 10 / 20',   smallBlind: 10,   bigBlind: 20,   maxTables: 6 },

  // MID
  { id: 'nl_25_50',   name: 'NL 25 / 50',   smallBlind: 25,   bigBlind: 50,   maxTables: 6 },
  { id: 'nl_50_100',  name: 'NL 50 / 100',  smallBlind: 50,   bigBlind: 100,  maxTables: 6 },

  // HIGH
  { id: 'nl_100_200', name: 'NL 100 / 200', smallBlind: 100,  bigBlind: 200,  maxTables: 6 },
  { id: 'nl_200_400', name: 'NL 200 / 400', smallBlind: 200,  bigBlind: 400,  maxTables: 4 }
];

// id стола -> движок
const TABLES = new Map();

// socket.id -> id стола
const PLAYER_TABLE = new Map();

function getLimitConfig(limitId) {
  return TABLE_LIMITS.find(l => l.id === limitId) || null;
}

// ======= ДВИЖОК ОДНОГО СТОЛА =======

function createTableEngine(io, config) {
  const { tableId, limitId, smallBlind, bigBlind } = config;

  const TURN_TIMEOUT_MS = 30000;
  const NEXT_HAND_DELAY_MS = 6000;
  // Длительности “анимаций/звуков” (можешь подстроить)
  const CARD_DEAL_DELAY_MS   = 2000; // ~1.88 c на раздачу карманок
  const FLOP_REVEAL_DELAY_MS = 2000; // звук флопа ~2 c
  const TURN_RIVER_DELAY_MS  = 1000; // тёрн/ривер ~1 c
  const ROUND_END_DELAY_MS   = 1000; // <<< Пауза после последнего действия раунда
  
  let debugLog = [];
  let chatLog = [];

  let turnTimer = null;
  let nextHandTimer = null;
  let streetRevealTimer = null; // новый таймер “задержки улицы”
  let roundEndTimer = null;
  
  let table = {
    players: [],          // { id, name, stack, hand, inHand, hasFolded, betThisStreet, hasActedThisStreet, message, isPaused, hasClickedThisHand, totalBet }
    deck: [],
    communityCards: [],
    mainPot: 0,
    streetPot: 0,
    stage: 'waiting',     // waiting | preflop | flop | turn | river | showdown
    smallBlind,
    bigBlind,
    buttonIndex: 0,
    currentBet: 0,
    minRaise: 10,
    currentTurnIndex: null,
    lastLogMessage: '',
    turnDeadline: null,   // timestamp (ms) когда истекает ход текущего игрока
    potDetails: [],
    dealerDetails: null
  };

  function logPrefix() {
    return `[${tableId}]`;
  }

  function emitToTable(event, payload) {
    for (const p of table.players) {
      io.to(p.id).emit(event, payload);
    }
  }

  function playSound(type) {
    emitToTable('sound', { type });
  }

  // Debug-лог
  function pushSnapshot(reason, ignoredTable) {
    const snapshot = {
      ts: new Date().toISOString(),
      tableId,
      reason,
      stage: table.stage,
      mainPot: table.mainPot,
      streetPot: table.streetPot,
      totalPot: table.mainPot + table.streetPot,
      players: table.players.map(p => ({
        id: p.id,
        name: p.name,
        stack: p.stack,
        betThisStreet: p.betThisStreet,
        inHand: p.inHand,
        hasFolded: p.hasFolded,
        isPaused: !!p.isPaused,
        totalBet: p.totalBet || 0
      }))
    };

    debugLog.push(snapshot);
    if (debugLog.length > 200) debugLog.shift();

    console.log(logPrefix(), '[SNAPSHOT]', reason);
  }

  function activePlayers() {
    return table.players.filter(p => p.inHand && !p.hasFolded);
  }

  function getActiveSeatIndices() {
    const res = [];
    for (let i = 0; i < table.players.length; i++) {
      const p = table.players[i];
      if (!p.isPaused && p.stack > 0) {
        res.push(i);
      }
    }
    return res;
  }

  function autoStartIfReady(trigger) {
  const activeSeats = getActiveSeatIndices();

  if (
    table.stage === 'waiting' &&   // Нет текущей раздачи
    activeSeats.length >= 2        // Минимум два активных игрока
   ){
    console.log(logPrefix(), 'Auto-start hand:', trigger);
    startHand();                   // Уже существующая функция
    pushSnapshot('auto start hand: ' + trigger, table);
    broadcastGameState();
    }
  }
  
  function resetHandState() {
    table.deck = [];
    table.communityCards = [];
    table.mainPot = 0;
    table.streetPot = 0;
    table.stage = 'waiting';
    table.currentBet = 0;
    table.minRaise = 10;
    table.currentTurnIndex = null;
    table.turnDeadline = null;
    table.potDetails = [];
    table.dealerDetails = null;

    table.players.forEach(p => {
      p.hand = [];
      p.inHand = false;
      p.hasFolded = false;
      p.betThisStreet = 0;
      p.hasActedThisStreet = false;
      p.message = null;
      p.hasClickedThisHand = false;
      p.totalBet = 0;
    });
  }

  function collapseStreetPot() {
    table.mainPot += table.streetPot;
    table.streetPot = 0;
  }

  function getTotalPotFromBets() {
    return table.players.reduce((sum, p) => sum + (p.totalBet || 0), 0);
  }

  // ================= Таймеры =================

  function clearRoundEndTimer() {
    if (roundEndTimer) {
      clearTimeout(roundEndTimer);
      roundEndTimer = null;
    }
  }

  function scheduleRoundEndIfComplete() {
    clearRoundEndTimer();
    if (!isBettingRoundComplete()) return;

    roundEndTimer = setTimeout(() => {
      roundEndTimer = null;
      autoAdvanceIfReady(); // здесь уже есть логика: либо следующая улица, либо шоудаун
    }, ROUND_END_DELAY_MS);
  }
  
  function clearStreetRevealTimer() {
    if (streetRevealTimer) {
      clearTimeout(streetRevealTimer);
      streetRevealTimer = null;
    }
  }
  
  function clearTurnTimer() {
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
    }
    table.turnDeadline = null;
  }

  function clearNextHandTimer() {
    if (nextHandTimer) {
      clearTimeout(nextHandTimer);
      nextHandTimer = null;
    }
  }

  function scheduleTurnTimer() {
    clearTurnTimer();

    if (!['preflop', 'flop', 'turn', 'river'].includes(table.stage)) return;
    if (table.currentTurnIndex == null) return;

    const p = table.players[table.currentTurnIndex];
    if (!p || !p.inHand || p.hasFolded) return; // пауза НЕ блокирует таймер в текущей раздаче

    table.turnDeadline = Date.now() + TURN_TIMEOUT_MS;

    turnTimer = setTimeout(() => {
      handleTurnTimeout();
    }, TURN_TIMEOUT_MS);
  }

    function handleTurnTimeout() {
    turnTimer = null;

    if (!['preflop', 'flop', 'turn', 'river'].includes(table.stage)) return;
    if (table.currentTurnIndex == null) return;

    const p = table.players[table.currentTurnIndex];
    if (!p || !p.inHand || p.hasFolded) return;

    const toCall = table.currentBet - p.betThisStreet;
    const needToCall = toCall > 0;

    const others = activePlayers().filter(pl => pl.id !== p.id);
    const someoneBet = others.some(pl => pl.betThisStreet > 0 && !pl.hasFolded);

    if (needToCall && someoneBet) {
      // авто-фолд + пауза
      p.hasFolded = true;
      p.inHand = false;
      p.isPaused = true;
      p.hasActedThisStreet = true;
      table.lastLogMessage = `Игрок ${p.name} не сделал ход, авто-фолд и пауза`;

      const actives = activePlayers();
      if (actives.length <= 1) {
        goToShowdown();
        pushSnapshot('after auto-fold timeout -> showdown', table);
        broadcastGameState();
        return;
      }

      advanceTurn();
      pushSnapshot('after auto-fold timeout', table);
      broadcastGameState();
      scheduleTurnTimer();
    } else {
      // авто-чек + пауза (игрок доигрывает раздачу, но в следующих не участвует)
      const prevClicked = p.hasClickedThisHand;

      handlePlayerAction(p.id, { type: 'call', isAuto: true });

      p.hasClickedThisHand = prevClicked;
      p.isPaused = true; // <-- ВАЖНО: ставим на паузу для следующих раздач
      table.lastLogMessage = `Игрок ${p.name} не сделал ход, авто-check и переход в паузу`;

      pushSnapshot('after auto-check timeout', table);
      broadcastGameState();
      scheduleTurnTimer();
    }
  }

  // ================= Раздача =================

  function nextActiveIndexFrom(baseIndex) {
    const len = table.players.length;
    if (len === 0) return null;
    for (let step = 1; step <= len; step++) {
      const idx = (baseIndex + step) % len;
      const p = table.players[idx];
      if (!p.isPaused && p.stack > 0) return idx;
    }
    return null;
  }

  function startHand() {
    const activeSeats = getActiveSeatIndices();
    if (activeSeats.length < 2) {
      console.log(logPrefix(), 'Not enough active players to start hand');
      return;
    }

    clearTurnTimer();
    clearNextHandTimer();

    table.deck = createDeck();
    table.communityCards = [];
    table.mainPot = 0;
    table.streetPot = 0;
    table.stage = 'preflop';
    table.currentBet = 0;
    table.minRaise = 10;
    table.potDetails = [];
    table.dealerDetails = null;

    table.players.forEach(p => {
      p.hand = [];
      p.inHand = false;
      p.hasFolded = false;
      p.betThisStreet = 0;
      p.hasActedThisStreet = false;
      p.message = null;
      p.hasClickedThisHand = false;
      p.totalBet = 0;
    });

    for (const idx of activeSeats) {
      table.players[idx].inHand = true;
    }

    if (
      table.buttonIndex == null ||
      table.buttonIndex < 0 ||
      table.buttonIndex >= table.players.length ||
      table.players[table.buttonIndex].isPaused ||
      table.players[table.buttonIndex].stack <= 0
    ) {
      table.buttonIndex = activeSeats[0];
    }

    const sbIndex = nextActiveIndexFrom(table.buttonIndex);
    const bbIndex = sbIndex != null ? nextActiveIndexFrom(sbIndex) : null;
    const utgIndex = bbIndex != null ? nextActiveIndexFrom(bbIndex) : null;

    function takeBlind(playerIndex, amount) {
      const player = table.players[playerIndex];
      if (!player) return;
      const blind = Math.min(player.stack, amount);
      if (blind <= 0) return;
      player.stack -= blind;
      player.betThisStreet += blind;
      player.totalBet = (player.totalBet || 0) + blind;
      table.streetPot += blind;
    }

    if (sbIndex != null) takeBlind(sbIndex, table.smallBlind);
    if (bbIndex != null) takeBlind(bbIndex, table.bigBlind);

    // раздача карманных
    playSound('CARD_DEAL');
    for (let r = 0; r < 2; r++) {
      for (const idx of activeSeats) {
        const p = table.players[idx];
        const card = dealCards(table.deck, 1)[0];
        if (card) p.hand.push(card);
      }
    }

    table.currentBet = table.bigBlind;
    table.minRaise = 10;
    table.currentTurnIndex = null;

    const sbPlayer = sbIndex != null ? table.players[sbIndex] : null;
    const bbPlayer = bbIndex != null ? table.players[bbIndex] : null;

    if (sbPlayer && bbPlayer) {
      table.lastLogMessage =
        `Игрок ${sbPlayer.name} поставил малый блайнд (${table.smallBlind}), ` +
        `игрок ${bbPlayer.name} поставил большой блайнд (${table.bigBlind})`;
    } else {
      table.lastLogMessage = 'Начата новая раздача';
    }

    console.log(logPrefix(), 'Hand started. StreetPot:', table.streetPot, 'Stage:', table.stage);  
    
    // === Пауза на звук раздачи карманных ===
    clearStreetRevealTimer();
    streetRevealTimer = setTimeout(() => {
    streetRevealTimer = null;
    table.currentTurnIndex = utgIndex;
    broadcastGameState();
    scheduleTurnTimer();
    }, CARD_DEAL_DELAY_MS);
  }

  function dealCommunity(count, soundType = 'CARD_BOARD') {
  if (table.deck.length > 0) {
    table.deck.pop(); // burn
  }
  playSound(soundType);
  for (let i = 0; i < count; i++) {
    const card = dealCards(table.deck, 1)[0];
    if (card) table.communityCards.push(card);
  }
  }

  function revealStreetWithDelay(cardCount, newStage) {
  clearTurnTimer();
  clearStreetRevealTimer();

  // выбираем тип звука
  const soundType =
    newStage === 'flop'
      ? 'CARD_BOARD'        // флоп
      : 'CARD_TURN_RIVER';  // тёрн и ривер – отдельный звук

  // выкладываем карты и играем звук
  dealCommunity(cardCount, soundType);

  // логически уже новая улица
  table.stage = newStage;
  broadcastGameState();

  const delay =
    newStage === 'flop'
      ? FLOP_REVEAL_DELAY_MS
      : TURN_RIVER_DELAY_MS;

  streetRevealTimer = setTimeout(() => {
    streetRevealTimer = null;
    startNewStreet(newStage);
  }, delay);
  }
  
  function startNewStreet(newStage) {
    table.stage = newStage;
    table.currentBet = 0;
    table.minRaise = 10;
    table.players.forEach(p => {
      p.betThisStreet = 0;
      p.hasActedThisStreet = false;
    });

    const len = table.players.length;
    if (len === 0) {
      table.currentTurnIndex = null;
      clearTurnTimer();
      return;
    }

    const start = (table.buttonIndex + 1) % len;
    table.currentTurnIndex = null;
    for (let i = 0; i < len; i++) {
      const idx = (start + i) % len;
      const p = table.players[idx];
      // В текущей раздаче пауза НЕ выкидывает с улицы, игрок идёт по авто-чеку/фолду
      if (p.inHand && !p.hasFolded && p.stack > 0) {
        table.currentTurnIndex = idx;
        break;
      }
    }
    broadcastGameState();
    scheduleTurnTimer();
  }

  function isBettingRoundComplete() {
    const actives = activePlayers();
    if (actives.length <= 1) return true;

    return actives.every(p => {
      if (p.stack === 0) return true; // all-in
      return p.hasActedThisStreet && p.betThisStreet === table.currentBet;
    });
  }

  // ================= Шоудаун и авто-следующая раздача =================

  function buildSidePots() {
    const contribs = table.players
      .map(p => ({
        id: p.id,
        total: p.totalBet || 0,
        hasFolded: p.hasFolded
      }))
      .filter(x => x.total > 0);

    if (contribs.length === 0) return [];

    contribs.sort((a, b) => a.total - b.total);

    const pots = [];
    let prev = 0;
    let remaining = contribs.length;

    for (let i = 0; i < contribs.length; i++) {
      const level = contribs[i].total;
      const portion = level - prev;
      if (portion > 0) {
        const seg = contribs.slice(i);
        const eligibleIds = seg
          .filter(c => !c.hasFolded)
          .map(c => c.id);
        const amount = portion * remaining;
        if (amount > 0 && eligibleIds.length > 0) {
          pots.push({ amount, eligibleIds });
        }
        prev = level;
      }
      remaining--;
    }

    return pots;
  }

  function scheduleNextHandIfNeeded() {
    clearNextHandTimer();

    nextHandTimer = setTimeout(() => {
      nextHandTimer = null;

      table.players.forEach(p => {
        if (p.inHand && !p.hasClickedThisHand) {
          p.isPaused = true;
        }
      });

      const activeSeats = getActiveSeatIndices();
      if (activeSeats.length < 2) {
        resetHandState();
        pushSnapshot('after showdown -> not enough players for next hand', table);
        broadcastGameState();
        return;
      }

      const nextBtn = nextActiveIndexFrom(table.buttonIndex ?? activeSeats[0]);
      if (nextBtn != null) {
        table.buttonIndex = nextBtn;
      }

      resetHandState();
      startHand();
      pushSnapshot('auto start next hand after showdown', table);
      broadcastGameState();
    }, NEXT_HAND_DELAY_MS);
  }

  function goToShowdown() {
    clearTurnTimer();
    clearNextHandTimer();
    clearStreetRevealTimer();
    clearRoundEndTimer();
    
    collapseStreetPot();
    table.stage = 'showdown';
    table.currentTurnIndex = null;
    table.turnDeadline = null;

    table.potDetails = [];
    table.dealerDetails = null;

    resolveShowdown();
    pushSnapshot('after showdown', table);
    playSound('SHOWDOWN');
    broadcastGameState();
    scheduleNextHandIfNeeded();
  }

  function resolveShowdown() {
    const contenders = activePlayers();
    const totalPotFromBets = getTotalPotFromBets();

    table.potDetails = [];
    table.dealerDetails = null;

    if (contenders.length === 0) {
      table.mainPot = 0;
      table.streetPot = 0;
      table.players.forEach(p => { p.totalBet = 0; });
      const line = `Общий банк ${totalPotFromBets} фишек сгорел: к моменту шоудауна нет активных игроков.`;
      table.lastLogMessage = 'Банк сгорел (нет активных игроков)';

      // Подробный текст только в dealerDetails / чате
      table.dealerDetails = line
      return;
    }

    if (contenders.length === 1) {
      const winner = contenders[0];
      const totalPot = totalPotFromBets;

      winner.stack += totalPot;
      winner.message = `Вы выиграли без вскрытия, банк: ${totalPot}`;

      table.players.forEach(p => {
        if (p.id !== winner.id) {
          p.message = `Игрок ${winner.name} забрал банк без вскрытия (${totalPot} фишек).`;
        }
        p.totalBet = 0;
      });

      console.log(logPrefix(), `Winner by fold: ${winner.name}, +${totalPot}`);
      table.mainPot = 0;
      table.streetPot = 0;
      table.lastLogMessage = `Банк ${totalPot} фишек без вскрытия забрал игрок ${winner.name}`;

      const line = `Общий банк: ${totalPot} фишек. Все остальные игроки сбросили карты, ` + 
        `игрок ${winner.name} забирает весь банк без вскрытия.`;
      table.dealerDetails = line;
      playSound('POT_WIN');
      return;
    }

    const results = contenders.map(p => {
      const cards7 = [...p.hand, ...table.communityCards];
      const { score, hand } = evaluate7(cards7);
      const text = describeHandScore(score);
      const comboCards = extractComboCards(score, hand || []);
      return { player: p, score, text, best5: hand, comboCards };
    });

    const handMap = {};
    results.forEach(r => { handMap[r.player.id] = r; });

    const pots = buildSidePots();
    const perPlayerWin = {};
    const potSummaries = [];
    const detailLines = [];

    const computedPotTotal = pots.reduce((s, p) => s + p.amount, 0);
    const totalPot = computedPotTotal;

    detailLines.push(
      `Общий банк по ставкам: ${totalPotFromBets} фишек.` +
      (totalPotFromBets !== computedPotTotal
        ? ` (служебно: сумма по сайд-потам=${computedPotTotal})`
        : '')
    );

    let potIndex = 1;
    for (const pot of pots) {
      const eligibleResults = pot.eligibleIds
        .map(id => handMap[id])
        .filter(Boolean);

      if (eligibleResults.length === 0) continue;

      let bestScore = -1;
      let winnersForPot = [];
      for (const r of eligibleResults) {
        if (r.score > bestScore) {
          bestScore = r.score;
          winnersForPot = [r];
        } else if (r.score === bestScore) {
          winnersForPot.push(r);
        }
      }

      const share = Math.floor(pot.amount / winnersForPot.length);
      let remainder = pot.amount - share * winnersForPot.length;

      winnersForPot.forEach((r, idx) => {
        const pid = r.player.id;
        const gain = share + (idx === 0 && remainder > 0 ? remainder : 0);
        perPlayerWin[pid] = (perPlayerWin[pid] || 0) + gain;
        r.player.stack += gain;
        if (idx === 0) remainder = 0;
      });

      const participantNames = eligibleResults
        .map(r => r.player.name || 'Игрок')
        .join(', ');

      const wDesc = winnersForPot
        .map(w => {
          const cardsStr = (w.comboCards || []).map(cardToString).join(' ');
          return `${w.player.name || 'Игрок'} — ${w.text} (${cardsStr})`;
        })
        .join(', ');

      potSummaries.push(`Пот ${potIndex} (${pot.amount} фишек): ${wDesc}`);

      detailLines.push(
        `Пот ${potIndex}: ${pot.amount} фишек. Участвуют: ${participantNames}. ` +
        `Победитель(и): ${wDesc}.`
      );

      potIndex++;
    }

    table.players.forEach(p => {
      const winAmount = perPlayerWin[p.id] || 0;
      const res = handMap[p.id];

      if (winAmount > 0) {
        if (res) {
          const cardsStr = (res.comboCards || []).map(cardToString).join(' ');
          p.message = `Вы выиграли ${winAmount} фишек с комбинацией: ${res.text} (${cardsStr}).`;
        } else {
          p.message = `Вы выиграли ${winAmount} фишек.`;
        }
      } else if (res) {
        const cardsStr = (res.comboCards || []).map(cardToString).join(' ');
        p.message = `Вы проиграли с комбинацией: ${res.text} (${cardsStr}). Общий банк: ${totalPot}`;
      } else {
        if (pots.length > 0) {
          p.message = `Победители шоудауна: ${potSummaries.join('; ')}. Общий банк: ${totalPot}`;
        } else {
          p.message = 'Раздача завершена.';
        }
      }

      p.totalBet = 0;
    });

    console.log(
     logPrefix(),
     'Showdown pots:',
     potSummaries.join(' | '),
     'totalPot:',
     totalPot
    );

    table.mainPot = 0;
    table.streetPot = 0;
    table.lastLogMessage = pots.length > 0
    ? `Шоудаун. ${potSummaries.join(' | ')}. Общий банк: ${totalPot}`
    : `Шоудаун. Общий банк: ${totalPot}`;

    // ===== КОРОТКИЙ ТЕКСТ ТОЛЬКО ДЛЯ СТОЛА (sidePots) =====
    const sidePotLines = [];

    if (pots.length > 0) {
      pots.forEach((pot, i) => {
      sidePotLines.push(`Пот ${i + 1}: ${pot.amount} фишек`);
    });
    } else if (totalPot > 0) {
        sidePotLines.push(`Общий банк: ${totalPot} фишек`);
    }

    // Это пойдёт в sidePots под картами
    table.potDetails = sidePotLines;

    // А здесь оставляем весь разжёванный текст
    table.dealerDetails = detailLines.join('\n');

    if (Object.keys(perPlayerWin).length > 0) playSound('win');
  }

  // ================= Авто-переход улиц ==================
  
  function autoAdvanceIfReady() {
    const stages = ['preflop', 'flop', 'turn', 'river'];
    if (!stages.includes(table.stage)) return;

    const actives = activePlayers();
    if (actives.length <= 1) {
      goToShowdown();
      return;
    }

    if (!isBettingRoundComplete()) return;

    const allAllIn = actives.every(p => p.stack === 0);
    if (allAllIn) {
      collapseStreetPot();

      if (table.stage === 'preflop') {
      // флоп (3 карты) – старый звук борда
        dealCommunity(3, 'CARD_BOARD');
      // тёрн и ривер – отдельный звук
        dealCommunity(1, 'CARD_TURN_RIVER');
        dealCommunity(1, 'CARD_TURN_RIVER');

      } else if (table.stage === 'flop') {
      // уже есть флоп, выкладываем тёрн + ривер
        dealCommunity(1, 'CARD_TURN_RIVER');
        dealCommunity(1, 'CARD_TURN_RIVER');

      } else if (table.stage === 'turn') {
      // только ривер
        dealCommunity(1, 'CARD_TURN_RIVER');
      }

      goToShowdown();
      return;
    }

    collapseStreetPot();

    if (table.stage === 'preflop') {
      revealStreetWithDelay(3, 'flop');
    } else if (table.stage === 'flop') {
      revealStreetWithDelay(1, 'turn');
    } else if (table.stage === 'turn') {
      revealStreetWithDelay(1, 'river');
    } else if (table.stage === 'river') {
      goToShowdown();
    }
  }

  // ================= Состояние для клиента =================

  function getBestHandForPlayer(player) {
    if (!player) return null;
    const cards7 = [...player.hand, ...table.communityCards];
    if (cards7.length < 5) return null;
    return evaluate7(cards7);
  }

  function getPublicStateFor(playerId) {
    const player = table.players.find(p => p.id === playerId);
    const current =
      table.currentTurnIndex !== null &&
      table.players[table.currentTurnIndex]
        ? table.players[table.currentTurnIndex].id
        : null;

    const totalPot = table.mainPot + table.streetPot;
    const btnPlayer = table.players[table.buttonIndex] || null;

    const yourTurn = !!(player && current === player.id);
    let yourTurnDeadline = null;
    if (yourTurn && table.turnDeadline) {
      yourTurnDeadline = table.turnDeadline;
    }

    let yourBestHandType = null;
    let yourBestHandCards = null;
    if (player) {
      const best = getBestHandForPlayer(player);
      if (best && best.hand) {
        yourBestHandType = describeHandScore(best.score);
        yourBestHandCards = extractComboCards(best.score, best.hand);
      }
    }

    return {
      stage: table.stage,
      mainPot: table.mainPot,
      streetPot: table.streetPot,
      totalPot,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      communityCards: table.communityCards,
      currentBet: table.currentBet,
      minRaise: table.minRaise,
      buttonPlayerId: btnPlayer ? btnPlayer.id : null,
      tableMessage: table.lastLogMessage || null,
      potDetails: table.potDetails || [],
      dealerDetails: table.dealerDetails || null,
      players: table.players.map(p => ({
        id: p.id,
        name: p.name,
        stack: p.stack,
        inHand: p.inHand && !p.hasFolded,
        betThisStreet: p.betThisStreet,
        isPaused: !!p.isPaused
      })),
      yourCards: player ? player.hand : [],
      currentTurn: current,
      yourTurn,
      turnDeadline: yourTurnDeadline,
      yourBestHandType,
      yourBestHandCards,
      message: player ? player.message || null : null
    };
  }

  function broadcastGameState() {
    for (const p of table.players) {
      io.to(p.id).emit('gameState', getPublicStateFor(p.id));
    }
  }

  // ================= Обход по кругу =================

  function advanceTurn() {
  const len = table.players.length;
  if (len === 0) {
    table.currentTurnIndex = null;
    clearTurnTimer();
    return;
  }
  if (table.currentTurnIndex === null) {
    table.currentTurnIndex = 0;
  }

  for (let i = 1; i <= len; i++) {
    const idx = (table.currentTurnIndex + i) % len;
    const p = table.players[idx];
    if (!p) continue;

    // Если игрок помечен на выход и всё ещё в раздаче — автофолд в момент,
    // когда до него "доходит" ход.
    if (p.pendingLeave && p.inHand && !p.hasFolded) {
      p.hasFolded = true;
      p.inHand = false;
      p.hasActedThisStreet = true;
      table.lastLogMessage = `Игрок ${p.name} покинул стол, авто-фолд`;
      playSound('FOLD');

      const actives = activePlayers();
      const roundComplete = isBettingRoundComplete();

      if (roundComplete || actives.length <= 1) {
        // Раздача или раунд могут завершиться -> дальше autoAdvanceIfReady()
        broadcastGameState();
        scheduleRoundEndIfComplete();
        // Пытаемся найти следующего кандидата в этом же цикле
        continue;
      }

      // Ищем дальше следующего живого игрока
      continue;
    }

    // Пауза не исключает из текущей раздачи — он всё равно
    // может получать авто-действия (чек/фолд по таймауту)
    if (p.inHand && !p.hasFolded && p.stack > 0) {
      table.currentTurnIndex = idx;
      return;
    }
  }

  table.currentTurnIndex = null;
  clearTurnTimer();
}

  // ================= Обработка действий игрока =================

  function handlePlayerAction(playerId, action) {
  if (!action || !action.type) return;
  const actionType = action.type;
  const isAuto = !!action.isAuto;

  const idx = table.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;

  const player = table.players[idx];

  // Пауза блокирует только РУЧНЫЕ действия, авто-действия (таймаут) разрешаем
  if (!player.inHand || player.hasFolded || (player.isPaused && !isAuto)) return;
  if (table.stage === 'waiting' || table.stage === 'showdown') return;

  if (table.currentTurnIndex === null || table.players[table.currentTurnIndex].id !== playerId) {
    console.log(logPrefix(), 'Not this player\'s turn');
    return;
  }

  if (!isAuto) {
    player.hasClickedThisHand = true;
  }

  // ========================= FOLD =========================
  if (actionType === 'fold') {
    player.hasFolded = true;
    player.inHand = false;
    player.hasActedThisStreet = true;
    table.lastLogMessage = `Игрок ${player.name} сделал фолд`;
    playSound('FOLD');

    const actives = activePlayers();
    const roundComplete = isBettingRoundComplete();

    if (!roundComplete && actives.length > 1) {
      // раунд ещё продолжается — просто передаём ход
      advanceTurn();
      broadcastGameState();
      scheduleTurnTimer();
    } else {
      // либо раунд закончился, либо остался 1 игрок — ждём задержку и идём в autoAdvanceIfReady()
      broadcastGameState();
      scheduleRoundEndIfComplete();
    }
    return;
  }

  // ====================== CALL / CHECK =====================
  if (actionType === 'call') {
    const toCall = table.currentBet - player.betThisStreet;

    // CHECK
    if (toCall <= 0) {
      player.hasActedThisStreet = true;
      table.lastLogMessage = `Игрок ${player.name} чек`;
      playSound('CHECK');

      const actives = activePlayers();
      const roundComplete = isBettingRoundComplete();

      if (!roundComplete && actives.length > 1) {
        advanceTurn();
        broadcastGameState();
        scheduleTurnTimer();
      } else {
        broadcastGameState();
        scheduleRoundEndIfComplete();
      }
      return;
    }

    // CALL с оплатой
    const pay = Math.min(player.stack, toCall);
    if (pay <= 0) return;

    player.stack -= pay;
    player.betThisStreet += pay;
    player.totalBet = (player.totalBet || 0) + pay;
    table.streetPot += pay;
    player.hasActedThisStreet = true;

    if (player.stack === 0 && player.betThisStreet < table.currentBet) {
      table.lastLogMessage = `Игрок ${player.name} олл-ин на ${player.betThisStreet} фишек (меньше текущей ставки)`;
    } else if (player.stack === 0) {
      table.lastLogMessage = `Игрок ${player.name} олл-ин на колл (${player.betThisStreet} фишек)`;
    } else {
      table.lastLogMessage = `Игрок ${player.name} колл ${pay}`;
    }

    playSound('CALL');

    const actives = activePlayers();
    const roundComplete = isBettingRoundComplete();

    if (!roundComplete && actives.length > 1) {
      advanceTurn();
      broadcastGameState();
      scheduleTurnTimer();
    } else {
      broadcastGameState();
      scheduleRoundEndIfComplete();
    }
    return;
  }

  // ======================= ЯВНЫЙ ALL-IN ====================
  if (actionType === 'allin') {
    if (player.stack <= 0) return;

    const all = player.stack;

    player.stack = 0;
    player.betThisStreet += all;
    player.totalBet = (player.totalBet || 0) + all;
    table.streetPot += all;
    player.hasActedThisStreet = true;

    if (player.betThisStreet > table.currentBet) {
      const raiseSize = player.betThisStreet - table.currentBet;
      table.minRaise = Math.max(table.minRaise || 10, raiseSize);
      table.currentBet = player.betThisStreet;

      for (const p of table.players) {
        if (p.id !== player.id && p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
          p.hasActedThisStreet = false;
        }
      }

      table.lastLogMessage = `Игрок ${player.name} пошёл олл-ин на ${player.betThisStreet} фишек`;
    } else if (player.betThisStreet === table.currentBet) {
      table.lastLogMessage = `Игрок ${player.name} олл-ин на колл (${player.betThisStreet} фишек)`;
    } else {
      table.lastLogMessage = `Игрок ${player.name} олл-ин на ${player.betThisStreet} фишек (меньше текущей ставки)`;
    }

    playSound('ALLIN');

    const actives = activePlayers();
    const roundComplete = isBettingRoundComplete();

    if (!roundComplete && actives.length > 1) {
      advanceTurn();
      broadcastGameState();
      scheduleTurnTimer();
    } else {
      broadcastGameState();
      scheduleRoundEndIfComplete();
    }
    return;
  }

  // ===================== BET / RAISE =======================
  if (actionType === 'bet') {
    const minRaise = table.minRaise || 10;
    let rawAmount = null;

    if (typeof action.amount === 'number' && !Number.isNaN(action.amount)) {
      rawAmount = Math.max(0, Math.floor(action.amount));
    }

    // --- Первый бет на улице (currentBet === 0) ---
    if (table.currentBet === 0) {
      const desired = rawAmount && rawAmount > 0 ? rawAmount : 10;
      const toBet = Math.min(player.stack, desired);
      if (toBet <= 0) return;

      player.stack -= toBet;
      player.betThisStreet += toBet;
      player.totalBet = (player.totalBet || 0) + toBet;
      table.streetPot += toBet;

      table.currentBet = player.betThisStreet;
      table.minRaise = 10;
      player.hasActedThisStreet = true;
      table.lastLogMessage = `Игрок ${player.name} бет ${toBet}`;

      playSound('BET');

      for (const p of table.players) {
        if (p.id !== player.id && p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
          p.hasActedThisStreet = false;
        }
      }

      // Здесь раунд точно не завершён: только что открылся бет
      advanceTurn();
      broadcastGameState();
      scheduleTurnTimer();
      return;
    }

    // --- Рейз поверх существующего бета/ставки ---
    let desiredTarget = rawAmount && rawAmount > 0
      ? rawAmount
      : (table.currentBet + minRaise);

    if (desiredTarget < table.currentBet + minRaise) {
      desiredTarget = table.currentBet + minRaise;
    }

    const toPay = desiredTarget - player.betThisStreet;
    const pay = Math.min(player.stack, toPay);
    if (pay <= 0) return;

    player.stack -= pay;
    player.betThisStreet += pay;
    player.totalBet = (player.totalBet || 0) + pay;
    table.streetPot += pay;

    const oldBet = table.currentBet;
    table.currentBet = Math.max(table.currentBet, player.betThisStreet);
    const raiseSize = table.currentBet - oldBet;
    if (raiseSize > 0) {
      table.minRaise = Math.max(table.minRaise || 10, raiseSize);
    }

    player.hasActedThisStreet = true;

    if (player.stack === 0 && player.betThisStreet > oldBet) {
      table.lastLogMessage = `Игрок ${player.name} олл-ин рейз до ${player.betThisStreet} фишек`;
    } else {
      table.lastLogMessage = `Игрок ${player.name} рейз до ${player.betThisStreet}`;
    }

    playSound('RAISE');

    for (const p of table.players) {
      if (p.id !== player.id && p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
        p.hasActedThisStreet = false;
      }
    }

    const actives = activePlayers();
    const roundComplete = isBettingRoundComplete();

    if (!roundComplete && actives.length > 1) {
      advanceTurn();
      broadcastGameState();
      scheduleTurnTimer();
    } else {
      broadcastGameState();
      scheduleRoundEndIfComplete();
    }
    return;
  }

  console.log(logPrefix(), 'Unknown action:', actionType);
}

  // ======== ПУБЛИЧНОЕ API ДВИЖКА СТОЛА ========

  return {
    id: tableId,
    limitId,
    getDebugLog() {
      return debugLog.slice();
    },
    getChatLog() {
      return chatLog.slice();
    },
    getPublicStateFor,
    getRawState() {
      return table;
    },

    addPlayer(socketId, name) {
      if (table.players.find(p => p.id === socketId)) return;

      const player = {
        id: socketId,
        name,
        hand: [],
        stack: 1000,
        inHand: false,
        hasFolded: false,
        betThisStreet: 0,
        hasActedThisStreet: false,
        message: null,
        isPaused: false,
        hasClickedThisHand: false,
        totalBet: 0,
        pendingLeave: false
      };

      table.players.push(player);
      console.log(logPrefix(), `Player joined: ${name}`);
      pushSnapshot('player joined', table);
      broadcastGameState();

      // Проверяем, не пора ли запускать раздачу
      autoStartIfReady('player joined');
    },

    removePlayer(socketId) {
      const idx = table.players.findIndex(p => p.id === socketId);
      if (idx >= 0) {
        table.players.splice(idx, 1);
        if (table.players.length === 0) {
          clearTurnTimer();
          clearNextHandTimer();
          resetHandState();
        } else {
          const actives = activePlayers();
          if (actives.length <= 1 && table.stage !== 'waiting') {
            goToShowdown();
          }
        }
        pushSnapshot('player disconnected', table);
        broadcastGameState();
      }
    },

    leaveTable(socketId) {
  const player = table.players.find(p => p.id === socketId);
  if (!player) return;

  // Если сейчас нет активной раздачи или игрок не в хенд-е —
  // можно убрать его сразу.
  const inActiveHand =
    table.stage !== 'waiting' &&
    player.inHand &&
    !player.hasFolded;

  if (!inActiveHand) {
    // Мгновенный выход, кресло сразу свободно
    this.removePlayer(socketId);
    return;
  }

  // Игрок участвует в текущей раздаче:
  // помечаем на выход, переведём на паузу и
  // автофолд сделается при получении хода.
  player.pendingLeave = true;
  player.isPaused = true;

  // Если ход УЖЕ у него сейчас — эквивалент обычного фолда,
  // плюс флаг pendingLeave для удаления после раздачи.
  if (
    table.currentTurnIndex != null &&
    table.players[table.currentTurnIndex] &&
    table.players[table.currentTurnIndex].id === socketId
  ) {
    handlePlayerAction(socketId, { type: 'fold', isAuto: true });
  }

  pushSnapshot('leaveTable_pending', table);
  broadcastGameState();
},
    
    setPlaying(socketId, playing) {
      const player = table.players.find(p => p.id === socketId);
      if (!player) return;

      player.isPaused = !playing;

      if (playing) {
        player.pendingLeave = false;} // ← Игрок возвращается, отменяем "уйти"
  
      console.log(logPrefix(), `Player ${player.name} setPlaying=${playing}`);
      pushSnapshot('setPlaying', table);
      broadcastGameState();

      // Если игрок "включился", возможно, теперь за столом >= 2 живых и можно стартануть раздачу
      if (playing) {
        autoStartIfReady('setPlaying');
      }
    },

    startHand() {
      startHand();
      pushSnapshot('after startHand', table);
      broadcastGameState();
    },

    nextStage() {
      if (table.stage === 'showdown') {
        resetHandState();
        pushSnapshot('after manual resetHandState (new hand)', table);
        broadcastGameState();
      } else {
        autoAdvanceIfReady();
        pushSnapshot('after manual nextStage/autoAdvanceIfReady', table);
        broadcastGameState();
      }
      scheduleTurnTimer();
    },

    handleAction(socketId, data) {
      const type = data && data.type;
      console.log(logPrefix(), 'action from', socketId, type, data);
      if (!type) return;

      handlePlayerAction(socketId, data);
      pushSnapshot(`after action ${type} from ${socketId}`, table);
      broadcastGameState();
    },

    appendChat(socketId, rawText) {
      const text = (rawText || '').trim();
      if (!text) return null;

      const player = table.players.find(p => p.id === socketId);
      const name = player ? player.name : 'Гость';

      const msg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        playerId: socketId,
        name,
        text: text.slice(0, 500),
        ts: new Date().toISOString()
      };

      chatLog.push(msg);
      if (chatLog.length > 200) chatLog.shift();

      emitToTable('chatMessage', msg);
      return msg;
    },

    sendChatHistory(socket) {
      socket.emit('chatHistory', chatLog);
    },

    sendInitialState(socket) {
      socket.emit('gameState', getPublicStateFor(socket.id));
    }
  };
}

// ======= УПРАВЛЕНИЕ ТАБЛИЦАМИ =======

function createNewTableForLimit(limitId) {
  const limit = getLimitConfig(limitId);
  if (!limit) return null;

  const existing = Array.from(TABLES.values()).filter(t => t.limitId === limitId);
  const nextIndex = existing.length + 1;
  if (nextIndex > limit.maxTables) return null;

  const tableId = `${limitId}#${nextIndex}`;
  const engine = createTableEngine(io, {
    tableId,
    limitId,
    smallBlind: limit.smallBlind,
    bigBlind: limit.bigBlind
  });
  TABLES.set(tableId, engine);
  console.log(`[TABLE] Created table ${tableId} (${limit.name})`);
  return engine;
}

// Выбор стола, куда сажать игрока этого лимита
function getTableToSeat(limitId) {
  const limit = getLimitConfig(limitId);
  if (!limit) return null;

  const sameLimit = Array.from(TABLES.values()).filter(t => t.limitId === limitId);
  const MAX_SEATS = 6;

  // Стол с игроками и свободным местом
  const withPlayers = sameLimit.filter(t => t.getRawState().players.length > 0);
  const tableWithSeat = withPlayers.find(t => t.getRawState().players.length < MAX_SEATS);
  if (tableWithSeat) return tableWithSeat;

  // Полностью пустой стол
  const empty = sameLimit.find(t => t.getRawState().players.length === 0);
  if (empty) return empty;

  // Ничего нет — создаём
  return createNewTableForLimit(limitId);
}

// уборка лишних пустых столов
function cleanupEmptyTables(limitId) {
  const limit = getLimitConfig(limitId);
  if (!limit) return;

  const sameLimit = Array.from(TABLES.values()).filter(t => t.limitId === limitId);
  const playing = sameLimit.filter(t => t.getRawState().players.length > 0);
  const empty = sameLimit.filter(t => t.getRawState().players.length === 0);

  if (playing.length > 0 && empty.length > 1) {
    const toRemove = empty.slice(1);
    toRemove.forEach(t => {
      TABLES.delete(t.id);
      console.log(`[TABLE] Removed extra empty table ${t.id}`);
    });
  }
}

function getEngineForSocket(socket) {
  const tableId = PLAYER_TABLE.get(socket.id);
  if (!tableId) return null;
  return TABLES.get(tableId) || null;
}

// ========== /api/lobby – инфа для лобби ==========

app.get('/api/lobby', (req, res) => {
  const data = TABLE_LIMITS.map(limit => {
    const same    = Array.from(TABLES.values()).filter(t => t.limitId === limit.id);
    const playing = same.filter(t => t.getRawState().players.length > 0);
    const empty   = same.filter(t => t.getRawState().players.length === 0);

    const canCreateMore = playing.length + empty.length < limit.maxTables;

    return {
      limitId: limit.id,
      name: limit.name,
      smallBlind: limit.smallBlind,
      bigBlind:  limit.bigBlind,
      tables: playing.map(t => {
        const raw = t.getRawState();
        let status = 'playing';
        if (raw.stage === 'waiting') {
          status = raw.players.length > 0 ? 'waiting_players' : 'empty';
        }
        return {
          tableId: t.id,
          players: raw.players.length,
          stage: raw.stage,
          status
        };
      }),
      hasEmptyPlaceholder: canCreateMore || empty.length > 0
    };
  });

  res.json(data);
});

// ========== /api/create-table – создать новый стол нужного лимита ==========

app.post('/api/create-table', (req, res) => {
  const { limitId } = req.body || {};

  if (!limitId) {
    return res.status(400).json({ error: 'limitId_required' });
  }

  const limit = getLimitConfig(limitId);
  if (!limit) {
    return res.status(400).json({ error: 'unknown_limit' });
  }

  const engine = createNewTableForLimit(limitId);
  if (!engine) {
    return res.status(409).json({ error: 'no_more_tables_for_limit' });
  }

  return res.json({
    tableId: engine.id,
    limitId: engine.limitId,
    name:    limit.name
  });
});

// ========== /log – общий лог по всем столам ==========

app.get('/log', (req, res) => {
  const all = [];
  TABLES.forEach(engine => {
    all.push(...engine.getDebugLog());
  });

  if (!all.length) {
    return res.type('text/plain').send('Лог пустой');
  }

  all.sort((a, b) => a.ts.localeCompare(b.ts));

  const text = all.map(s => {
    const lines = [];
    lines.push(`[${s.ts}] [${s.tableId}] ${s.reason}`);
    lines.push(`  stage=${s.stage}, mainPot=${s.mainPot}, streetPot=${s.streetPot}, totalPot=${s.totalPot}`);
    s.players.forEach(pl => {
      lines.push(
        `  - ${pl.name || pl.id}: stack=${pl.stack}, betThisStreet=${pl.betThisStreet}, inHand=${pl.inHand}, folded=${pl.hasFolded}, paused=${pl.isPaused}, totalBet=${pl.totalBet}`
      );
    });
    return lines.join('\n');
  }).join('\n\n');

  res.type('text/plain').send(text);
});

// ================= Socket.IO (игра + чат) =================

io.on('connection', (socket) => {
  const { limitId, tableId, create } = socket.handshake.query || {};

  const limitFromClient = typeof limitId === 'string' ? limitId : null;
  let chosenLimit = getLimitConfig(limitFromClient) ? limitFromClient : 'nl_10_20';

  let engine = null;

  // 1) Если пришел конкретный tableId — садим ИМЕННО за этот стол
  if (typeof tableId === 'string' && TABLES.has(tableId)) {
    engine = TABLES.get(tableId);
    chosenLimit = engine.limitId;

  // 2) Если пришел флаг "создать стол" — создаём новый стол этого лимита
  } else if (create === '1') {
    engine = createNewTableForLimit(chosenLimit);

  // 3) Обычный случай — подобрать подходящий стол по лимиту
  } else {
    engine = getTableToSeat(chosenLimit);
  }
  if (!engine) {
    console.warn('Cannot create/get table for limit', chosenLimit);
    socket.disconnect(true);
    return;
  }

  PLAYER_TABLE.set(socket.id, engine.id);

  console.log(`[IO] New connection ${socket.id} → table ${engine.id} (${chosenLimit})`);

  // отдаем историю чата и начальное состояние
  engine.sendChatHistory(socket);
  engine.sendInitialState(socket);

  socket.on('joinTable', (data) => {
    const e = getEngineForSocket(socket);
    if (!e) return;

    const name = (data && data.playerName ? String(data.playerName) : '').trim() || 'Player';
    e.addPlayer(socket.id, name);
  });

  socket.on('startHand', () => {
    const e = getEngineForSocket(socket);
    if (!e) return;
    e.startHand();
  });

  socket.on('nextStage', () => {
    const e = getEngineForSocket(socket);
    if (!e) return;
    e.nextStage();
  });

  socket.on('action', (data) => {
    const e = getEngineForSocket(socket);
    if (!e) return;
    e.handleAction(socket.id, data);
  });

  socket.on('setPlaying', (data) => {
    const e = getEngineForSocket(socket);
    if (!e) return;
    const playing = !!(data && data.playing);
    e.setPlaying(socket.id, playing);
  });

  socket.on('chatMessage', (data) => {
    const e = getEngineForSocket(socket);
    if (!e) return;
    const rawText = data && data.text;
    if (!rawText || typeof rawText !== 'string') return;
    e.appendChat(socket.id, rawText);
  });

  socket.on('disconnect', () => {
    const e = getEngineForSocket(socket);
    const tableId = PLAYER_TABLE.get(socket.id);
    PLAYER_TABLE.delete(socket.id);

    if (e) {
      console.log(`[IO] Player disconnected: ${socket.id} from table ${tableId}`);
      e.removePlayer(socket.id);
      cleanupEmptyTables(e.limitId);
    } else {
      console.log('[IO] Player disconnected (no engine):', socket.id);
    }
  });
});

// ================= СТАРТ СЕРВЕРА =================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
});
