const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── In-memory lobby store ─────────────────────────────────────────────
const games = new Map();
const LOBBY_TTL = 10 * 60 * 1000; // 10 minutes
const CLEANUP_INTERVAL = 60 * 1000;

function createGame(id) {
  return {
    id,
    players: {
      1: { id: null, connected: false },
      2: { id: null, connected: false },
    },
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function getPlayerNum(game, socketId) {
  if (game.players[1].id === socketId) return 1;
  if (game.players[2].id === socketId) return 2;
  return null;
}

function lobbyState(game) {
  return {
    p1Connected: game.players[1].connected,
    p2Connected: game.players[2].connected,
  };
}

function findGameForSocket(socketId) {
  for (const game of games.values()) {
    if (game.players[1].id === socketId || game.players[2].id === socketId) {
      return game;
    }
  }
  return null;
}

// ── Socket.IO ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Create a new game lobby
  socket.on('create-game', () => {
    const gameId = crypto.randomUUID().slice(0, 6);
    const game = createGame(gameId);
    game.players[1] = { id: socket.id, connected: true };
    games.set(gameId, game);
    socket.join(gameId);
    socket.emit('game-created', { gameId });
    socket.emit('joined', { playerNum: 1, gameId, isHost: true });
    console.log(`[lobby] created ${gameId} (host: ${socket.id})`);
  });

  // Join an existing game lobby
  socket.on('join-game', ({ gameId }) => {
    const game = games.get(gameId);

    if (!game) {
      socket.emit('error', { message: 'Game not found or expired.' });
      return;
    }

    // Reconnect check
    const existingNum = getPlayerNum(game, socket.id);
    if (existingNum) {
      game.players[existingNum].connected = true;
      game.lastActivity = Date.now();
      socket.join(gameId);
      socket.emit('joined', { playerNum: existingNum, gameId, isHost: existingNum === 1 });
      io.to(gameId).emit('lobby-update', lobbyState(game));
      return;
    }

    // Find empty slot
    let assigned = null;
    for (const slot of [1, 2]) {
      if (!game.players[slot].id) {
        assigned = slot;
        break;
      }
    }

    if (!assigned) {
      socket.emit('error', { message: 'Lobby is full.' });
      return;
    }

    game.players[assigned] = { id: socket.id, connected: true };
    game.lastActivity = Date.now();
    socket.join(gameId);
    socket.emit('joined', { playerNum: assigned, gameId, isHost: false });
    io.to(gameId).emit('lobby-update', lobbyState(game));

    // Tell host to initiate WebRTC
    const hostSocketId = game.players[1].id;
    if (hostSocketId && assigned !== 1) {
      io.to(hostSocketId).emit('peer-joined');
    }

    console.log(`[lobby] ${socket.id} joined ${gameId} as player ${assigned}`);
  });

  // WebRTC signaling relay
  socket.on('signal', (data) => {
    const game = findGameForSocket(socket.id);
    if (!game) return;
    const pn = getPlayerNum(game, socket.id);
    if (!pn) return;
    const otherPn = pn === 1 ? 2 : 1;
    const otherId = game.players[otherPn].id;
    if (otherId) {
      io.to(otherId).emit('signal', data);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const game = findGameForSocket(socket.id);
    if (!game) return;
    const pn = getPlayerNum(game, socket.id);
    if (!pn) return;

    game.players[pn].id = null;
    game.players[pn].connected = false;

    const otherPn = pn === 1 ? 2 : 1;
    const otherId = game.players[otherPn].id;
    if (otherId) {
      io.to(otherId).emit('opponent-left');
      io.to(otherId).emit('lobby-update', lobbyState(game));
    }

    // If both gone, clean up after 15s
    if (!game.players[1].id && !game.players[2].id) {
      setTimeout(() => {
        if (!game.players[1].id && !game.players[2].id) {
          games.delete(game.id);
          console.log(`[cleanup] deleted ${game.id} — both players left`);
        }
      }, 15000);
    }
  });
});

// ── Lobby Cleanup ─────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games) {
    if (now - game.lastActivity > LOBBY_TTL) {
      io.to(id).emit('lobby-closed', { message: 'Lobby closed due to inactivity.' });
      games.delete(id);
      console.log(`[cleanup] deleted lobby ${id} (inactive)`);
    }
  }
}, CLEANUP_INTERVAL);

// ── Static serving (production) ───────────────────────────────────────
const distPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(distPath));
app.get('/{*path}', (req, res) => {
  if (!req.path.startsWith('/socket.io')) {
    res.sendFile(path.join(distPath, 'index.html'));
  }
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
