# Zetamac Multiplayer — MVP Technical Plan

## Context

Greenfield project. Build a multiplayer mental-arithmetic game where two players compete in real-time, each seeing the other's screen side-by-side. MVP: minimal React UI, in-memory server state, Socket.IO for real-time sync.

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 18 + Vite | Fast dev, simple SPA |
| Real-time | Socket.IO (client + server) | Bidirectional events, built-in reconnection, room support |
| Server | Node.js + Express | Serves static files + Socket.IO on same port |
| State | In-memory JS Map | No DB needed for MVP lobbies |
| IDs | `crypto.randomUUID()` (Node built-in) | No extra dep |

**Zero build tooling for server** — single `server.js`, no TypeScript, no bundler.

---

## Project Structure

```
zetamac2/
├── package.json              # Server: express, socket.io
├── server.js                 # Express + Socket.IO, all game logic
├── client/
│   ├── package.json          # Client: react, react-dom, socket.io-client, vite
│   ├── index.html
│   ├── vite.config.js        # Proxy /socket.io to :3001 in dev
│   └── src/
│       ├── main.jsx
│       ├── App.jsx           # Route switch: menu | lobby | game
│       ├── socket.js         # Socket.IO singleton + event constants
│       └── components/
│           ├── MainMenu.jsx  # "Create Game" button
│           ├── Lobby.jsx     # Ready button, share link, opponent status
│           └── Game.jsx      # Side-by-side gameplay, timer, score
```

---

## npm Dependencies (no conflicts expected)

### Server (`package.json` at root)
```
npm install express socket.io
```
- `express` — HTTP server + static file serving
- `socket.io` — real-time events

### Client (`client/package.json`)
```
cd client && npm install react react-dom socket.io-client
npm install -D vite @vitejs/plugin-react
```
- `react`, `react-dom` — UI
- `socket.io-client` — connect to server
- `vite`, `@vitejs/plugin-react` — dev server + build

**No conflicts**: these are standard, well-isolated packages. Socket.IO v4 works with any Node 18+.

---

## How to Run (Development)

Terminal 1 (server):
```bash
node server.js          # Listens on :3001
```

Terminal 2 (client):
```bash
cd client && npx vite   # Listens on :5173, proxies /socket.io → :3001
```

Production: `cd client && npx vite build` → server serves `client/dist/` as static files.

---

## Network Architecture (the critical part)

### Socket.IO Event Table

| Direction | Event | Payload | When |
|---|---|---|---|
| C→S | `create-game` | `{}` | User clicks "Create Game" |
| S→C | `game-created` | `{ gameId: string }` | Server creates lobby |
| C→S | `join-game` | `{ gameId: string }` | Opponent opens shared link |
| S→C | `joined` | `{ playerNum: 1\|2, gameId }` | Confirmed join |
| S→all | `lobby-update` | `{ p1Ready, p2Ready, p1Connected, p2Connected }` | Any lobby state change |
| C→S | `player-ready` | `{}` | Player clicks "Ready" (toggle) |
| S→all | `countdown` | `{ num: 3\|2\|1 }` | Both ready, 3-2-1 starts |
| S→all | `game-start` | `{ problems: Problem[], startTime, duration: 60 }` | Countdown done |
| C→S | `player-update` | `{ problemIndex, input, score }` | ~10/sec during gameplay (throttled client-side) |
| S→C | `opponent-update` | `{ problemIndex, input, score }` | Relay opponent state |
| S→all | `game-over` | `{ scores: {1: n, 2: n} }` | 60s timer ends |
| C→S | `restart` | `{}` | Player wants rematch |
| S→all | `back-to-lobby` | `{}` | Both back in lobby, ready reset |
| C→S | `leave-game` | `{}` | Player navigates away |
| S→C | `opponent-left` | `{}` | Opponent disconnected/left |
| S→C | `error` | `{ message }` | Join failed, lobby full, etc. |

### Problem Structure
```js
{
  a: 24,           // left operand
  b: 7,            // right operand
  op: '+',         // '+' | '-' | '×' | '÷'
  answer: 31       // pre-computed server-side
}
```

