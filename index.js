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
      isPaused: !!p.isPaused
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
        `  - ${pl.name || pl.id}: stack=${pl.stack}, betThisStreet=${pl.betThisStreet}, inHand=${pl.inHand}, folded=${pl.hasFolded}, paused=${pl.isPaused}`
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

function evaluate7(cards7) {
  let best = 0;
  const n = cards7.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const hand5 = [cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]];
            const score = evaluate5(hand5);
            if (score > best) best = score;
          }
        }
      }
    }
  }
  return best;
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

// ================= Состояние стола =================

const TURN_TIMEOUT_MS = 30000;      // 30 секунд на ход
const NEXT_HAND_DELAY_MS = 3000;    // 3 секунды показать шоудаун и начать новую

let turnTimer = null;
let nextHandTimer = null;

let table = {
  players: [],          // { id, name, stack, hand, inHand, hasFolded, betThisStreet, hasActedThisStreet, message, isPaused, hasClickedThisHand }
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
  lastLogMessage: ''
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
  table.players.forEach(p => {
    p.hand = [];
    p.inHand = false;
    p.hasFolded = false;
    p.betThisStreet = 0;
    p.hasActedThisStreet = false;
    p.message = null;
    p.hasClickedThisHand = false;
  });
}

function collapseStreetPot() {
  table.mainPot += table.streetPot;
  table.streetPot = 0;
}

// ================= Таймеры =================

function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
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

  const needToCall = table.currentBet > p.betThisStreet;

  if (needToCall) {
    // должен был реагировать на ставку -> автофолд + пауза
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
    // можно было чекнуть -> авто-check, НЕ считаем как клик игрока
    p.hasActedThisStreet = true;
    table.lastLogMessage = `Игрок ${p.name} не сделал ход, авто-check`;

    autoAdvanceIfReady();
    if (table.stage !== 'showdown' && !isBettingRoundComplete()) {
      advanceTurn();
    }

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

  // сбрасываем раздачные поля
  table.players.forEach(p => {
    p.hand = [];
    p.inHand = false;
    p.hasFolded = false;
    p.betThisStreet = 0;
    p.hasActedThisStreet = false;
    p.message = null;
    p.hasClickedThisHand = false;
  });

  // только активным (не на паузе и с фишками) включаем участие и раздаём карты
  for (const idx of activeSeats) {
    table.players[idx].inHand = true;
  }

  for (let r = 0; r < 2; r++) {
    for (const idx of activeSeats) {
      const p = table.players[idx];
      const card = dealCards(table.deck, 1)[0];
      if (card) p.hand.push(card);
    }
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
    player.stack -= blind;
    player.betThisStreet += blind;
    table.streetPot += blind;
  }

  if (sbIndex != null) takeBlind(sbIndex, table.smallBlind);
  if (bbIndex != null) takeBlind(bbIndex, table.bigBlind);

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

function isBettingRoundComplete() {
  const actives = activePlayers();
  if (actives.length <= 1) return true;
  return actives.every(p => p.hasActedThisStreet && p.betThisStreet === table.currentBet);
}

// ================= Шоудаун и авто-следующая раздача =================

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

  collapseStreetPot();
  table.stage = 'showdown';
  table.currentTurnIndex = null;
  resolveShowdown();
  pushSnapshot('after showdown', table);
  scheduleNextHandIfNeeded();
}

