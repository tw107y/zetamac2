import { useState, useEffect, useRef } from 'react';
import { playWin, playLose } from '../sounds';

const ROWS = 9;
const COLS = 9;
const NUM_MINES = 10;
const TOTAL_SAFE = ROWS * COLS - NUM_MINES;
const SABOTAGE_COOLDOWN = 15000;
const SABOTAGE_DURATION = 3000;

const NUMBER_COLORS = {
  1: '#0000ff',
  2: '#008000',
  3: '#ff0000',
  4: '#000080',
  5: '#800000',
  6: '#008080',
  7: '#000000',
  8: '#808080',
};

function send(dc, msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  }
}

function createEmptyCell() {
  return { mine: false, revealed: false, adjacent: 0, flagged: false, sabotaged: false };
}

function createEmptyBoard() {
  const board = [];
  for (let r = 0; r < ROWS; r++) {
    board[r] = [];
    for (let c = 0; c < COLS; c++) {
      board[r][c] = createEmptyCell();
    }
  }
  return board;
}

function cloneBoard(board) {
  return board.map((row) => row.map((cell) => ({ ...cell })));
}

function generateBoard() {
  const board = createEmptyBoard();

  // Fisher-Yates shuffle of cell indices
  const indices = [];
  for (let i = 0; i < ROWS * COLS; i++) indices.push(i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  // Place mines
  for (let k = 0; k < NUM_MINES; k++) {
    const idx = indices[k];
    const r = Math.floor(idx / COLS);
    const c = idx % COLS;
    board[r][c].mine = true;
  }

  // Calculate adjacent counts
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].mine) continue;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && board[nr][nc].mine) {
            count++;
          }
        }
      }
      board[r][c].adjacent = count;
    }
  }

  return board;
}

function countRevealed(board) {
  let count = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].revealed && !board[r][c].mine) count++;
    }
  }
  return count;
}

function isWin(board) {
  return countRevealed(board) >= TOTAL_SAFE;
}

