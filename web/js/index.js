const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createDeck, dealCards } = require('./poker');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ================= Debug-лог для анализа раздач =================

const debugLog = [];
const chatLog = []; // лог чата

/**
 * Снимаем снапшот стола и пишем в лог.
 * reason — строка "почему" мы делаем снимок (после действия, после шоудауна и т.п.)
 */
function pushSnapshot(reason, table) {
  const snapshot = {
    ts: new Date().toISOString(),
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
  if (debugLog.length > 200) {
    debugLog.shift(); // держим последние 200 шагов
  }

  console.log('[SNAPSHOT]', reason, JSON.stringify(snapshot));
}

// Отдаём фронтенд
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Просмотр лога: текстом, чтобы можно было скопировать в чат
app.get('/log', (req, res) => {
  if (!debugLog.length) {
    return res.type('text/plain').send('Лог пустой');
  }

  const text = debugLog.map(s => {
    const lines = [];
    lines.push(`[${s.ts}] ${s.reason}`);
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

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
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

// ================= Состояние стола =================

const TURN_TIMEOUT_MS = 30000;      // 30 секунд на ход
const NEXT_HAND_DELAY_MS = 6000;    // 6 секунд показать шоудаун и начать новую

let turnTimer = null;
let nextHandTimer = null;

let table = {
  players: [],          // { id, name, stack, hand, inHand, hasFolded, betThisStreet, hasActedThisStreet, message, isPaused, hasClickedThisHand, totalBet }
  deck: [],
  communityCards: [],
  mainPot: 0,
  streetPot: 0,
  stage: 'waiting',     // waiting | preflop | flop | turn | river | showdown
  smallBlind: 10,
  bigBlind: 20,
  buttonIndex: 0,
  currentBet: 0,
  minRaise: 10,
  currentTurnIndex: null,
  lastLogMessage: '',
  turnDeadline: null,   // timestamp (ms) когда истекает ход текущего игрока
  potDetails: [],       // массив строк с расшифровкой банков (основной + сайд-поты)
  dealerDetails: null   // объединённый текст для крупье (многострочный)
};

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

// Общий банк как сумма totalBet (для контроля и сайд-потов)
function getTotalPotFromBets() {
  return table.players.reduce((sum, p) => sum + (p.totalBet || 0), 0);
}

// ================= Таймеры =================

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
  if (!p || !p.inHand || p.hasFolded || p.isPaused) return;

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

  // Доп защита от кривых автофолдов:
  // если по факту никто не ставил (у остальных betThisStreet == 0),
  // то всегда трактуем как чек, даже если вдруг currentBet > 0.
  const others = activePlayers().filter(pl => pl.id !== p.id);
  const someoneBet = others.some(pl => pl.betThisStreet > 0 && !pl.hasFolded);

  if (needToCall && someoneBet) {
    // есть реальная ставка против игрока -> автофолд + пауза
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
    scheduleTurnTimer();
    broadcastGameState();
  } else {
    // auto-check
    const prevClicked = p.hasClickedThisHand;

    handlePlayerAction(p.id, { type: 'call', isAuto: true }); // для toCall<=0 внутри это чек

    p.hasClickedThisHand = prevClicked; // возвращаем флаг клика

    table.lastLogMessage = `Игрок ${p.name} не сделал ход, авто-check`;

    pushSnapshot('after auto-check timeout', table);
    scheduleTurnTimer();
    broadcastGameState();
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
    console.log('Not enough active players to start hand');
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

  // сбрасываем раздачные поля
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

  // только активным (не на паузе и с фишками) включаем участие
  for (const idx of activeSeats) {
    table.players[idx].inHand = true;
  }

  // убеждаемся, что buttonIndex стоит на живом игроке
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

  // после блайндов сдаём карманные карты
  for (let r = 0; r < 2; r++) {
    for (const idx of activeSeats) {
      const p = table.players[idx];
      const card = dealCards(table.deck, 1)[0];
      if (card) p.hand.push(card);
    }
  }

  table.currentBet = table.bigBlind;
  table.minRaise = 10;
  table.currentTurnIndex = utgIndex;

  const sbPlayer = sbIndex != null ? table.players[sbIndex] : null;
  const bbPlayer = bbIndex != null ? table.players[bbIndex] : null;

  if (sbPlayer && bbPlayer) {
    table.lastLogMessage =
      `Игрок ${sbPlayer.name} поставил малый блайнд (${table.smallBlind}), ` +
      `игрок ${bbPlayer.name} поставил большой блайнд (${table.bigBlind})`;
  } else {
    table.lastLogMessage = 'Начата новая раздача';
  }

  console.log('Hand started. StreetPot:', table.streetPot, 'Stage:', table.stage);
  scheduleTurnTimer();
}

function dealCommunity(count) {
  if (table.deck.length > 0) {
    table.deck.pop(); // burn
  }
  for (let i = 0; i < count; i++) {
    const card = dealCards(table.deck, 1)[0];
    if (card) {
      table.communityCards.push(card);
    }
  }
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
    if (p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
      table.currentTurnIndex = idx;
      break;
    }
  }
  scheduleTurnTimer();
}

/**
 * Окончание раунда торговли:
 * - если остался один игрок — true
 * - иначе у всех, кто ещё МОЖЕТ ходить (stack > 0), должно быть
 *   betThisStreet === currentBet и hasActedThisStreet === true
 * - игроки с stack === 0 считаются all-in и не мешают переходу
 */
function isBettingRoundComplete() {
  const actives = activePlayers();
  if (actives.length <= 1) return true;

  return actives.every(p => {
    if (p.stack === 0) {
      // all-in игрок не обязан уравнивать текущую ставку
      return true;
    }
    return p.hasActedThisStreet && p.betThisStreet === table.currentBet;
  });
}

// ================= Шоудаун и авто-следующая раздача =================

// Построение основного и сайд-потов по totalBet всех игроков
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

    // перед стартом следующей руки: те, кто участвовал, но не нажимали кнопок -> в паузу
    table.players.forEach(p => {
      if (p.inHand && !p.hasClickedThisHand) {
        p.isPaused = true;
      }
    });

    const activeSeats = getActiveSeatIndices();
    if (activeSeats.length < 2) {
      // меньше двух играющих -> просто очищаем стол и ждём
      resetHandState();
      pushSnapshot('after showdown -> not enough players for next hand', table);
      broadcastGameState();
      return;
    }

    // двигаем баттон к следующему активному
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

  collapseStreetPot(); // всё в mainPot (для совместимости с логами)
  table.stage = 'showdown';
  table.currentTurnIndex = null;
  table.turnDeadline = null;

  table.potDetails = [];
  table.dealerDetails = null;

  resolveShowdown();
  pushSnapshot('after showdown', table);
  scheduleNextHandIfNeeded();
}

function resolveShowdown() {
  const contenders = activePlayers();
  const totalPotFromBets = getTotalPotFromBets();

  // обнуляем/готовим поля для детальной расшифровки
  table.potDetails = [];
  table.dealerDetails = null;

  // Никто не претендует
  if (contenders.length === 0) {
    table.mainPot = 0;
    table.streetPot = 0;
    table.players.forEach(p => { p.totalBet = 0; });
    const line = `Общий банк ${totalPotFromBets} фишек сгорел: к моменту шоудауна нет активных игроков.`;
    table.lastLogMessage = 'Банк сгорел (нет активных игроков)';
    table.potDetails.push(line);
    table.dealerDetails = table.potDetails.join('\n');
    return;
  }

  // Один претендент — все сфолдили / остальные в пасе
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

    console.log(`Winner by fold: ${winner.name}, +${totalPot}`);
    table.mainPot = 0;
    table.streetPot = 0;
    table.lastLogMessage = `Банк ${totalPot} фишек без вскрытия забрал игрок ${winner.name}`;

    table.potDetails.push(
      `Общий банк: ${totalPot} фишек. Все остальные игроки сбросили карты, ` +
      `игрок ${winner.name} забирает весь банк без вскрытия.`
    );
    table.dealerDetails = table.potDetails.join('\n');
    return;
  }

  // Нормальный шоудаун с несколькими игроками -> считаем руки и сайд-поты
  const results = contenders.map(p => {
    const cards7 = [...p.hand, ...table.communityCards];
    const { score, hand } = evaluate7(cards7);
    const text = describeHandScore(score);
    const comboCards = extractComboCards(score, hand || []);
    return { player: p, score, text, best5: hand, comboCards };
  });

  const handMap = {};
  results.forEach(r => {
    handMap[r.player.id] = r;
  });

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
    // eligibleIds — те, кто вложился в этот уровень и не фолднул
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

  // Сообщения игрокам
  table.players.forEach(p => {
    const winAmount = perPlayerWin[p.id] || 0;
    const res = handMap[p.id]; // есть только у тех, кто дошёл до шоудауна

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

    // обнуляем вклад после раздачи
    p.totalBet = 0;
  });

  console.log('Showdown pots:', potSummaries.join(' | '), 'totalPot:', totalPot);

  table.mainPot = 0;
  table.streetPot = 0;
  table.lastLogMessage = pots.length > 0
    ? `Шоудаун. ${potSummaries.join(' | ')}. Общий банк: ${totalPot}`
    : `Шоудаун. Общий банк: ${totalPot}`;

  table.potDetails = detailLines;
  table.dealerDetails = detailLines.join('\n');
}

// ================= Авто-переход улиц =================

function autoAdvanceIfReady() {
  const stages = ['preflop', 'flop', 'turn', 'river'];
  if (!stages.includes(table.stage)) return;

  const actives = activePlayers();
  if (actives.length <= 1) {
    goToShowdown();
    return;
  }

  if (!isBettingRoundComplete()) return;

  // если ВСЕ активные игроки уже all-in (stack === 0),
  // сразу докладываем все оставшиеся карты и идём в шоудаун
  const allAllIn = actives.every(p => p.stack === 0);
  if (allAllIn) {
    collapseStreetPot();

    if (table.stage === 'preflop') {
      dealCommunity(3); // flop
      dealCommunity(1); // turn
      dealCommunity(1); // river
    } else if (table.stage === 'flop') {
      dealCommunity(1); // turn
      dealCommunity(1); // river
    } else if (table.stage === 'turn') {
      dealCommunity(1); // river
    }
    goToShowdown();
    return;
  }

  // обычный переход улиц
  collapseStreetPot();

  if (table.stage === 'preflop') {
    dealCommunity(3);
    startNewStreet('flop');
  } else if (table.stage === 'flop') {
    dealCommunity(1);
    startNewStreet('turn');
  } else if (table.stage === 'turn') {
    dealCommunity(1);
    startNewStreet('river');
  } else if (table.stage === 'river') {
    goToShowdown();
  }
}

// ================= Состояние для клиента =================

function getBestHandForPlayer(player) {
  if (!player) return null;
  const cards7 = [...player.hand, ...table.communityCards];
  if (cards7.length < 5) return null;
  return evaluate7(cards7); // { score, hand }
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
    if (p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
      table.currentTurnIndex = idx;
      return;
    }
  }

  table.currentTurnIndex = null;
  clearTurnTimer();
}

// ================= Обработка действий игрока =================

/**
 * action: { type: 'fold'|'call'|'bet'|'allin', amount?: number, isAuto?: boolean }
 */
function handlePlayerAction(playerId, action) {
  if (!action || !action.type) return;
  const actionType = action.type;
  const isAuto = !!action.isAuto;

  const idx = table.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;

  const player = table.players[idx];

  if (!player.inHand || player.hasFolded || player.isPaused) return;
  if (table.stage === 'waiting' || table.stage === 'showdown') return;

  if (table.currentTurnIndex === null || table.players[table.currentTurnIndex].id !== playerId) {
    console.log('Not this player\'s turn');
    return;
  }

  // помечаем, что игрок сам что-то нажимал в этой раздаче (кроме авто-действий таймера)
  if (!isAuto) {
    player.hasClickedThisHand = true;
  }

  // FOLD
  if (actionType === 'fold') {
    player.hasFolded = true;
    player.inHand = false;
    player.hasActedThisStreet = true;
    table.lastLogMessage = `Игрок ${player.name} сделал фолд`;

    const actives = activePlayers();
    if (actives.length <= 1) {
      goToShowdown();
    } else {
      advanceTurn();
      scheduleTurnTimer();
    }
    return;
  }

  // CALL / CHECK
  if (actionType === 'call') {
    const toCall = table.currentBet - player.betThisStreet;

    if (toCall <= 0) {
      // check
      player.hasActedThisStreet = true;
      table.lastLogMessage = `Игрок ${player.name} чек`;
      autoAdvanceIfReady();
      if (table.stage !== 'showdown' && !isBettingRoundComplete()) {
        advanceTurn();
        scheduleTurnTimer();
      }
      return;
    }

    const pay = Math.min(player.stack, toCall); // short-stack all-in
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

    autoAdvanceIfReady();
    if (table.stage !== 'showdown' && !isBettingRoundComplete()) {
      advanceTurn();
      scheduleTurnTimer();
    }
    return;
  }

  // ЯВНЫЙ ALL-IN
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

      // остальные должны принять решение
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

    autoAdvanceIfReady();
    if (table.stage !== 'showdown' && !isBettingRoundComplete()) {
      advanceTurn();
      scheduleTurnTimer();
    }
    return;
  }

  // BET / RAISE (поддержка кастомной суммы amount, иначе фикс +10)
  if (actionType === 'bet') {
    const minRaise = table.minRaise || 10;
    let rawAmount = null;

    if (typeof action.amount === 'number' && !Number.isNaN(action.amount)) {
      rawAmount = Math.max(0, Math.floor(action.amount));
    }

    if (table.currentBet === 0) {
      // первый бет на улице: amount — размер ставки, по умолчанию 10
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

      // остальные должны принять решение
      for (const p of table.players) {
        if (p.id !== player.id && p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
          p.hasActedThisStreet = false;
        }
      }

      advanceTurn();
      scheduleTurnTimer();
      return;
    } else {
      // рейз: amount трактуем как "рейз до", но не ниже currentBet + minRaise
      let desiredTarget = rawAmount && rawAmount > 0
        ? rawAmount
        : (table.currentBet + minRaise);

      if (desiredTarget < table.currentBet + minRaise) {
        desiredTarget = table.currentBet + minRaise;
      }

      const toPay = desiredTarget - player.betThisStreet;
      const pay = Math.min(player.stack, toPay); // может быть all-in меньше целевого
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

      // остальные снова должны принять решение
      for (const p of table.players) {
        if (p.id !== player.id && p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
          p.hasActedThisStreet = false;
        }
      }

      autoAdvanceIfReady();
      if (table.stage !== 'showdown' && !isBettingRoundComplete()) {
        advanceTurn();
        scheduleTurnTimer();
      }
      return;
    }
  }

  console.log('Unknown action:', actionType);
}

