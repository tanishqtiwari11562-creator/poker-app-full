const socket = io();
const roomIdEl = document.getElementById('roomId');
const playerNameEl = document.getElementById('playerName');
const playersDiv = document.getElementById('players');
const yourHandDiv = document.getElementById('yourHand');
const communityDiv = document.getElementById('communityCards');

document.getElementById('createBtn').onclick = () => {
  socket.emit('createRoom', roomIdEl.value, playerNameEl.value);
};

document.getElementById('joinBtn').onclick = () => {
  socket.emit('joinRoom', roomIdEl.value, playerNameEl.value);
};

document.getElementById('startBtn').onclick = () => {
  socket.emit('startGame', roomIdEl.value);
};

socket.on('updatePlayers', (players) => {
  playersDiv.innerHTML = players.map(p => `${p.name} (₹${p.chips})`).join('<br>');
});

socket.on('gameStarted', (data) => {
  yourHandDiv.innerHTML = data.yourHand.map(c => `<div class="card">${c}</div>`).join('');
});

socket.on('dealFlop', (cards) => {
  communityDiv.innerHTML = cards.map(c => `<div class="card">${c}</div>`).join('');
});