function floodFill(board, row, col) {
  const revealed = [];
  const queue = [[row, col]];
  const visited = new Set();

  while (queue.length > 0) {
    const [r, c] = queue.shift();
    const key = `${r},${c}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
    const cell = board[r][c];
    if (cell.revealed || cell.flagged) continue;

    cell.revealed = true;
    revealed.push({ row: r, col: c, adjacent: cell.adjacent });

    if (cell.adjacent === 0) {
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

function getRevealedNumberedCells(board) {
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = board[r][c];
      if (cell.revealed && cell.adjacent > 0 && !cell.sabotaged) {
        cells.push({ row: r, col: c, adjacent: cell.adjacent });
      }
    }
  }
  return cells;
}

function relocateMine(board, row, col) {
  board[row][col].mine = false;

  const emptyCells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (r === row && c === col) continue;
      if (!board[r][c].mine) emptyCells.push([r, c]);
    }
  }

  if (emptyCells.length === 0) return;

  const [mr, mc] = emptyCells[Math.floor(Math.random() * emptyCells.length)];
  board[mr][mc].mine = true;

  // Recalculate all adjacent counts
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].mine) continue;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && board[nr][nc].mine) {
            count++;
          }
        }
      }
      board[r][c].adjacent = count;
    }
  }
}

function revealAllMines(board) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (board[r][c].mine) board[r][c].revealed = true;
    }
  }
}

export default function MinesweeperGame({
  dc,
  mode,
  startTime,
  duration,
  playerNum,
  isHost,
  socket,
  onBackToLobby,
  onGameEnd,
}) {
  const [myBoard, setMyBoard] = useState(() => generateBoard());
  const [opponentBoard, setOpponentBoard] = useState(() => createEmptyBoard());
  const [timeLeft, setTimeLeft] = useState(duration);
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [sabotageReady, setSabotageReady] = useState(true);
  const [sabotageFlash, setSabotageFlash] = useState(null);
  const [opponentFlash, setOpponentFlash] = useState(null);

  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false);
  const graceTimeoutRef = useRef(null);
  const onGameEndRef = useRef(onGameEnd);
  const onBackToLobbyRef = useRef(onBackToLobby);
  const playerNumRef = useRef(playerNum);
  const opponentRevealedRef = useRef(0);
  const myBoardRef = useRef(myBoard);
  const isFirstClickRef = useRef(true);
  const sabotageReadyRef = useRef(true);
  const sabotageFlashTimeoutRef = useRef(null);
  const opponentFlashTimeoutRef = useRef(null);
  const socketRef = useRef(socket);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);
  useEffect(() => { onBackToLobbyRef.current = onBackToLobby; }, [onBackToLobby]);
  useEffect(() => { myBoardRef.current = myBoard; }, [myBoard]);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  // ── Host-authoritative timer ────────────────────────────────────────
  useEffect(() => {
    if (!isHost) return;

    const tick = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
      setTimeLeft(remaining);

      if (remaining <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
        setGameOver(true);

        graceTimeoutRef.current = setTimeout(() => {
          const pNum = playerNumRef.current;
          const oNum = pNum === 1 ? 2 : 1;
          const myCount = countRevealed(myBoardRef.current);
          const oppCount = opponentRevealedRef.current;
          const finalScores = { [pNum]: myCount, [oNum]: oppCount };

          send(dc, { type: 'game-over', scores: finalScores });
          setScores(finalScores);
          if (socketRef.current) socketRef.current.emit('game-ended');

          const won = finalScores[pNum] > finalScores[oNum];
          if (won) playWin();
          else if (finalScores[pNum] < finalScores[oNum]) playLose();

          if (onGameEndRef.current) onGameEndRef.current(finalScores);
        }, 500);
      }
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => {
      clearInterval(interval);
      clearTimeout(graceTimeoutRef.current);
    };
  }, [isHost, startTime, duration, dc]);

  // ── Non-host timer ──────────────────────────────────────────────────
  useEffect(() => {
    if (isHost) return;

    const tick = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
      setTimeLeft(remaining);

      if (remaining <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
        send(dc, { type: 'player-update', revealed: countRevealed(myBoardRef.current) });
      }
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [isHost, startTime, duration]);

  // ── Data channel messages ──────────────────────────────────────────
  useEffect(() => {
    function handleMessage(e) {
      const msg = JSON.parse(e.data);

      switch (msg.type) {
        case 'cell-reveal': {
          setOpponentBoard((prev) => {
            const newBoard = cloneBoard(prev);
            for (const cell of msg.cells) {
              if (cell.row >= 0 && cell.row < ROWS && cell.col >= 0 && cell.col < COLS) {
                newBoard[cell.row][cell.col].revealed = true;
                newBoard[cell.row][cell.col].adjacent = cell.adjacent;
                newBoard[cell.row][cell.col].flagged = false;
              }
            }
            return newBoard;
          });
          opponentRevealedRef.current += msg.cells.length;
          break;
        }

        case 'cell-flag': {
          setOpponentBoard((prev) => {
            const newBoard = cloneBoard(prev);
            if (msg.row >= 0 && msg.row < ROWS && msg.col >= 0 && msg.col < COLS) {
              newBoard[msg.row][msg.col].flagged = msg.flagged;
            }
            return newBoard;
          });
          break;
        }

        case 'sabotage': {
          const board = myBoardRef.current;
          const numbered = getRevealedNumberedCells(board);
          if (numbered.length > 0) {
            const target = numbered[Math.floor(Math.random() * numbered.length)];
            setSabotageFlash({ row: target.row, col: target.col });
            if (sabotageFlashTimeoutRef.current) {
              clearTimeout(sabotageFlashTimeoutRef.current);
            }
            sabotageFlashTimeoutRef.current = setTimeout(() => {
              setSabotageFlash(null);
            }, SABOTAGE_DURATION);
            send(dc, { type: 'cell-sabotaged', row: target.row, col: target.col });
          }
          break;
        }

        case 'cell-sabotaged': {
          setOpponentFlash({ row: msg.row, col: msg.col });
          if (opponentFlashTimeoutRef.current) {
            clearTimeout(opponentFlashTimeoutRef.current);
          }
          opponentFlashTimeoutRef.current = setTimeout(() => {
            setOpponentFlash(null);
          }, SABOTAGE_DURATION);
          break;
        }

        case 'game-over': {
          if (gameOverRef.current) break;
          gameOverRef.current = true;
          setGameOver(true);
          setScores(msg.scores);

          const pNum = playerNumRef.current;
          const oNum = pNum === 1 ? 2 : 1;
          const won = (msg.scores[pNum] ?? 0) > (msg.scores[oNum] ?? 0);
          if (won) playWin();
          else if ((msg.scores[pNum] ?? 0) < (msg.scores[oNum] ?? 0)) playLose();

          if (socketRef.current) socketRef.current.emit('game-ended');
          if (onGameEndRef.current) onGameEndRef.current(msg.scores);
          break;
        }

        case 'player-update': {
          if (msg.revealedCount !== undefined) {
            opponentRevealedRef.current = msg.revealedCount;
          }
          if (isHost && msg.gameOver && !gameOverRef.current) {
            gracePeriodRef.current = true;
            gameOverRef.current = true;
            setGameOver(true);

            const pNum = playerNumRef.current;
            const oNum = pNum === 1 ? 2 : 1;
            const myCount = countRevealed(myBoardRef.current);
            const oppCount =
              msg.myRevealedCount !== undefined
                ? msg.myRevealedCount
                : opponentRevealedRef.current;
            const finalScores = { [pNum]: myCount, [oNum]: oppCount };

            send(dc, { type: 'game-over', scores: finalScores });
            setScores(finalScores);
            if (socketRef.current) socketRef.current.emit('game-ended');

            const won = finalScores[pNum] > finalScores[oNum];
            if (won) playWin();
            else if (finalScores[pNum] < finalScores[oNum]) playLose();

            if (onGameEndRef.current) onGameEndRef.current(finalScores);
          }
          break;
        }

        case 'restart':
          if (onBackToLobbyRef.current) onBackToLobbyRef.current();
          break;
      }
    }

    function handleDisconnect() {
      if (!gameOverRef.current) {
        gameOverRef.current = true;
        setGameOver(true);
        setScores(null);
      }
    }

    dc.addEventListener('message', handleMessage);
    dc.addEventListener('close', handleDisconnect);
    dc.addEventListener('error', handleDisconnect);
    return () => {
      dc.removeEventListener('message', handleMessage);
      dc.removeEventListener('close', handleDisconnect);
      dc.removeEventListener('error', handleDisconnect);
    };
  }, [dc, isHost]);

  // ── Sabotage keyboard shortcut ─────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 's' || e.key === 'S') {
        if (gameOverRef.current) return;
        if (!sabotageReadyRef.current) return;

        send(dc, { type: 'sabotage' });
        sabotageReadyRef.current = false;
        setSabotageReady(false);

        setTimeout(() => {
          sabotageReadyRef.current = true;
          setSabotageReady(true);
        }, SABOTAGE_COOLDOWN);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dc]);

  // ── Cell click handlers ────────────────────────────────────────────
  function handleCellClick(row, col) {
    if (gameOver || gameOverRef.current) return;

    const board = cloneBoard(myBoardRef.current);
    const cell = board[row][col];
    if (cell.revealed || cell.flagged) return;

    // First click safety: relocate mine if first click lands on one
    if (isFirstClickRef.current) {
      isFirstClickRef.current = false;
      if (cell.mine) {
        relocateMine(board, row, col);
      }
    }

    // If cell is now a mine after relocation check (shouldn't happen if relocate worked),
    // or if it was always a mine beyond first click — handle mine hit
    if (board[row][col].mine) {
      gameOverRef.current = true;
      board[row][col].revealed = true;
      revealAllMines(board);
      const myCount = countRevealed(board);
      setMyBoard(board);
      setGameOver(true);

      const pNum = playerNumRef.current;
      const oNum = pNum === 1 ? 2 : 1;
      const finalScores = { [pNum]: myCount, [oNum]: opponentRevealedRef.current };
      setScores(finalScores);
      playLose();

      if (isHost) {
        send(dc, { type: 'game-over', scores: finalScores });
        if (socketRef.current) socketRef.current.emit('game-ended');
        if (onGameEndRef.current) onGameEndRef.current(finalScores);
      } else {
        send(dc, {
          type: 'player-update',
          revealedCount: opponentRevealedRef.current,
          gameOver: true,
          myRevealedCount: myCount,
        });
      }
      return;
    }

    // Safe cell: flood fill reveal
    const revealed = floodFill(board, row, col);
    setMyBoard(board);
    const myCount = countRevealed(board);

    send(dc, { type: 'cell-reveal', cells: revealed });

    // Check win
    if (isWin(board)) {
      gameOverRef.current = true;
      setGameOver(true);
      const pNum = playerNumRef.current;
      const oNum = pNum === 1 ? 2 : 1;
      const finalScores = { [pNum]: myCount, [oNum]: opponentRevealedRef.current };
      setScores(finalScores);
      playWin();

      if (isHost) {
        send(dc, { type: 'game-over', scores: finalScores });
        if (socketRef.current) socketRef.current.emit('game-ended');
        if (onGameEndRef.current) onGameEndRef.current(finalScores);
      } else {
        send(dc, {
          type: 'player-update',
          revealedCount: opponentRevealedRef.current,
          gameOver: true,
          myRevealedCount: myCount,
        });
      }
    }
  }

  function handleRightClick(row, col) {
    if (gameOver || gameOverRef.current) return;
    const board = cloneBoard(myBoardRef.current);
    const cell = board[row][col];
    if (cell.revealed) return;

    cell.flagged = !cell.flagged;
    setMyBoard(board);
    send(dc, { type: 'cell-flag', row, col, flagged: cell.flagged });
  }

  function handleRestart() {
    send(dc, { type: 'restart' });
    onBackToLobby();
  }

  // ── Render ─────────────────────────────────────────────────────────
  const opponentNum = playerNum === 1 ? 2 : 1;
  const myScoreDisplay = scores ? (scores[playerNum] ?? countRevealed(myBoard)) : countRevealed(myBoard);
  const oppScoreDisplay = scores ? (scores[opponentNum] ?? opponentRevealedRef.current) : opponentRevealedRef.current;

  return (
    <div style={styles.wrapper}>
      <div style={styles.topBar}>
        <span style={styles.modeLabel}>{'💣'} Minesweeper</span>
        <span
          style={{
            ...styles.timer,
            color: timeLeft <= 10 ? '#ff6b6b' : '#eee',
            animation:
              timeLeft <= 10
                ? `heartbeat ${timeLeft <= 5 ? '0.4s' : '0.7s'} ease-in-out infinite`
                : 'none',
          }}
        >
          {timeLeft}s
        </span>
        <span
          style={{
            ...styles.sabotageIndicator,
            color: sabotageReady ? '#4ecca3' : '#666',
          }}
        >
          {sabotageReady ? '[S] {⚡} READY' : '[S] {⏳}'}
        </span>
      </div>

      <div style={styles.boardsArea}>
        {/* My board */}
        <div style={styles.boardSection}>
          <div style={styles.boardLabel}>
            You{' '}
            <span style={{ color: '#4ecca3', fontWeight: 800, fontSize: '1rem' }}>
              {myScoreDisplay}/{TOTAL_SAFE}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {myBoard.map((row, r) => (
              <div key={r} style={{ display: 'flex', gap: '2px' }}>
                {row.map((cell, c) => {
                  const isFlash =
                    sabotageFlash &&
                    sabotageFlash.row === r &&
                    sabotageFlash.col === c;

                  let content = null;
                  let bg = '#16213e';
                  let color = '#eee';

                  if (cell.revealed) {
                    if (cell.mine) {
                      content = '💣';
                      bg = '#e94560';
                    } else if (cell.adjacent > 0) {
                      content = cell.adjacent;
                      bg = '#ddd';
                      color = NUMBER_COLORS[cell.adjacent] || '#000';
                    } else {
                      bg = '#ccc';
                    }
                  } else if (cell.flagged) {
                    content = '🚩';
                    bg = '#1a1a2e';
                  }

                  if (isFlash) {
                    bg = '#ffd93d';
                  }

                  return (
                    <div
                      key={c}
                      onClick={() => handleCellClick(r, c)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        handleRightClick(r, c);
                      }}
                      style={{
                        ...styles.cell,
                        width: 40,
                        height: 40,
                        background: bg,
                        color: color,
                        animation: isFlash
                          ? 'heartbeat 0.5s ease-in-out infinite'
                          : 'none',
                        cursor:
                          !cell.revealed && !gameOver ? 'pointer' : 'default',
                      }}
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div style={styles.divider} />

        {/* Opponent board */}
        <div style={{ ...styles.boardSection, opacity: 0.85 }}>
          <div style={styles.boardLabel}>
            Opp{' '}
            <span style={{ color: '#e94560', fontWeight: 800, fontSize: '0.9rem' }}>
              {oppScoreDisplay}/{TOTAL_SAFE}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {opponentBoard.map((row, r) => (
              <div key={r} style={{ display: 'flex', gap: '2px' }}>
                {row.map((cell, c) => {
                  const isFlash =
                    opponentFlash &&
                    opponentFlash.row === r &&
                    opponentFlash.col === c;

                  let content = null;
                  let bg = '#16213e';
                  let color = '#eee';

                  if (cell.revealed) {
                    if (cell.adjacent > 0) {
                      content = cell.adjacent;
                      bg = '#ddd';
                      color = NUMBER_COLORS[cell.adjacent] || '#000';
                    } else {
                      bg = '#ccc';
                    }
                  } else if (cell.flagged) {
                    content = '🚩';
                    bg = '#1a1a2e';
                  }

                  if (isFlash) {
                    bg = '#ffd93d';
                  }

                  return (
                    <div
                      key={c}
                      style={{
                        ...styles.cell,
                        width: 36,
                        height: 36,
                        fontSize: '0.8rem',
                        background: bg,
                        color: color,
                        animation: isFlash
                          ? 'heartbeat 0.5s ease-in-out infinite'
                          : 'none',
                      }}
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={styles.instructions}>
        <span>Left-click: Reveal</span>
        <span style={{ color: '#555' }}>|</span>
        <span>Right-click: Flag</span>
        <span style={{ color: '#555' }}>|</span>
        <span>
          Press <b>S</b>: Sabotage{' '}
          <span style={{ color: sabotageReady ? '#4ecca3' : '#888' }}>
            ({sabotageReady ? 'ready' : `${SABOTAGE_COOLDOWN / 1000}s cd`})
          </span>
        </span>
      </div>

      {gameOver && (
        <div style={styles.overlay}>
          <div style={styles.overlayContent}>
            {scores ? (
              <>
                <div style={styles.trophy}>
                  {scores[playerNum] > scores[opponentNum]
                    ? '🏆'
                    : scores[playerNum] < scores[opponentNum]
                      ? '💀'
                      : '🤝'}
                </div>
                <div style={styles.overlayTitle}>
                  {scores[playerNum] > scores[opponentNum]
                    ? 'You Won!'
                    : scores[playerNum] < scores[opponentNum]
                      ? 'You Lost'
                      : "It's a Tie!"}
                </div>
                <div style={styles.overlayScores}>
                  {scores[playerNum]} cells &ndash; {scores[opponentNum]} cells
                </div>
                <button onClick={handleRestart} style={styles.restartBtn}>
                  Play Again
                </button>
              </>
            ) : (
              <div
                style={{ color: '#ff6b6b', fontSize: '1.5rem', fontWeight: 700 }}
              >
                Connection lost
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minHeight: '100vh',
    padding: '20px',
    gap: '12px',
    position: 'relative',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '24px',
    width: '100%',
    maxWidth: '900px',
    justifyContent: 'center',
    marginBottom: '4px',
  },
  modeLabel: {
    fontSize: '0.95rem',
    color: '#e94560',
    fontWeight: 700,
  },
  timer: {
    fontSize: '2rem',
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
  },
  sabotageIndicator: {
    fontSize: '0.85rem',
    fontWeight: 700,
    fontFamily: 'monospace',
  },
  boardsArea: {
    display: 'flex',
    gap: '0',
    alignItems: 'flex-start',
    width: '100%',
    maxWidth: '900px',
    justifyContent: 'center',
  },
  boardSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 24px',
  },
  boardLabel: {
    fontSize: '0.9rem',
    fontWeight: 700,
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  divider: {
    width: '2px',
    background: '#333',
    alignSelf: 'stretch',
    marginTop: '8px',
    marginBottom: '8px',
  },
  cell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    fontWeight: 700,
    userSelect: 'none',
    lineHeight: 1,
    border: '1px solid #2a2a4a',
  },
  instructions: {
    display: 'flex',
    gap: '10px',
    fontSize: '0.8rem',
    color: '#888',
    marginTop: '8px',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(10, 10, 20, 0.85)',
    zIndex: 100,
  },
  overlayContent: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    padding: '36px 48px',
    borderRadius: '12px',
    background: '#16213e',
    border: '2px solid #333',
  },
  trophy: {
    fontSize: '4rem',
    animation: 'heartbeat 0.6s ease-in-out 3',
  },
  overlayTitle: {
    fontSize: '1.8rem',
    fontWeight: 800,
  },
  overlayScores: {
    fontSize: '1rem',
    color: '#888',
  },
  restartBtn: {
    marginTop: '8px',
    fontSize: '1.1rem',
    padding: '12px 36px',
  },
};
