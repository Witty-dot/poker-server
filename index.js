const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { createDeck, dealCards } = require('./poker');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Отдаём фронтенд
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

// Состояние одного демо-стола
let table = {
  players: [],          // { id, name, stack, hand, inHand, hasFolded, betThisStreet, hasActedThisStreet }
  deck: [],
  communityCards: [],   // борд
  pot: 0,
  stage: 'waiting',     // waiting | preflop | flop | turn | river | showdown
  smallBlind: 10,
  bigBlind: 20,
  buttonIndex: 0,       // индекс дилера
  currentBet: 0,        // текущая ставка на этой улице
  currentTurnIndex: null
};

function activePlayers() {
  return table.players.filter(p => p.inHand && !p.hasFolded);
}

function resetHandState() {
  table.deck = [];
  table.communityCards = [];
  table.pot = 0;
  table.stage = 'waiting';
  table.currentBet = 0;
  table.currentTurnIndex = null;
  table.players.forEach(p => {
    p.hand = [];
    p.inHand = false;
    p.hasFolded = false;
    p.betThisStreet = 0;
    p.hasActedThisStreet = false;
  });
}

// Старт новой раздачи
function startHand() {
  if (table.players.length < 2) {
    console.log('Not enough players to start hand');
    return;
  }

  // Подготовка
  table.deck = createDeck();
  table.communityCards = [];
  table.pot = 0;
  table.stage = 'preflop';
  table.currentBet = 0;

  table.players.forEach(p => {
    p.hand = [];
    p.inHand = true;
    p.hasFolded = false;
    p.betThisStreet = 0;
    p.hasActedThisStreet = false;
  });

  // Раздать по 2 карты каждому
  for (let r = 0; r < 2; r++) {
    for (const p of table.players) {
      const card = dealCards(table.deck, 1)[0];
      if (card) {
        p.hand.push(card);
      }
    }
  }

  const len = table.players.length;

  // Блайнды: дилер = buttonIndex, далее SB, BB, UTG
  const sbIndex = (table.buttonIndex + 1) % len;
  const bbIndex = (table.buttonIndex + 2) % len;
  const utgIndex = (table.buttonIndex + 3) % len;

  function takeBlind(playerIndex, amount) {
    const player = table.players[playerIndex];
    if (!player) return;
    const blind = Math.min(player.stack, amount);
    player.stack -= blind;
    player.betThisStreet += blind;
    table.pot += blind;
  }

  takeBlind(sbIndex, table.smallBlind);
  takeBlind(bbIndex, table.bigBlind);

  table.currentBet = table.bigBlind;
  table.currentTurnIndex = utgIndex;

  console.log('Hand started. Pot:', table.pot, 'Stage:', table.stage);
}

// Раздаём борд
function dealCommunity(count) {
  // Burn
  if (table.deck.length > 0) {
    table.deck.pop();
  }
  for (let i = 0; i < count; i++) {
    const card = dealCards(table.deck, 1)[0];
    if (card) {
      table.communityCards.push(card);
    }
  }
}

// Начать новую улицу (flop / turn / river)
function startNewStreet(newStage) {
  table.stage = newStage;
  table.currentBet = 0;
  table.players.forEach(p => {
    p.betThisStreet = 0;
    p.hasActedThisStreet = false;
  });

  // ход с первого активного игрока после баттона
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
    if (p.inHand && !p.hasFolded) {
      table.currentTurnIndex = idx;
      break;
    }
  }
}

// Проверка: закончился ли цикл ставок на улице
function isBettingRoundComplete() {
  const actives = activePlayers();
  if (actives.length <= 1) return true;

  return actives.every(p => p.hasActedThisStreet && p.betThisStreet === table.currentBet);
}

// Переход по стадиям
function nextStage() {
  if (table.stage === 'waiting') {
    startHand();
    return;
  }

  if (['preflop', 'flop', 'turn', 'river'].includes(table.stage)) {
    if (!isBettingRoundComplete()) {
      console.log('Betting round is not complete yet');
      return;
    }

    const actives = activePlayers();
    if (actives.length <= 1) {
      table.stage = 'showdown';
      table.currentTurnIndex = null;
      return;
    }

    if (table.stage === 'preflop') {
      dealCommunity(3); // flop
      startNewStreet('flop');
    } else if (table.stage === 'flop') {
      dealCommunity(1); // turn
      startNewStreet('turn');
    } else if (table.stage === 'turn') {
      dealCommunity(1); // river
      startNewStreet('river');
    } else if (table.stage === 'river') {
      table.stage = 'showdown';
      table.currentTurnIndex = null;
    }
    return;
  }

  if (table.stage === 'showdown') {
    // Новая раздача: сдвигаем баттон
    if (table.players.length > 0) {
      table.buttonIndex = (table.buttonIndex + 1) % table.players.length;
    }
    resetHandState();
  }
}

