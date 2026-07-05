/**
 * Bot engine — simulates a human opponent for all game modes.
 * Creates a mock DataChannel that game components use identically to real WebRTC.
 */
function randBetween(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateBoard(rows, cols, mines) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) grid[r][c] = { mine: false, adjacent: 0 };
  }
  let placed = 0;
  while (placed < mines) {
    const r = Math.floor(Math.random() * rows), c = Math.floor(Math.random() * cols);
    if (!grid[r][c].mine) { grid[r][c].mine = true; placed++; }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c].mine) continue;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr][nc].mine) count++;
      }
      grid[r][c].adjacent = count;
    }
  }
  return { rows, cols, mines, grid };
}

function countRevealed(board) {
  let count = 0;
  for (let r = 0; r < board.rows; r++) for (let c = 0; c < board.cols; c++) if (board.grid[r][c].revealed && !board.grid[r][c].mine) count++;
  return count;
}

function floodFill(grid, rows, cols, row, col) {
  const revealed = [];
  const visited = new Set();
  const stack = [[row, col]];
  while (stack.length > 0) {
    const [r, c] = stack.pop();
    const key = `${r},${c}`;
    if (r < 0 || r >= rows || c < 0 || c >= cols || visited.has(key)) continue;
    visited.add(key);
    const cell = grid[r][c];
    if (cell.mine) continue;
    const rc = { row: r, col: c, adjacent: grid[r][c].adjacent };
    revealed.push(rc);
    cell.revealed = true;
    if (cell.adjacent === 0) {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        stack.push([r + dr, c + dc]);
      }
    }
  }
  return revealed;
}

function getConfig(d) {
  if (d === 'easy') return { acc: 0.3, delay: [3000, 7000], sabChance: 0.05 };
  if (d === 'hard') return { acc: 0.95, delay: [1000, 2500], sabChance: 0.15 };
  return { acc: 0.7, delay: [2000, 4000], sabChance: 0.1 };
}

export function createBotDC({ mode, difficulty, gameData, playerNum = 2 }) {
  const cfg = getConfig(difficulty);
  const listeners = { message: [], close: [], error: [] };
  let stopped = false;
  const timers = [];

  function emit(type, payload) {
    if (stopped) return;
    const msg = JSON.stringify({ type, ...payload });
    listeners.message.forEach(fn => fn({ data: msg }));
  }

  function schedule(fn, ms) {
    const id = setTimeout(() => {
      const idx = timers.indexOf(id);
      if (idx >= 0) timers.splice(idx, 1);
      if (!stopped) fn();
    }, ms);
    timers.push(id);
  }

  function startMathBot() {
    const problems = gameData.problems || [];
    let idx = 0, score = 0, hp = 100;
    emit('ready-change', { ready: true });

    (function tick() {
      if (stopped || idx >= problems.length) return;
      const correct = Math.random() < cfg.acc;
      if (correct && problems[idx]) {
        score++;
        const p = { problemIndex: idx + 1, input: '', score, hp: mode === 'health' ? hp : 100 };
        if (mode === 'health') { p.targetHp = Math.max(0, 90); }
        if (mode === 'duel') emit('duel-claim', { problemIndex: idx, score });
        else emit('player-update', p);
      } else if (problems[idx]) {
        const wrong = (problems[idx].answer || 0) + Math.floor(Math.random() * 20 + 1);
        emit('player-update', { problemIndex: idx + 1, input: String(wrong), score, hp: mode === 'health' ? hp : 100 });
      }
      idx++;
      if (idx >= problems.length && !stopped) {
        const o = playerNum === 1 ? 2 : 1;
        emit('game-over', { scores: { [playerNum]: score, [o]: 0 }, winner: score > 5 ? playerNum : o });
        return;
      }
      schedule(tick, randBetween(cfg.delay[0], cfg.delay[1]));
    })(randBetween(2000, 3000));
  }

  function startMinesweeperBot() {
    const board = generateBoard(9, 9, 10);
    const grid = board.grid;
    const revealed = new Set();
    const flagged = new Set();
    let first = true, playerCells = 0;

    schedule(function tick() {
      if (stopped) return;
      if (Math.random() < cfg.sabChance && revealed.size > 3) {
        emit('sabotage', {});
        schedule(tick, randBetween(cfg.delay[0], cfg.delay[1]));
        return;
      }
      if (first) {
        first = false;
        const cells = floodFill(grid, 9, 9, 4, 4);
        cells.forEach(c => revealed.add(`${c.row},${c.col}`));
        emit('cell-reveal', { cells });
        schedule(tick, randBetween(cfg.delay[0], cfg.delay[1]));
        return;
      }
      const hidden = [];
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        const k = `${r},${c}`;
        if (!revealed.has(k) && !flagged.has(k)) hidden.push({ row: r, col: c });
      }
      if (hidden.length === 0 && !stopped) {
        const o = playerNum === 1 ? 2 : 1;
        emit('game-over', { scores: { [playerNum]: revealed.size, [o]: playerCells }, winner: playerNum });
        return;
      }
      const target = pick(hidden);
      const cell = grid[target.row][target.col];
      const key = `${target.row},${target.col}`;
      if (cell.mine) {
        revealed.add(key);
        emit('cell-reveal', { cells: [{ row: target.row, col: target.col, adjacent: -1 }] });
        const o = playerNum === 1 ? 2 : 1;
        emit('game-over', { scores: { [playerNum]: revealed.size - 1, [o]: playerCells }, winner: o });
        stopped = true;
        return;
      }
      const cells = floodFill(grid, 9, 9, target.row, target.col);
      cells.forEach(c => revealed.add(`${c.row},${c.col}`));
      emit('cell-reveal', { cells });
      let unrevealedSafe = 0;
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        if (!grid[r][c].mine && !revealed.has(`${r},${c}`)) unrevealedSafe++;
      }
      if (unrevealedSafe === 0 && !stopped) {
        const o = playerNum === 1 ? 2 : 1;
        emit('game-over', { scores: { [playerNum]: revealed.size, [o]: playerCells }, winner: playerNum });
        stopped = true;
        return;
      }
      schedule(tick, randBetween(cfg.delay[0], cfg.delay[1]));
    }, randBetween(1000, 2000));

    return { trackPlayerCell: () => playerCells++ };
  }

  let bot = null;
  if (mode === 'minesweeper') bot = startMinesweeperBot();
  else startMathBot();

  return {
    readyState: 'open',
    addEventListener(type, fn) { if (listeners[type]) listeners[type].push(fn); },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
    },
    send(data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'game-over') stopped = true;
        if (msg.type === 'cell-reveal' && bot) {
          for (const c of (msg.cells || [])) if (!c.mine) bot.trackPlayerCell();
        }
      } catch (e) { /* ignore malformed */ }
    },
    close() { stopped = true; timers.forEach(clearTimeout); timers.length = 0; },
  };
}
