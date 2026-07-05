/**
 * Bot engine — creates a mock DataChannel simulating a human opponent.
 * Supports all game modes (classic, duel, health, minesweeper)
 * with three difficulty levels (easy, medium, hard).
 */

function randBetween(min, max) {
  return Math.random() * (max - min) + min;
}

const DIFFICULTIES = {
  easy:   { accuracy: 0.3, delayMin: 3000, delayMax: 7000, mineHitChance: 0.40, sabotageChance: 0.15 },
  medium: { accuracy: 0.7, delayMin: 2000, delayMax: 4000, mineHitChance: 0.15, sabotageChance: 0.10 },
  hard:   { accuracy: 0.95, delayMin: 1000, delayMax: 2500, mineHitChance: 0.05, sabotageChance: 0.05 },
};

/**
 * Creates a mock RTCDataChannel that behaves like a remote opponent.
 *
 * @param {object} options
 * @param {'classic'|'duel'|'health'|'minesweeper'} options.mode
 * @param {'easy'|'medium'|'hard'} options.difficulty
 * @param {object} options.gameData  — game-start payload (problems, startTime, duration, mode)
 * @param {number} [options.playerNum=2]  — which player number the bot occupies
 */
export function createBotDC({ mode, difficulty, gameData, playerNum = 2 }) {
  const config = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;

  const listeners = { message: [], close: [], error: [] };
  const timers = [];
  let stopped = false;

  // ---- Shared bot state ----
  let botScore = 0;
  let botProblemIndex = 0;
  let botHp = 100;
  let opponentScore = 0;
  let opponentHp = 100;
  let opponentRevealedCount = 0;

  // ---- Minesweeper state ----
  let minesweeperBoard = null;
  let minesweeperRevealed = 0;

  // ---- Helpers ----

  function emit(msgType, payload) {
    const json = JSON.stringify({ type: msgType, ...payload });
    listeners.message.forEach((fn) => {
      try { fn({ data: json }); } catch (_) { /* ignore listener errors */ }
    });
  }

  function schedule(fn, delay) {
    if (stopped) return;
    const id = setTimeout(() => {
      if (!stopped) fn();
    }, delay);
    timers.push(id);
  }

  function stop() {
    stopped = true;
    timers.forEach(clearTimeout);
    timers.length = 0;
  }

  // ---- Incoming message handler (player -> bot) ----

  function handleIncoming(raw) {
    if (stopped) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case 'game-over':
        stop();
        break;

      case 'player-update':
        opponentScore = msg.score;
        if (msg.hp !== undefined) opponentHp = msg.hp;
        if (mode === 'health' && msg.targetHp !== undefined) {
          botHp = msg.targetHp;
          // If bot's HP reached 0, stop activity (host will send game-over)
          if (botHp <= 0) stop();
        }
        break;

      case 'duel-claim':
        if (msg.problemIndex >= botProblemIndex) {
          botProblemIndex = msg.problemIndex + 1;
        }
        opponentScore = msg.score;
        break;

      case 'cell-reveal':
        if (msg.cells && Array.isArray(msg.cells)) {
          opponentRevealedCount += msg.cells.length;
        } else {
          opponentRevealedCount += 1;
        }
        break;

      case 'cell-flag':
        // Track flags if needed — no impact on score
        break;

      case 'sabotage':
        // Track sabotage if needed
        break;

      case 'restart':
        // Ignored — the DC will be replaced on restart flow
        break;
    }
  }

  // ---- Math modes (classic, duel, health) ----

  function startMathBot() {
    const problems = gameData.problems;
    if (!problems || problems.length === 0) return;

    function mathTurn() {
      if (stopped) return;

      if (botProblemIndex >= problems.length) {
        sendGameOver();
        return;
      }

      const problem = problems[botProblemIndex];
      const isCorrect = Math.random() < config.accuracy;

      if (mode === 'duel') {
        // Duel mode: only claim on correct answer
        if (isCorrect) {
          botScore++;
          const claimIdx = botProblemIndex;
          botProblemIndex++;
          emit('duel-claim', { problemIndex: claimIdx, score: botScore });
        } else {
          // Bot failed to answer; still move on (opponent may have claimed first)
          botProblemIndex++;
        }
      } else {
        // Classic / Health: always submit an answer
        if (isCorrect) {
          botScore++;
          const payload = {
            problemIndex: botProblemIndex + 1,
            input: String(problem.answer),
            score: botScore,
            hp: botHp,
          };

          if (mode === 'health') {
            opponentHp = Math.max(0, opponentHp - 10);
            payload.targetHp = opponentHp;
          }

          emit('player-update', payload);
          botProblemIndex++;

          // Check health-mode defeat
          if (mode === 'health' && opponentHp <= 0) {
            sendGameOver();
            return;
          }
        } else {
          // Wrong answer — send a plausible wrong string
          let wrongAnswer;
          const offset = Math.floor(Math.random() * Math.max(2, Math.abs(problem.answer / 2))) + 1;
          wrongAnswer = Math.random() < 0.5 ? problem.answer + offset : problem.answer - offset;
          // Avoid accidentally being correct
          if (wrongAnswer === problem.answer) wrongAnswer = problem.answer + 1;

          emit('player-update', {
            problemIndex: botProblemIndex,
            input: String(wrongAnswer),
            score: botScore,
            hp: botHp,
          });

          // Advance anyway — bot doesn't get stuck on one problem forever
          botProblemIndex++;
        }
      }

      // Schedule next turn
      const delay = randBetween(config.delayMin, config.delayMax);
      schedule(mathTurn, delay);
    }

    function sendGameOver() {
      const opponentNum = playerNum === 1 ? 2 : 1;
      const scores = { [playerNum]: botScore, [opponentNum]: opponentScore };
      const payload = { scores };

      if (mode === 'health') {
        payload.hp = { [playerNum]: botHp, [opponentNum]: opponentHp };
      }

      emit('game-over', payload);
      stop();
    }

    // Kick off first turn
    const initialDelay = randBetween(config.delayMin, config.delayMax);
    schedule(mathTurn, initialDelay);
  }

  // ---- Minesweeper mode ----

  function startMinesweeperBot() {
    const SIZE = 9;
    const TOTAL_MINES = 10;

    // ----- Board generation (inline) -----
    function generateBoard() {
      const board = [];
      for (let r = 0; r < SIZE; r++) {
        board[r] = [];
        for (let c = 0; c < SIZE; c++) {
          board[r][c] = { mine: false, revealed: false, flagged: false, adjacent: 0 };
        }
      }

      // Place mines
      let placed = 0;
      while (placed < TOTAL_MINES) {
        const r = Math.floor(Math.random() * SIZE);
        const c = Math.floor(Math.random() * SIZE);
        if (!board[r][c].mine) {
          board[r][c].mine = true;
          placed++;
        }
      }

      // Calculate adjacent mine counts
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (board[r][c].mine) continue;
          let count = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = r + dr;
              const nc = c + dc;
              if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc].mine) {
                count++;
              }
            }
          }
          board[r][c].adjacent = count;
        }
      }

      return board;
    }

    // ----- Flood-fill for safe zeros -----
    function floodFill(board, row, col) {
      const revealed = [];
      const queue = [[row, col]];
      const visited = new Set();

      while (queue.length > 0) {
        const [r, c] = queue.shift();
        const key = `${r},${c}`;
        if (visited.has(key)) continue;
        visited.add(key);

        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
        if (board[r][c].revealed || board[r][c].flagged) continue;

        board[r][c].revealed = true;
        revealed.push({ row: r, col: c, adjacent: board[r][c].adjacent, mine: false });

        if (board[r][c].adjacent === 0) {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              queue.push([r + dr, c + dc]);
            }
          }
        }
      }

      return revealed;
    }

    // ----- Win check -----
    function isBoardCleared(board) {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (!board[r][c].mine && !board[r][c].revealed) return false;
        }
      }
      return true;
    }

    // ----- Cell helpers -----
    function getAvailableCells(board) {
      const cells = [];
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (!board[r][c].revealed && !board[r][c].flagged) {
            cells.push({ row: r, col: c });
          }
        }
      }
      return cells;
    }

    function getCorners(board) {
      const corners = [];
      const positions = [[0, 0], [0, SIZE - 1], [SIZE - 1, 0], [SIZE - 1, SIZE - 1]];
      for (const [r, c] of positions) {
        if (!board[r][c].revealed && !board[r][c].flagged) {
          corners.push({ row: r, col: c });
        }
      }
      return corners;
    }

    function getEdges(board) {
      const edges = [];
      for (let c = 1; c < SIZE - 1; c++) {
        if (!board[0][c].revealed && !board[0][c].flagged) edges.push({ row: 0, col: c });
        if (!board[SIZE - 1][c].revealed && !board[SIZE - 1][c].flagged) edges.push({ row: SIZE - 1, col: c });
      }
      for (let r = 1; r < SIZE - 1; r++) {
        if (!board[r][0].revealed && !board[r][0].flagged) edges.push({ row: r, col: 0 });
        if (!board[r][SIZE - 1].revealed && !board[r][SIZE - 1].flagged) edges.push({ row: r, col: SIZE - 1 });
      }
      return edges;
    }

    // ----- Game logic -----
    minesweeperBoard = generateBoard();

    function minesweeperTurn() {
      if (stopped) return;

      // Clear check
      if (isBoardCleared(minesweeperBoard)) {
        emitGameOver(true);
        return;
      }

      const isHard = difficulty === 'hard';

      // ---- Smart flagging (hard mode only) ----
      if (isHard && Math.random() < 0.3) {
        for (let r = 0; r < SIZE; r++) {
          for (let c = 0; c < SIZE; c++) {
            if (!minesweeperBoard[r][c].revealed || minesweeperBoard[r][c].adjacent === 0) continue;

            const unrevealed = [];
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = r + dr;
                const nc = c + dc;
                if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
                if (!minesweeperBoard[nr][nc].revealed && !minesweeperBoard[nr][nc].flagged) {
                  unrevealed.push({ row: nr, col: nc });
                }
              }
            }

            if (unrevealed.length === 1 && minesweeperBoard[r][c].adjacent > 0) {
              const cell = unrevealed[0];
              const actuallyMine = minesweeperBoard[cell.row][cell.col].mine;
              // 70% accuracy on flagging mines
              const shouldFlag = Math.random() < 0.7 ? actuallyMine : !actuallyMine;

              if (shouldFlag) {
                minesweeperBoard[cell.row][cell.col].flagged = true;
                emit('cell-flag', { row: cell.row, col: cell.col, flagged: true });
                schedule(minesweeperTurn, randBetween(config.delayMin, config.delayMax));
                return;
              }
            }
          }
        }
      }

      // ---- Occasional sabotage ----
      if (Math.random() < config.sabotageChance) {
        emit('sabotage', {});
      }

      // ---- Pick a cell ----
      let cell;

      if (isHard) {
        // Corners first, then edges, then random
        const corners = getCorners(minesweeperBoard);
        if (corners.length > 0) {
          cell = corners[Math.floor(Math.random() * corners.length)];
        } else {
          const edges = getEdges(minesweeperBoard);
          if (edges.length > 0 && Math.random() < 0.6) {
            cell = edges[Math.floor(Math.random() * edges.length)];
          } else {
            const avail = getAvailableCells(minesweeperBoard);
            if (avail.length === 0) { emitGameOver(true); return; }
            cell = avail[Math.floor(Math.random() * avail.length)];
          }
        }
      } else {
        // Random click
        const avail = getAvailableCells(minesweeperBoard);
        if (avail.length === 0) { emitGameOver(true); return; }
        cell = avail[Math.floor(Math.random() * avail.length)];
      }

      const cellObj = minesweeperBoard[cell.row][cell.col];

      // ---- Mine hit check ----
      if (cellObj.mine) {
        if (Math.random() < config.mineHitChance) {
          // Hit!
          cellObj.revealed = true;
          emit('cell-reveal', {
            row: cell.row,
            col: cell.col,
            mineHit: true,
            cells: [{ row: cell.row, col: cell.col, mine: true, adjacent: -1 }],
          });
          emitGameOver(false);
          return;
        } else {
          // Lucky miss — pick a different safe cell instead
          const safeCells = getAvailableCells(minesweeperBoard).filter(
            (c) => !minesweeperBoard[c.row][c.col].mine
          );
          if (safeCells.length > 0) {
            cell = safeCells[Math.floor(Math.random() * safeCells.length)];
          } else {
            // Only mines left — forced hit
            const forced = getAvailableCells(minesweeperBoard);
            if (forced.length === 0) { emitGameOver(true); return; }
            cell = forced[0];
            minesweeperBoard[cell.row][cell.col].revealed = true;
            emit('cell-reveal', {
              row: cell.row,
              col: cell.col,
              mineHit: true,
              cells: [{ row: cell.row, col: cell.col, mine: true, adjacent: -1 }],
            });
            emitGameOver(false);
            return;
          }
        }
      }

      // ---- Safe reveal ----
      const revealed = floodFill(minesweeperBoard, cell.row, cell.col);
      minesweeperRevealed += revealed.length;

      emit('cell-reveal', { cells: revealed, revealedCount: revealed.length });

      // Post-reveal win check
      if (isBoardCleared(minesweeperBoard)) {
        emitGameOver(true);
        return;
      }

      // Schedule next turn
      schedule(minesweeperTurn, randBetween(config.delayMin, config.delayMax));
    }

    function emitGameOver(won) {
      const opponentNum = playerNum === 1 ? 2 : 1;
      const score = minesweeperRevealed;
      const oppScore = opponentRevealedCount;

      emit('game-over', {
        scores: { [playerNum]: score, [opponentNum]: oppScore },
        won,
      });
      stop();
    }

    // Start first turn
    schedule(minesweeperTurn, randBetween(config.delayMin, config.delayMax));
  }

  // ---- Launch ----

  if (mode === 'minesweeper') {
    startMinesweeperBot();
  } else {
    startMathBot();
  }

  // ---- Return mock DataChannel ----

  return {
    readyState: 'open',

    addEventListener(type, fn) {
      if (listeners[type]) {
        listeners[type].push(fn);
      }
    },

    removeEventListener(type, fn) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((f) => f !== fn);
      }
    },

    send(data) {
      handleIncoming(data);
    },

    close() {
      stop();
    },
  };
}