// Формируем состояние для конкретного игрока
function getPublicStateFor(playerId) {
  const player = table.players.find(p => p.id === playerId);
  const current =
    table.currentTurnIndex !== null &&
    table.players[table.currentTurnIndex]
      ? table.players[table.currentTurnIndex].id
      : null;

  return {
    stage: table.stage,
    pot: table.pot,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    communityCards: table.communityCards,
    players: table.players.map(p => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      inHand: p.inHand && !p.hasFolded
    })),
    yourCards: player ? player.hand : [],
    currentTurn: current
  };
}

// Рассылка состояния всем игрокам
function broadcastGameState() {
  for (const p of table.players) {
    io.to(p.id).emit('gameState', getPublicStateFor(p.id));
  }
}

// Переход хода к следующему активному
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
    if (p.inHand && !p.hasFolded) {
      table.currentTurnIndex = idx;
      return;
    }
  }

  table.currentTurnIndex = null;
}

// Обработка действия игрока
function handlePlayerAction(playerId, actionType) {
  const idx = table.players.findIndex(p => p.id === playerId);
  if (idx < 0) return;

  const player = table.players[idx];

  if (!player.inHand || player.hasFolded) return;
  if (table.stage === 'waiting' || table.stage === 'showdown') return;

  if (table.currentTurnIndex === null || table.players[table.currentTurnIndex].id !== playerId) {
    console.log('Not this player\'s turn');
    return;
  }

  // fold / check / call / bet (фиксированный 10)
  if (actionType === 'fold') {
    player.hasFolded = true;
    player.inHand = false;
    player.hasActedThisStreet = true;

    const actives = activePlayers();
    if (actives.length <= 1) {
      table.stage = 'showdown';
      table.currentTurnIndex = null;
    } else {
      advanceTurn();
    }
    return;
  }

  if (actionType === 'check') {
    // check возможен только если уравнивать нечего
    if (player.betThisStreet < table.currentBet) {
      console.log('Cannot check, need to call');
      return;
    }
    player.hasActedThisStreet = true;

    if (isBettingRoundComplete()) {
      table.currentTurnIndex = null;
    } else {
      advanceTurn();
    }
    return;
  }

  if (actionType === 'call') {
    const toCall = table.currentBet - player.betThisStreet;
    if (toCall <= 0) {
      // Нечего коллировать — считаем как check
      if (player.betThisStreet === table.currentBet) {
        player.hasActedThisStreet = true;
        if (isBettingRoundComplete()) {
          table.currentTurnIndex = null;
        } else {
          advanceTurn();
        }
      }
      return;
    }

    const pay = Math.min(player.stack, toCall);
    if (pay <= 0) return;

    player.stack -= pay;
    player.betThisStreet += pay;
    table.pot += pay;
    player.hasActedThisStreet = true;

    if (isBettingRoundComplete()) {
      table.currentTurnIndex = null;
    } else {
      advanceTurn();
    }
    return;
  }

  if (actionType === 'bet') {
    // фиксируем "бет/рейз" на +10 поверх текущей ставки
    const targetBet = table.currentBet + 10;
    const toPay = targetBet - player.betThisStreet;
    const pay = Math.min(player.stack, toPay);

    if (pay <= 0) {
      console.log('Cannot bet/raise, no chips');
      return;
    }

    player.stack -= pay;
    player.betThisStreet += pay;
    table.pot += pay;
    table.currentBet = player.betThisStreet;
    player.hasActedThisStreet = true;

    // после рейза остальные должны принять решение заново
    for (const p of table.players) {
      if (p.id !== player.id && p.inHand && !p.hasFolded) {
        p.hasActedThisStreet = false;
      }
    }

    const actives = activePlayers();
    if (actives.length <= 1) {
      table.stage = 'showdown';
      table.currentTurnIndex = null;
    } else {
      advanceTurn();
    }
  }
}

// Логика Socket.IO
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
      hasActedThisStreet: false
    };

    table.players.push(player);
    console.log(`Player joined: ${name}`);
    broadcastGameState();
  });

  socket.on('startHand', () => {
    console.log('startHand requested');
    startHand();
    broadcastGameState();
  });

  socket.on('nextStage', () => {
    console.log('nextStage requested');
    nextStage();
    broadcastGameState();
  });

  socket.on('action', (data) => {
    const type = data && data.type;
    console.log('action from', socket.id, type);
    if (!type) return;
    handlePlayerAction(socket.id, type);
    broadcastGameState();
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const idx = table.players.findIndex(p => p.id === socket.id);
    if (idx >= 0) {
      table.players.splice(idx, 1);
      if (table.players.length === 0) {
        resetHandState();
      } else {
        const actives = activePlayers();
        if (actives.length <= 1 && table.stage !== 'waiting') {
          table.stage = 'showdown';
          table.currentTurnIndex = null;
        }
      }
      broadcastGameState();
    }
  });

  // При подключении сразу отдаём состояние
  socket.emit('gameState', getPublicStateFor(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
});