Server pre-generates a pool of 100+ problems at game start. Both players get the **same sequence** — this makes the side-by-side view meaningful (you can see if they're on the same problem).

### Problem Generation (server-side)
```
Addition:       a ∈ [2,100], b ∈ [2,100], answer = a+b
Subtraction:    a ∈ [2,100], b ∈ [2,a],  answer = a-b  (never negative)
Multiplication: a ∈ [2,12],  b ∈ [2,100], answer = a*b
Division:       b ∈ [2,12],  answer ∈ [2,100], a = answer*b (always integer result)
```
Equal probability for each operation type.

### Data Flow During Gameplay

```
Player 1 types "3" → onChange fires
  → local state: input = "3"
  → throttle (100ms) → emit 'player-update' { problemIndex: 5, input: "3", score: 12 }
  → server receives → emit to Player 2 'opponent-update' { problemIndex: 5, input: "3", score: 12 }
  → Player 2's right panel renders: Problem: "24 + 7 = _" → opponent typed "3"
```

Input auto-validates: when `parseInt(input) === answer`, advance to next problem, increment score, clear input. Wrong input shows briefly in red then clears (or player hits Backspace/Enter).

### Throttling
Client emits `player-update` at most once every **100ms** (10 updates/sec). This is frequent enough for real-time feel but won't flood the server.

### Timer
Server sends `game-start` with a `startTime` (server timestamp). Each client runs a local `setInterval` counting down from `startTime + duration - Date.now()`. Server also runs its own timer and emits `game-over` when time's up. The server's timer is authoritative — clients stop when they receive `game-over`.

---

## Component Design

### `App.jsx` — Router
State: `{ screen: 'menu' | 'lobby' | 'game', gameId: null }`

No react-router needed. A simple switch on `screen` state:
- `/` → MainMenu
- `/:gameId` → Lobby or Game (determined by socket events)

On mount, check URL path. If `pathname !== '/'`, extract gameId and emit `join-game`.

### `MainMenu.jsx`
- One button: "Create Game"
- On click: emit `create-game`, on `game-created` → navigate to `/{gameId}`

### `Lobby.jsx`
Props: `{ gameId, socket }`
State: `{ ready, opponentReady, opponentConnected, countdown }`

Displays:
- "Share this link: `{window.location.href}`"
- Copy link button (uses `navigator.clipboard.writeText`)
- "Opponent: connected / waiting..."
- Ready button (toggle: "Ready" / "Unready")
- Countdown overlay when both ready (3, 2, 1 → Game component)
- Status text when waiting for opponent

Listens to: `lobby-update`, `countdown`, `game-start`, `opponent-left`

### `Game.jsx`
Props: `{ socket, problems, startTime, duration, playerNum, initialScores }`

This is the most complex component:

**State:**
```js
{
  timeLeft: 60,                    // countdown from duration
  myProblemIndex: 0,               // which problem am I on
  myInput: '',                     // current typed input
  myScore: 0,
  opponentProblemIndex: 0,
  opponentInput: '',
  opponentScore: 0,
  gameOver: false,
  myScores: {1: 0, 2: 0},        // final scores
}
```

**Layout (CSS Grid or Flexbox):**
```
┌──────────────────────────────────────┐
│          TIMER: 42s                   │
├──────────────────┬───────────────────┤
│   YOUR SCREEN    │  OPPONENT SCREEN  │
│   Score: 15      │  Score: 12        │
│                  │                   │
│   38 + 17 = _    │  38 + 17 = _      │
│   [input_____]   │  [typing: 5]      │
│                  │                   │
│  (you type here) │  (view only)      │
└──────────────────┴───────────────────┘
```

- Left panel: player's own game (interactive)
- Right panel: opponent's game (read-only mirror)
- Input auto-focuses and stays focused
- Auto-advance on correct answer: `parseInt(input) === problems[myProblemIndex].answer`
- Emit `player-update` on every input change (throttled 100ms)
- Listen to `opponent-update` to update right panel
- Listen to `game-over` to freeze game and show results
- "Play Again" button appears after game over → emit `restart`
- On `back-to-lobby` → go back to Lobby screen

**Input Behavior:**
```
onChange:
  - set myInput
  - if parseInt(newValue) === currentProblem.answer:
      score++, problemIndex++, clear input
  - schedule `player-update` emit (throttled)

onKeyDown:
  - Enter: if wrong → flash red, clear input
  - Escape: clear input
```

**Opponent Display (read-only):**
Shows the same problem the opponent is on, with their current typed digits displayed in the input area (greyed out, not editable).

---

## Server Design (`server.js`)

### Data Structures

```js
const games = new Map();  // gameId → Game object

// Game object shape:
{
  id: 'aB3xY9',
  players: {
    1: { id: socketId, ready: false, connected: true, score: 0, problemIndex: 0, input: '' },
    2: { id: null,       ready: false, connected: false, score: 0, problemIndex: 0, input: '' },
  },
  state: 'lobby',        // 'lobby' | 'countdown' | 'playing' | 'finished'
  problems: [],           // pre-generated when game starts
  startTime: null,
  duration: 60,
  createdAt: Date.now(),
  lastActivity: Date.now(),
  countdownTimer: null,
  gameTimer: null,
}
```

### Socket.IO Connection Handler

```
connection (socket):
  socket.on('create-game'):
    1. Generate 6-char gameId (crypto.randomUUID().slice(0, 6))
    2. Create Game object, player 1 = this socket
    3. socket.join(gameId)
    4. Emit 'game-created' { gameId }

  socket.on('join-game', { gameId }):
    1. Look up gameId in Map
    2. Validate: game exists, not expired, player 2 slot empty
    3. Assign player 2 = this socket
    4. socket.join(gameId)
    5. Emit 'joined' { playerNum: 2, gameId }
    6. Broadcast 'lobby-update' to room

  socket.on('player-ready'):
    1. Toggle ready state for this player
    2. Update lastActivity
    3. Broadcast 'lobby-update'
    4. If BOTH ready → start countdown

  socket.on('player-update', data):
    1. Update this player's state in game object
    2. Broadcast 'opponent-update' to other player

  socket.on('restart'):
    1. Reset scores, ready states
    2. Set state back to 'lobby'
    3. Broadcast 'back-to-lobby'

  socket.on('disconnect'):
    1. Find which game/player this socket belongs to
    2. Mark player as disconnected
    3. Notify opponent via 'opponent-left'
    4. If both disconnected → mark game for cleanup

  socket.on('leave-game'):
    1. Same as disconnect but explicit
```

### Countdown Logic
```
startCountdown(gameId):
  let count = 3
  countdownTimer = setInterval(() => {
    io.to(gameId).emit('countdown', { num: count })
    count--
    if (count < 0) {
      clearInterval(countdownTimer)
      startGame(gameId)
    }
  }, 1000)
```

### Game Start & End
```
startGame(gameId):
  game.state = 'playing'
  game.problems = generateProblems(120)
  game.startTime = Date.now()
  io.to(gameId).emit('game-start', { problems, startTime: game.startTime, duration: 60 })
  
  gameTimer = setTimeout(() => {
    endGame(gameId)
  }, 60000)

endGame(gameId):
  game.state = 'finished'
  io.to(gameId).emit('game-over', { scores: { 1: game.players[1].score, 2: game.players[2].score } })
```

### Lobby Cleanup (10-minute TTL)
```
setInterval(() => {
  const now = Date.now()
  for (const [id, game] of games) {
    if (now - game.lastActivity > 600_000) {  // 10 min
      io.to(id).emit('lobby-closed')
      games.delete(id)
    }
  }
}, 60_000)  // Check every 60 seconds
```

### Express Static Serving (Production)
```js
app.use(express.static('client/dist'))
app.get('*', (req, res) => res.sendFile('client/dist/index.html'))
```
In dev, Vite handles its own serving and proxies WebSocket to :3001.

---

## Vite Config

```js
// client/vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
})
```

---

## File-by-File Build Order

1. **`package.json`** — server dependencies, scripts
2. **`server.js`** — complete backend (Express + Socket.IO + game logic + cleanup)
3. **`client/package.json`** — client dependencies
4. **`client/vite.config.js`** — Vite config with WS proxy
5. **`client/index.html`** — HTML shell
6. **`client/src/socket.js`** — Socket.IO singleton
7. **`client/src/main.jsx`** — React entry
8. **`client/src/App.jsx`** — Screen router + URL parsing
9. **`client/src/components/MainMenu.jsx`** — Create game button
10. **`client/src/components/Lobby.jsx`** — Lobby with ready + share link
11. **`client/src/components/Game.jsx`** — Full gameplay component

---

## Missing Functionality I Identified

1. **Same problems for both players** — pre-generated server-side so the side-by-side view is meaningful. If players got different problems, seeing opponent's screen wouldn't be as engaging.
2. **Throttled updates** — 100ms throttle on `player-update` to avoid flooding the network. ~10 updates/sec is enough for real-time feel.
3. **Server-authoritative timer** — clients run a local countdown for display but the server's `game-over` event is the source of truth. Prevents cheating by manipulating client timer.
4. **Input auto-advance** — as soon as typed digits match the answer, auto-advance to next problem. This is the core Zetamac mechanic and needs to be snappy (no Enter required for correct answers).
5. **URL-based joining** — extract gameId from URL path on mount. If the URL is `/aB3xY9`, auto-emit `join-game`. No form to paste a code.
6. **Reconnect handling** — if a player briefly disconnects, Socket.IO auto-reconnects. On reconnect, the server sends full current state. For MVP, if disconnect lasts >15s, treat as leave.
7. **Lobby full rejection** — third player trying to join gets an `error` event back.
8. **Copy link button** — Lobby shows the full URL with a one-click copy button.

---

## Verification

1. `node server.js` — server starts on :3001
2. `cd client && npx vite` — client starts on :5173
3. Open `localhost:5173` in two browser windows
4. Window 1: Click "Create Game" → see lobby with link
5. Copy link, paste in Window 2 → both see each other connected
6. Both click "Ready" → countdown 3-2-1 → game starts
7. Type answers in Window 1 → Window 2's right panel shows live typing
8. Wait 60s → game over screen with scores
9. Click "Play Again" → back to lobby, ready resets
10. Close Window 2 → Window 1 shows "Opponent disconnected"
11. Wait 10 min with no activity → server deletes lobby

---

## What You Need to Install

```bash
# In project root (zetamac2/)
npm install express socket.io

# In client/
cd client
npm install react react-dom socket.io-client
npm install -D vite @vitejs/plugin-react
```

That's it. 5 production deps, 2 dev deps. No global installs needed.
