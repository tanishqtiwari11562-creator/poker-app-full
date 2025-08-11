
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
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" }});
const shortid = require('shortid');
const { Hand } = require('pokersolver');

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const MAX_SEATS = 9;
const DEFAULT_CHIPS = 200;
const START_SMALL = 10;
const START_BIG = 20;
const BLIND_INCREASE_EVERY = 10;
const BLIND_MULTIPLIER = 1.5;

let rooms = {};

function makeDeck(){
  const suits = ['s','h','d','c'];
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const deck = [];
  for(const r of ranks) for(const s of suits) deck.push(r+s);
  return deck;
}
function shuffle(deck){ for(let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; } }
function createRoom(){
  return {
    id: shortid.generate(),
    seats: Array(MAX_SEATS).fill(null),
    hostSocketId: null,
    dealerIndex: -1,
    deck: [],
    community: [],
    pot: 0,
    stage: 'lobby',
    currentBet: 0,
    toActSeat: null,
    pendingSeats: new Set(),
    handCount: 0,
    smallBlind: START_SMALL,
    bigBlind: START_BIG
  };
}

function findSeatBySocket(room, socketId){ return room.seats.findIndex(s => s && s.socketId === socketId); }
function nextOccupiedSeat(room, idx){
  for(let i=1;i<=MAX_SEATS;i++){ const s=(idx+i)%MAX_SEATS; if(room.seats[s]) return s; } return -1;
}
function countActivePlayers(room){ return room.seats.filter(s => s && s.status !== 'folded' && s.chips > 0).length; }

function broadcastState(room){
  const pub = {
    seats: room.seats.map(s => s ? { name: s.name, chips: s.chips, status: s.status, seatIndex: s.seatIndex } : null),
    community: room.community,
    pot: room.pot,
    stage: room.stage,
    currentBet: room.currentBet,
    toActSeat: room.toActSeat,
    dealerIndex: room.dealerIndex,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    handCount: room.handCount
  };
  io.to(room.id).emit('state', pub);
  room.seats.forEach(s => { if(s){ const sockId = s.socketId; if(io.sockets.sockets.get(sockId)) io.to(sockId).emit('yourHand', { cards: s.cards || [], chips: s.chips }); } });
}

function resetBetsForRound(room){
  room.seats.forEach(s => { if(s) s.currentBet = 0; });
  room.currentBet = 0;
  room.pendingSeats = new Set(room.seats.map((s,i) => s && s.chips>0 && s.status==='in' ? i : -1).filter(i=>i!==-1));
}

function computeSidePots(room){
  const contribs = room.seats.map((s,i)=> s ? {seat:i, c:s.totalContrib} : null).filter(x=>x && x.c>0);
  const pots = [];
  while(contribs.length>0){
    const minC = Math.min(...contribs.map(x=>x.c));
    const eligible = contribs.map(x=>x.seat);
    const potAmount = minC * contribs.length;
    pots.push({amount: potAmount, eligible: eligible.slice()});
    contribs.forEach(x => x.c -= minC);
    for(let i=contribs.length-1;i>=0;i--) if(contribs[i].c===0) contribs.splice(i,1);
  }
  return pots;
}

function resolveShowdown(room){
  const pots = computeSidePots(room);
  const results = [];
  const community = room.community.slice();
  for(const pot of pots){
    const eligible = pot.eligible.filter(si => { const s = room.seats[si]; return s && s.status !== 'folded'; });
    if(eligible.length===0) continue;
    const hands = eligible.map(si => { const s = room.seats[si]; const cards = (s.cards || []).concat(community); const solved = Hand.solve(cards); return {seat: si, hand: solved}; });
    const winners = Hand.winners(hands.map(h=>h.hand));
    const winningSeats = hands.filter(h => winners.some(w => w.descr === h.hand.descr)).map(h=>h.seat);
    const share = Math.floor(pot.amount / winningSeats.length);
    const split = {};
    winningSeats.forEach(si => { split[si] = share; room.seats[si].chips += share; });
    const rem = pot.amount - share * winningSeats.length;
    if(rem>0){ const sorted = winningSeats.slice().sort((a,b)=>a-b); room.seats[sorted[0]].chips += rem; split[sorted[0]] += rem; }
    results.push({amount: pot.amount, winners: winningSeats, split});
  }
  return results;
}

function awardSoleWinner(room, winnerSeat){
  room.seats[winnerSeat].chips += room.pot;
  const res = {amount: room.pot, winners: [winnerSeat], split: {[winnerSeat]: room.pot}};
  room.pot = 0;
  return [res];
}