// ================= Socket.IO (игра + чат) =================

io.on('connection', (socket) => {
  console.log('New player connected:', socket.id);

  // отдаем историю чата новому подключению
  socket.emit('chatHistory', chatLog);

  socket.on('joinTable', (data) => {
    const name = (data && data.playerName ? String(data.playerName) : '').trim() || 'Player';

    if (table.players.find(p => p.id === socket.id)) {
      return;
    }

    const player = {
      id: socket.id,
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
      totalBet: 0
    };

    table.players.push(player);
    console.log(`Player joined: ${name}`);
    pushSnapshot('player joined', table);
    broadcastGameState();
  });

  socket.on('startHand', () => {
    console.log('startHand requested');
    startHand();
    pushSnapshot('after startHand', table);
    broadcastGameState();
  });

  // оставим nextStage как отладочную кнопку (можно скрыть на фронте)
  socket.on('nextStage', () => {
    console.log('nextStage requested');
    if (table.stage === 'showdown') {
      resetHandState();
      pushSnapshot('after manual resetHandState (new hand)', table);
    } else {
      autoAdvanceIfReady();
      pushSnapshot('after manual nextStage/autoAdvanceIfReady', table);
    }
    scheduleTurnTimer();
    broadcastGameState();
  });

  socket.on('action', (data) => {
    const type = data && data.type;
    console.log('action from', socket.id, type, data);
    if (!type) return;

    handlePlayerAction(socket.id, data);
    pushSnapshot(`after action ${type} from ${socket.id}`, table);
    broadcastGameState();
  });

  socket.on('setPlaying', (data) => {
    const playing = !!(data && data.playing);
    const player = table.players.find(p => p.id === socket.id);
    if (!player) return;

    player.isPaused = !playing;
    console.log(`Player ${player.name} setPlaying=${playing}`);
    pushSnapshot('setPlaying', table);
    broadcastGameState();
  });

  // ======== ЧАТ =========
  // data: { text: string }
  socket.on('chatMessage', (data) => {
    const rawText = data && data.text;
    if (!rawText || typeof rawText !== 'string') return;

    const text = rawText.trim();
    if (!text) return;

    const player = table.players.find(p => p.id === socket.id);
    const name = player ? player.name : 'Гость';

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      playerId: socket.id,
      name,
      text: text.slice(0, 500), // ограничим длину
      ts: new Date().toISOString()
    };

    chatLog.push(msg);
    if (chatLog.length > 200) {
      chatLog.shift();
    }

    io.emit('chatMessage', msg);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const idx = table.players.findIndex(p => p.id === socket.id);
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
  });

  socket.emit('gameState', getPublicStateFor(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
});
