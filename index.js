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
  players: [],          // { id, name, stack, hand, inHand }
  deck: [],
  communityCards: [],   // борд
  pot: 0,
  stage: 'waiting',     // waiting | preflop | flop | turn | river | showdown
  smallBlind: 10,
  bigBlind: 20,
  buttonIndex: 0,       // индекс дилера
  currentTurnId: null
};

function resetHandState() {
  table.deck = [];
  table.communityCards = [];
  table.pot = 0;
  table.stage = 'waiting';
  table.currentTurnId = null;
  table.players.forEach(p => {
    p.hand = [];
    p.inHand = false;
  });
}

// Старт новой раздачи
function startHand() {
  if (table.players.length < 2) {
    console.log('Not enough players to start hand');
    return;
  }

  table.deck = createDeck();
  table.communityCards = [];
  table.pot = 0;

  table.players.forEach(p => {
    p.hand = [];
    p.inHand = true;
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

  // Условные блайнды (берём двух после дилера)
  const sbIndex = table.buttonIndex % table.players.length;
  const bbIndex = (table.buttonIndex + 1) % table.players.length;

  function takeBlind(player, amount) {
    if (!player) return 0;
    const blind = Math.min(player.stack, amount);
    player.stack -= blind;
    return blind;
  }

  const sbPlayer = table.players[sbIndex];
  const bbPlayer = table.players[bbIndex];

  table.pot = 0;
  table.pot += takeBlind(sbPlayer, table.smallBlind);
  table.pot += takeBlind(bbPlayer, table.bigBlind);

  table.stage = 'preflop';
  table.currentTurnId = table.players[(table.buttonIndex + 2) % table.players.length].id;

  console.log('Hand started. Pot:', table.pot);
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

// Переход по стадиям
function nextStage() {
  switch (table.stage) {
    case 'waiting':
      startHand();
      break;
    case 'preflop':
      dealCommunity(3); // flop
      table.stage = 'flop';
      break;
    case 'flop':
      dealCommunity(1); // turn
      table.stage = 'turn';
      break;
    case 'turn':
      dealCommunity(1); // river
      table.stage = 'river';
      break;
    case 'river':
      table.stage = 'showdown';
      console.log('Showdown');
      break;
    case 'showdown':
    default:
      table.buttonIndex = (table.buttonIndex + 1) % Math.max(table.players.length, 1);
      resetHandState();
      break;
  }
}

// Формируем состояние для конкретного игрока
function getPublicStateFor(playerId) {
  const player = table.players.find(p => p.id === playerId);
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
      inHand: p.inHand
    })),
    yourCards: player ? player.hand : [],
    currentTurn: table.currentTurnId
  };
}

// Рассылка состояния всем игрокам
function broadcastGameState() {
  for (const p of table.players) {
    io.to(p.id).emit('gameState', getPublicStateFor(p.id));
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
      inHand: false
    };

    if (table.players.length < 6) {
      table.players.push(player);
      console.log(`Player joined: ${name}`);
      broadcastGameState();
    } else {
      socket.emit('errorMessage', { message: 'Table is full' });
    }
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

  socket.on('bet', (data) => {
    const amount = Number(data && data.amount) || 0;
    if (amount <= 0) return;

    const player = table.players.find(p => p.id === socket.id);
    if (!player) return;

    const bet = Math.min(player.stack, amount);
    if (bet <= 0) return;

    player.stack -= bet;
    table.pot += bet;
    table.currentTurnId = socket.id;

    console.log(`Player ${player.name} (#${player.id}) bet ${bet}, pot=${table.pot}`);
    broadcastGameState();
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const idx = table.players.findIndex(p => p.id === socket.id);
    if (idx >= 0) {
      table.players.splice(idx, 1);
      if (table.players.length === 0) {
        resetHandState();
      }
      broadcastGameState();
    }
  });

  socket.emit('gameState', getPublicStateFor(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker server running on port ${PORT}`);
});