function startHand(room){
  const seated = room.seats.map((s,i)=> s ? i : -1).filter(i=>i!==-1);
  if(seated.length < 2) return false;
  room.dealerIndex = nextOccupiedSeat(room, room.dealerIndex === -1 ? MAX_SEATS-1 : room.dealerIndex);
  room.deck = makeDeck(); shuffle(room.deck);
  room.community = []; room.pot = 0; room.stage = 'preflop'; room.handCount += 1;
  if(room.handCount > 1 && ((room.handCount-1) % BLIND_INCREASE_EVERY) === 0){
    room.smallBlind = Math.max(1, Math.round(room.smallBlind * BLIND_MULTIPLIER));
    room.bigBlind = Math.max(room.smallBlind*2, Math.round(room.bigBlind * BLIND_MULTIPLIER));
  }
  room.seats.forEach((s,i) => { if(s){ s.cards = []; s.currentBet = 0; s.totalContrib = 0; if(s.chips<=0) s.status = 'out'; else s.status='in'; } });
  room.seats.forEach(s=>{ if(s && s.status==='in'){ s.cards = [room.deck.pop(), room.deck.pop()]; } });
  const sbSeat = nextOccupiedSeat(room, room.dealerIndex);
  const bbSeat = nextOccupiedSeat(room, sbSeat);
  function postBlind(playerSeat, amount){ const p = room.seats[playerSeat]; const take = Math.min(p.chips, amount); p.chips -= take; p.currentBet += take; p.totalContrib += take; room.pot += take; if(p.chips === 0) p.status = 'allin'; }
  postBlind(sbSeat, room.smallBlind); postBlind(bbSeat, room.bigBlind);
  room.currentBet = Math.max(room.currentBet, room.seats[bbSeat].currentBet);
  room.toActSeat = nextOccupiedSeat(room, bbSeat);
  resetBetsForRound(room);
  broadcastState(room);
  return true;
}

function advanceToNextAct(room){
  if(!room) return;
  if(countActivePlayers(room) === 1){
    const winnerSeat = room.seats.findIndex(s => s && s.status !== 'folded' && s.chips >= 0);
    const res = awardSoleWinner(room, winnerSeat);
    io.to(room.id).emit('hand_result', {results: res, reason: 'only one player left'});
    room.stage = 'lobby'; broadcastState(room); return;
  }
  if(room.pendingSeats.size === 0){
    if(room.stage === 'preflop'){ room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); room.stage='flop'; }
    else if(room.stage === 'flop'){ room.community.push(room.deck.pop()); room.stage='turn'; }
    else if(room.stage === 'turn'){ room.community.push(room.deck.pop()); room.stage='river'; }
    else if(room.stage === 'river'){ room.stage='showdown'; const results = resolveShowdown(room); room.pot = 0; io.to(room.id).emit('hand_result', {results, reason:'showdown'}); room.stage='lobby'; broadcastState(room); return; }
    resetBetsForRound(room); room.toActSeat = nextOccupiedSeat(room, room.dealerIndex); broadcastState(room); return;
  } else { let attempt = room.toActSeat; let tries=0; while(tries<MAX_SEATS){ if(room.pendingSeats.has(attempt)){ room.toActSeat = attempt; break; } attempt=(attempt+1)%MAX_SEATS; tries++; } broadcastState(room); return; }
}

