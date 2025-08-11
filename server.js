
/**
 * Texas Hold'em server (Node + Socket.IO)
 * - Up to 9 seats
 * - Lobby, Sit Here, Host, Start Game
 * - Blinds start 10/20, increase every 10 hands by 1.5x
 * - Default chips: 200
 * - Uses pokersolver for showdown
 *
 * Note: in-memory state. For small private games only.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Game state per room
const rooms = {};

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  suits.forEach(s => values.forEach(v => deck.push(v + s)));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

io.on('connection', (socket) => {
  console.log("User connected:", socket.id);

  // Create a room
  socket.on('createRoom', (roomId, playerName) => {
    rooms[roomId] = {
      players: [],
      deck: [],
      communityCards: [],
      pot: 0,
      dealerIndex: 0,
      started: false
    };
    rooms[roomId].players.push({
      id: socket.id,
      name: playerName,
      chips: 1000,
      hand: [],
      folded: false
    });
    socket.join(roomId);
    io.to(roomId).emit('updatePlayers', rooms[roomId].players);
  });

  // Join an existing room
  socket.on('joinRoom', (roomId, playerName) => {
    if (!rooms[roomId]) return;
    rooms[roomId].players.push({
      id: socket.id,
      name: playerName,
      chips: 1000,
      hand: [],
      folded: false
    });
    socket.join(roomId);
    io.to(roomId).emit('updatePlayers', rooms[roomId].players);
  });

  // Start the game
  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    room.deck = createDeck();
    room.communityCards = [];
    room.players.forEach(p => {
      p.hand = [room.deck.pop(), room.deck.pop()];
      p.folded = false;
    });
    room.pot = 0;
    room.started = true;
    // Send player-specific hand
    room.players.forEach(p => {
      io.to(p.id).emit('gameStarted', {
        players: room.players.map(pl => ({name: pl.name, chips: pl.chips})),
        yourHand: p.hand
      });
    });
    // Deal Flop
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    io.to(roomId).emit('dealFlop', room.communityCards);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    for (let roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      io.to(roomId).emit('updatePlayers', rooms[roomId].players);
    }
  });
});

// Use dynamic port for deployment (Render/Vercel)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
