const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createDeck, dealCards } = require('./utils/poker');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

app.get('/', (req, res) => {
  res.send('Poker Server is running');
});

let table = {
  players: [],
  deck: [],
  turnIndex: 0,
};

io.on('connection', (socket) => {
  console.log('New player connected:', socket.id);

  socket.on('joinTable', (data) => {
    const player = {
      id: socket.id,
      name: data.playerName,
      hand: [],
    };

    if (table.players.length < 6) {
      table.players.push(player);
      console.log(\`Player joined: \${data.playerName}\`);

      if (table.players.length >= 2) {
        table.deck = createDeck();
        for (let p of table.players) {
          p.hand = dealCards(table.deck, 2);
        }
        broadcastGameState();
      }
    }
  });

  socket.on('disconnect', () => {
    table.players = table.players.filter(p => p.id !== socket.id);
    console.log('Player disconnected:', socket.id);
    broadcastGameState();
  });

  function broadcastGameState() {
    for (let p of table.players) {
      io.to(p.id).emit('gameState', {
        players: table.players.map(pl => ({ name: pl.name, id: pl.id })),
        yourCards: p.hand,
        currentTurn: table.players[table.turnIndex]?.id || null
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