// socket handlers
io.on('connection', (socket) => {
  socket.on('createRoom', ({name}) => {
    const room = createRoom();
    room.hostSocketId = socket.id;
    rooms[room.id] = room;
    const seatIndex = room.seats.findIndex(s=>s===null);
    room.seats[seatIndex] = { socketId: socket.id, name: name || 'Host', chips: DEFAULT_CHIPS, cards: [], status: 'waiting', currentBet:0, totalContrib:0, seatIndex };
    socket.join(room.id);
    socket.emit('roomCreated', { roomId: room.id });
    broadcastState(room);
  });

  socket.on('joinRoom', ({roomId, name}) => {
    if(!rooms[roomId]){ socket.emit('errorMsg','Room not found'); return; }
    const room = rooms[roomId];
    const seatIndex = room.seats.findIndex(s=>s===null);
    if(seatIndex === -1){ socket.emit('errorMsg','Room full (9)'); return; }
    room.seats[seatIndex] = { socketId: socket.id, name: name || 'Player', chips: DEFAULT_CHIPS, cards: [], status: 'waiting', currentBet:0, totalContrib:0, seatIndex };
    socket.join(room.id);
    if(!room.hostSocketId) room.hostSocketId = socket.id;
    socket.emit('joined', {roomId: room.id, seatIndex});
    broadcastState(room);
  });

  socket.on('sit', ({roomId, seatIndex, name}) => {
    const room = rooms[roomId]; if(!room) return;
    if(seatIndex<0||seatIndex>=MAX_SEATS) return;
    if(room.seats[seatIndex]){ socket.emit('errorMsg','Seat taken'); return; }
    room.seats[seatIndex] = { socketId: socket.id, name: name || 'Player', chips: DEFAULT_CHIPS, cards: [], status:'waiting', currentBet:0, totalContrib:0, seatIndex };
    socket.join(room.id);
    if(!room.hostSocketId) room.hostSocketId = socket.id;
    broadcastState(room);
  });

  socket.on('leaveSeat', ({roomId}) => {
    const room = rooms[roomId]; if(!room) return;
    const seatIdx = findSeatBySocket(room, socket.id);
    if(seatIdx !== -1){ room.seats[seatIdx] = null; if(room.hostSocketId === socket.id){ const next = room.seats.find(s=>s); room.hostSocketId = next ? next.socketId : null; } socket.leave(roomId); broadcastState(room); }
  });

  socket.on('startGame', ({roomId}) => {
    const room = rooms[roomId]; if(!room) return;
    if(socket.id !== room.hostSocketId){ socket.emit('errorMsg','Only host can start'); return; }
    const active = room.seats.filter(s=>s && s.chips>0);
    if(active.length<2){ socket.emit('errorMsg','Need 2+ players with chips'); return; }
    const ok = startHand(room);
    if(!ok){ socket.emit('errorMsg','Cannot start'); return; }
    broadcastState(room);
  });

  socket.on('action', ({roomId, action, amount}) => {
    const room = rooms[roomId]; if(!room) return;
    const seatIdx = findSeatBySocket(room, socket.id);
    if(seatIdx===-1) return;
    const player = room.seats[seatIdx];
    if(!player || player.status==='folded' || player.status==='out') return;
    if(room.toActSeat !== seatIdx){ socket.emit('errorMsg','Not your turn'); return; }

    if(action === 'fold'){ player.status='folded'; room.pendingSeats.delete(seatIdx); }
    else if(action === 'call'){ const diff = room.currentBet - player.currentBet; const take = Math.min(player.chips, diff); player.chips-=take; player.currentBet+=take; player.totalContrib+=take; room.pot+=take; if(player.chips===0) player.status='allin'; room.pendingSeats.delete(seatIdx); }
    else if(action === 'check'){ if(player.currentBet===room.currentBet){ room.pendingSeats.delete(seatIdx); } else { socket.emit('errorMsg','Cannot check'); return; } }
    else if(action === 'raise' || action === 'bet'){ const newBet = Math.max(parseInt(amount)||0, room.currentBet + room.bigBlind); const diff = newBet - player.currentBet; if(diff<=0){ socket.emit('errorMsg','Raise must increase'); return; } const take=Math.min(player.chips, diff); player.chips-=take; player.currentBet+=take; player.totalContrib+=take; room.pot+=take; room.currentBet=player.currentBet; room.pendingSeats = new Set(room.seats.map((s,i)=> s && s.status==='in' && s.chips>0 && i!==seatIdx ? i : -1).filter(i=>i!==-1)); }
    else if(action === 'allin'){ const take=player.chips; player.currentBet+=take; player.totalContrib+=take; player.chips=0; player.status='allin'; room.pot+=take; if(player.currentBet>room.currentBet){ room.currentBet=player.currentBet; room.pendingSeats = new Set(room.seats.map((s,i)=> s && s.status==='in' && s.chips>0 && i!==seatIdx ? i : -1).filter(i=>i!==-1)); } else { room.pendingSeats.delete(seatIdx); } }

    if(room.pendingSeats.size>0){
      let next=(seatIdx+1)%MAX_SEATS; let tries=0;
      while(tries<MAX_SEATS){ if(room.pendingSeats.has(next)) break; next=(next+1)%MAX_SEATS; tries++; }
      room.toActSeat = (tries>=MAX_SEATS)?null:next;
    } else room.toActSeat = null;

    broadcastState(room);
    if(room.pendingSeats.size===0) setTimeout(()=>advanceToNextAct(room), 300);
  });

  socket.on('getRoomState', ({roomId})=>{ const room=rooms[roomId]; if(!room) return; broadcastState(room); });

  socket.on('disconnecting', ()=>{
    for(const roomId of socket.rooms){
      if(rooms[roomId]){
        const room=rooms[roomId];
        const seatIdx=findSeatBySocket(room, socket.id);
        if(seatIdx!==-1){ room.seats[seatIdx]=null; if(room.hostSocketId===socket.id){ const next=room.seats.find(s=>s); room.hostSocketId=next?next.socketId:null; } io.to(roomId).emit('msg','A player left'); broadcastState(room); }
      }
    }
  });
});

http.listen(PORT, ()=>{ console.log('Poker server running on', PORT); });
