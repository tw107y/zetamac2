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

function createGame(id, mode) {
  return {
    id,
    mode: mode || 'classic',
    state: 'lobby', // 'lobby' | 'playing' | 'finished'
    players: {
      1: { id: null, connected: false, reservedFor: null },
      2: { id: null, connected: false, reservedFor: null },
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

function killGame(game, reason) {
  // Cancel all timers
  for (const slot of [1, 2]) {
    if (game.players[slot]._graceTimer) {
      clearTimeout(game.players[slot]._graceTimer);
      game.players[slot]._graceTimer = null;
    }
  }
  if (game._cleanupTimer) clearTimeout(game._cleanupTimer);

  // Notify remaining player(s)
  for (const slot of [1, 2]) {
    if (game.players[slot].id) {
      io.to(game.players[slot].id).emit('host-left', { message: reason || 'Host left the game.' });
    }
  }

  games.delete(game.id);
  console.log(`[kill] ${game.id} — ${reason}`);
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
  socket.on('create-game', (data = {}) => {
    let gameId;
    do {
      gameId = crypto.randomUUID().slice(0, 6);
    } while (games.has(gameId));
    const mode = data.mode || 'classic';
    const game = createGame(gameId, mode);
    game.players[1] = { id: socket.id, connected: true };
    games.set(gameId, game);
    socket.join(gameId);
    socket.emit('game-created', { gameId, mode });
    socket.emit('joined', { playerNum: 1, gameId, isHost: true, mode });
    console.log(`[lobby] created ${gameId} mode=${mode} (host: ${socket.id})`);
  });

  // Join an existing game lobby
  socket.on('join-game', ({ gameId }) => {
    const game = games.get(gameId);

    if (!game) {
      socket.emit('error', { message: 'Game not found or expired.' });
      return;
    }

    // Check if this socket was previously in this game (same socket ID)
    const existingNum = getPlayerNum(game, socket.id);
    if (existingNum) {
      // Same socket reconnecting (Socket.IO reconnect)
      game.players[existingNum].connected = true;
      // Clear any pending grace timer from a previous disconnect
      if (game.players[existingNum]._graceTimer) {
        clearTimeout(game.players[existingNum]._graceTimer);
        game.players[existingNum]._graceTimer = null;
      }
      // Cancel cleanup timer so game isn't deleted during reconnect
      if (game._cleanupTimer) { clearTimeout(game._cleanupTimer); game._cleanupTimer = null; }
      game.players[existingNum].reservedFor = null;
      game.lastActivity = Date.now();
      socket.join(gameId);
      socket.emit('joined', { playerNum: existingNum, gameId, isHost: existingNum === 1, mode: game.mode });
      io.to(gameId).emit('lobby-update', lobbyState(game));
      const otherPn = existingNum === 1 ? 2 : 1;
      if (game.players[otherPn].id && game.players[otherPn].connected) {
        io.to(game.players[otherPn].id).emit('peer-joined');
      }
      return;
    }

    // Game is in progress — only the original players can reconnect
    if (game.state === 'playing') {
      // Check if this player was reserved for either slot
      let reservedSlot = null;
      for (const slot of [1, 2]) {
        if (game.players[slot].reservedFor) {
          // Allow if the URL contains a token that matches? For now, check
          // if the slot's old ID was recently disconnected (reservedFor is set)
          // Since we can't verify identity, allow if a slot is reserved
          // and the player knows the gameId URL
          reservedSlot = slot;
          break;
        }
      }
      if (!reservedSlot) {
        socket.emit('error', { message: 'Game in progress. Wait for it to finish.' });
        return;
      }
      // Fill the reserved slot with this new socket
      game.players[reservedSlot].id = socket.id;
      game.players[reservedSlot].connected = true;
      game.players[reservedSlot].reservedFor = null;
      // Cancel cleanup timer so game isn't deleted during reconnect
      if (game._cleanupTimer) { clearTimeout(game._cleanupTimer); game._cleanupTimer = null; }
      // Clear pending grace timer from the disconnect
      if (game.players[reservedSlot]._graceTimer) {
        clearTimeout(game.players[reservedSlot]._graceTimer);
        game.players[reservedSlot]._graceTimer = null;
      }
      game.lastActivity = Date.now();
      socket.join(gameId);
      socket.emit('joined', { playerNum: reservedSlot, gameId, isHost: reservedSlot === 1, mode: game.mode });
      io.to(gameId).emit('lobby-update', lobbyState(game));
      const otherPn = reservedSlot === 1 ? 2 : 1;
      if (game.players[otherPn].id && game.players[otherPn].connected) {
        io.to(game.players[otherPn].id).emit('peer-joined');
      }
      console.log(`[game] ${socket.id} reconnected to ${gameId} as player ${reservedSlot} (in-game)`);
      return;
    }

    // Lobby state — find any free (non-reserved) slot
    let assigned = null;
    for (const slot of [1, 2]) {
      if (!game.players[slot].id && !game.players[slot].reservedFor) {
        assigned = slot;
        break;
      }
    }

    if (!assigned) {
      socket.emit('error', { message: 'Lobby is full.' });
      return;
    }

    game.players[assigned] = { id: socket.id, connected: true, reservedFor: null };
    game.lastActivity = Date.now();
    socket.join(gameId);
    socket.emit('joined', { playerNum: assigned, gameId, isHost: assigned === 1, mode: game.mode });
    io.to(gameId).emit('lobby-update', lobbyState(game));

    // If both players connected, tell each about the other
    const p1Id = game.players[1].id;
    const p2Id = game.players[2].id;
    if (p1Id && p2Id) {
      io.to(p1Id).emit('peer-joined');
      io.to(p2Id).emit('peer-joined');
    }

    console.log(`[lobby] ${socket.id} joined ${gameId} as player ${assigned}`);
  });

  // WebRTC signaling relay (rate-limited)
  const signalTimestamps = [];
  socket.on('signal', (data) => {
    const now = Date.now();
    // Prune timestamps older than 1 second
    while (signalTimestamps.length && signalTimestamps[0] < now - 1000) {
      signalTimestamps.shift();
    }
    if (signalTimestamps.length >= 20) {
      console.warn(`[signal] rate limit exceeded for ${socket.id}`);
      return;
    }
    signalTimestamps.push(now);

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

  // Host notifies server that game has started
  socket.on('game-started', () => {
    const game = findGameForSocket(socket.id);
    if (!game) return;
    game.state = 'playing';
    game.lastActivity = Date.now();
    console.log(`[game] ${game.id} started (state=playing)`);
  });

  // Host notifies server that game has ended
  socket.on('game-ended', () => {
    const game = findGameForSocket(socket.id);
    if (!game) return;
    game.state = 'lobby';
    game.lastActivity = Date.now();
    // Free any reserved slots now that game is over
    for (const slot of [1, 2]) {
      if (game.players[slot]._graceTimer) {
        clearTimeout(game.players[slot]._graceTimer);
      }
      game.players[slot].reservedFor = null;
      if (!game.players[slot].connected) {
        game.players[slot].id = null;
      }
    }
    console.log(`[game] ${game.id} ended (state=lobby)`);
  });

  // Explicit leave (client navigates away or creates new game)
  socket.on('leave-game', () => {
    const game = findGameForSocket(socket.id);
    if (!game) return;
    const pn = getPlayerNum(game, socket.id);
    if (!pn) return;

    // If host leaves, kill the whole game
    if (pn === 1) {
      killGame(game, 'Host left the game');
      return;
    }

    // Non-host: leave the room and free the slot
    socket.leave(game.id);
    game.players[pn].id = null;
    game.players[pn].connected = false;
    game.players[pn].reservedFor = null;
    if (game.players[pn]._graceTimer) {
      clearTimeout(game.players[pn]._graceTimer);
      game.players[pn]._graceTimer = null;
    }
    const otherPn = pn === 1 ? 2 : 1;
    if (game.players[otherPn].id) {
      io.to(game.players[otherPn].id).emit('opponent-left');
      io.to(game.players[otherPn].id).emit('lobby-update', lobbyState(game));
    }
    console.log(`[leave] ${socket.id} left ${game.id}`);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const game = findGameForSocket(socket.id);
    if (!game) return;
    const pn = getPlayerNum(game, socket.id);
    if (!pn) return;

    // If host disconnects, kill the whole game immediately
    if (pn === 1) {
      killGame(game, 'Host disconnected');
      return;
    }

    game.players[pn].connected = false;

    const otherPn = pn === 1 ? 2 : 1;
    const otherId = game.players[otherPn].id;
    if (otherId) {
      io.to(otherId).emit('opponent-left');
      io.to(otherId).emit('lobby-update', lobbyState(game));
    }

    if (game.state === 'lobby') {
      // Pre-game: free the slot immediately so anyone can join
      game.players[pn].id = null;
      game.players[pn].reservedFor = null;
      console.log(`[lobby] freed slot ${pn} in ${game.id} (pre-game disconnect)`);
    } else {
      // In-game: reserve the slot for 15s for this player to reconnect
      game.players[pn].reservedFor = pn;
      const slot = pn;
      if (game.players[slot]._graceTimer) clearTimeout(game.players[slot]._graceTimer);
      game.players[slot]._graceTimer = setTimeout(() => {
        game.players[slot].id = null;
        game.players[slot].reservedFor = null;
        // If both gone, clean up
        if (!game.players[1].id && !game.players[2].id) {
          if (game._cleanupTimer) clearTimeout(game._cleanupTimer);
          game._cleanupTimer = setTimeout(() => {
            if (!game.players[1].id && !game.players[2].id) {
              games.delete(game.id);
              console.log(`[cleanup] deleted ${game.id} — both players left`);
            }
          }, 1000);
        }
      }, 15000);
      console.log(`[game] reserved slot ${slot} in ${game.id} for 15s (in-game disconnect)`);
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