function resolveShowdown() {
  const contenders = activePlayers();
  const totalPot = table.mainPot + table.streetPot;

  if (contenders.length === 0) {
    table.mainPot = 0;
    table.streetPot = 0;
    table.lastLogMessage = 'Банк сгорел (нет активных игроков)';
    return;
  }

  if (contenders.length === 1) {
    const winner = contenders[0];
    winner.stack += totalPot;
    winner.message = `Вы выиграли без вскрытия, банк: ${totalPot}`;
    table.players.forEach(p => {
      if (p.id !== winner.id) {
        p.message = `Игрок ${winner.name} забрал банк без вскрытия`;
      }
    });
    console.log(`Winner by fold: ${winner.name}, +${totalPot}`);
    table.mainPot = 0;
    table.streetPot = 0;
    table.lastLogMessage = `Банк ${totalPot} фишек без вскрытия забрал игрок ${winner.name}`;
    return;
  }

  const results = contenders.map(p => {
    const cards7 = [...p.hand, ...table.communityCards];
    const score = evaluate7(cards7);
    const text = describeHandScore(score);
    return { player: p, score, text };
  });

  const best = Math.max(...results.map(r => r.score));
  const winners = results.filter(r => r.score === best);

  const share = Math.floor(totalPot / winners.length);
  const remainder = totalPot - share * winners.length;

  winners.forEach(w => {
    w.player.stack += share;
  });
  if (remainder > 0) {
    winners[0].player.stack += remainder;
  }

  const winnersDesc = winners
    .map(w => `${w.player.name || 'Игрок'} — ${w.text}`)
    .join(', ');

  table.players.forEach(p => {
    const winRec = winners.find(w => w.player.id === p.id);
    if (winRec) {
      p.message = `Вы выиграли с комбинацией: ${winRec.text}. Банк: ${share + (winners[0].player.id === p.id ? remainder : 0)}`;
    } else {
      p.message = `Победитель(и): ${winnersDesc}. Общий банк: ${totalPot}`;
    }
  });

  console.log('Showdown winners:', winnersDesc, 'totalPot:', totalPot);
  table.mainPot = 0;
  table.streetPot = 0;
  table.lastLogMessage = `Шоудаун. Победитель(и): ${winnersDesc}. Банк: ${totalPot}`;
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

function getPublicStateFor(playerId) {
  const player = table.players.find(p => p.id === playerId);
  const current =
    table.currentTurnIndex !== null &&
    table.players[table.currentTurnIndex]
      ? table.players[table.currentTurnIndex].id
      : null;

  const totalPot = table.mainPot + table.streetPot;
  const btnPlayer = table.players[table.buttonIndex] || null;

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
    yourTurn: !!(player && current === player.id),
    message: player ? player.message || null : null
  };
}

function broadcastGameState() {
  for (const p of table.players) {
    io.to(p.id).emit('gameState', getPublicStateFor(p.id));
  }
}

// ================= Ход по кругу =================

function advanceTurn() {
  const len = table.players.length;
  if (len === 0) {
    table.currentTurnIndex = null;
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
}

// ================= Обработка действий игрока =================

function handlePlayerAction(playerId, actionType) {
  const idx = table.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;

  const player = table.players[idx];

  if (!player.inHand || player.hasFolded || player.isPaused) return;
  if (table.stage === 'waiting' || table.stage === 'showdown') return;

  if (table.currentTurnIndex === null || table.players[table.currentTurnIndex].id !== playerId) {
    console.log('Not this player\'s turn');
    return;
  }

  // помечаем, что игрок сам что-то нажимал в этой раздаче
  player.hasClickedThisHand = true;

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
      }
      return;
    }

    const pay = Math.min(player.stack, toCall);
    if (pay <= 0) return;

    player.stack -= pay;
    player.betThisStreet += pay;
    table.streetPot += pay;
    player.hasActedThisStreet = true;
    table.lastLogMessage = `Игрок ${player.name} колл ${pay}`;

    autoAdvanceIfReady();
    if (table.stage !== 'showdown' && !isBettingRoundComplete()) {
      advanceTurn();
    }
    return;
  }

  // BET / RAISE (фикс +10)
  if (actionType === 'bet') {
    const minRaise = table.minRaise || 10;

    if (table.currentBet === 0) {
      // первый бет на улице
      const toBet = Math.min(player.stack, 10);
      if (toBet <= 0) return;

      player.stack -= toBet;
      player.betThisStreet += toBet;
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
      return;
    } else {
      // рейз на +10 поверх текущей ставки
      const targetBet = table.currentBet + minRaise;
      const toPay = targetBet - player.betThisStreet;
      const pay = Math.min(player.stack, toPay);
      if (pay <= 0) return;

      player.stack -= pay;
      player.betThisStreet += pay;
      table.streetPot += pay;

      table.currentBet = player.betThisStreet;
      table.minRaise = minRaise;
      player.hasActedThisStreet = true;
      table.lastLogMessage = `Игрок ${player.name} рейз до ${player.betThisStreet}`;

      for (const p of table.players) {
        if (p.id !== player.id && p.inHand && !p.hasFolded && !p.isPaused && p.stack > 0) {
          p.hasActedThisStreet = false;
        }
      }

      advanceTurn();
      return;
    }
  }

  console.log('Unknown action:', actionType);
}

// ================= Socket.IO =================

io.on('connection', (socket) => {
  console.log('New player connected:', socket.id);

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
      hasClickedThisHand: false
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
    broadcastGameState();
  });

  socket.on('action', (data) => {
    const type = data && data.type;
    console.log('action from', socket.id, type);
    if (!type) return;

    handlePlayerAction(socket.id, type);
    pushSnapshot(`after action ${type} from ${socket.id}`, table);
    broadcastGameState();
    scheduleTurnTimer();
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
