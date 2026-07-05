import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

function send(dc, msg) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg)); }

const ROWS = 9, COLS = 9, NUM_MINES = 10, SABOTAGE_COOLDOWN = 15000;
const NUMBER_COLORS = { 1: '#0000ff', 2: '#008000', 3: '#ff0000', 4: '#000080', 5: '#800000', 6: '#008080', 7: '#000000', 8: '#808080' };

function generateBoard() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) { grid[r] = []; for (let c = 0; c < COLS; c++) grid[r][c] = { mine: false, adjacent: 0, revealed: false, flagged: false, sabotaged: false }; }
  let p = 0; while (p < NUM_MINES) { const r = Math.floor(Math.random() * ROWS), c = Math.floor(Math.random() * COLS); if (!grid[r][c].mine) { grid[r][c].mine = true; p++; } }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { if (grid[r][c].mine) continue; let n = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (dr === 0 && dc === 0) continue; const nr = r + dr, nc = c + dc; if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && grid[nr][nc].mine) n++; } grid[r][c].adjacent = n; }
  return { rows: ROWS, cols: COLS, mines: NUM_MINES, grid };
}

function createEmptyBoard() {
  const grid = []; for (let r = 0; r < ROWS; r++) { grid[r] = []; for (let c = 0; c < COLS; c++) grid[r][c] = { revealed: false, adjacent: 0, flagged: false, sabotaged: false }; }
  return { rows: ROWS, cols: COLS, mines: NUM_MINES, grid };
}
function cloneBoard(b) { return { rows: b.rows, cols: b.cols, mines: b.mines, grid: b.grid.map(r => r.map(c => ({ ...c }))) }; }
function countRevealed(b) { let n = 0; for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) if (b.grid[r][c].revealed && !b.grid[r][c].mine) n++; return n; }
function isWin(b) { return countRevealed(b) >= b.rows * b.cols - b.mines; }

function floodFill(board, row, col) {
  const stack = [[row, col]];
  while (stack.length > 0) {
    const [r, c] = stack.pop();
    if (r < 0 || r >= board.rows || c < 0 || c >= board.cols) continue;
    const cell = board.grid[r][c];
    if (cell.revealed || cell.flagged || cell.mine) continue;
    cell.revealed = true;
    if (cell.adjacent === 0) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (dr === 0 && dc === 0) continue; stack.push([r + dr, c + dc]); }
  }
}

function getRevealedNumberedCells(board) {
  const cells = [];
  for (let r = 0; r < board.rows; r++) for (let c = 0; c < board.cols; c++) if (board.grid[r][c].revealed && board.grid[r][c].adjacent > 0 && !board.grid[r][c].sabotaged) cells.push({ row: r, col: c });
  return cells;
}

function relocateMine(grid, row, col) {
  grid[row][col].mine = false;
  const cells = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!grid[r][c].mine && !(r === row && c === col)) cells.push({ r, c });
  if (cells.length > 0) { const t = cells[Math.floor(Math.random() * cells.length)]; grid[t.r][t.c].mine = true; }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (grid[r][c].mine) continue; let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (dr === 0 && dc === 0) continue; const nr = r + dr, nc = c + dc; if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && grid[nr][nc].mine) n++; }
    grid[r][c].adjacent = n;
  }
}

export default function MinesweeperGame({ dc, mode, startTime, duration, playerNum, isHost, socket, onBackToLobby, onGameEnd }) {
  const [myBoard, setMyBoard] = useState(() => generateBoard());
  const [opponentBoard, setOpponentBoard] = useState(() => createEmptyBoard());
  const [timeLeft, setTimeLeft] = useState(duration);
  const [gameOver, setGameOver] = useState(false);
  const [gameResult, setGameResult] = useState(null);
  const [finalScores, setFinalScores] = useState(null);
  const [opponentRevealed, setOpponentRevealed] = useState(0);
  const [flashCells, setFlashCells] = useState({});
  const [opponentFlashCells, setOpponentFlashCells] = useState({});
  const [sabotageReady, setSabotageReady] = useState(true);
  const [playedEndSound, setPlayedEndSound] = useState(false);

  const gameOverRef = useRef(false);
  const myBoardRef = useRef(myBoard);
  const opponentBoardRef = useRef(opponentBoard);
  const onGameEndRef = useRef(onGameEnd);
  const onBackToLobbyRef = useRef(onBackToLobby);
  const playerNumRef = useRef(playerNum);
  const gracePeriodRef = useRef(false);
  const graceTimeoutRef = useRef(null);
  const flashTimeoutsRef = useRef([]);
  const sabotageReadyRef = useRef(true);
  const playedEndSoundRef = useRef(false);
  const opponentRevealedRef = useRef(0);
  const firstClickRef = useRef(true);

  useEffect(() => { myBoardRef.current = myBoard; }, [myBoard]);
  useEffect(() => { opponentBoardRef.current = opponentBoard; }, [opponentBoard]);
  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);
  useEffect(() => { onBackToLobbyRef.current = onBackToLobby; }, [onBackToLobby]);
  useEffect(() => { playedEndSoundRef.current = playedEndSound; }, [playedEndSound]);

  // Host timer
  useEffect(() => {
    if (!isHost) return;
    const tick = () => {
      const r = Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000));
      setTimeLeft(r);
      if (r <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true; gameOverRef.current = true; setGameOver(true);
        graceTimeoutRef.current = setTimeout(() => {
          const myC = countRevealed(myBoardRef.current), oNum = playerNumRef.current === 1 ? 2 : 1, oC = opponentRevealedRef.current;
          const s = { [playerNumRef.current]: myC, [oNum]: oC };
          send(dc, { type: 'game-over', scores: s, winner: null });
          setFinalScores(s); setGameResult('timeout'); setOpponentRevealed(oC);
          if (socket) socket.emit('game-ended');
          if (onGameEndRef.current) onGameEndRef.current(s);
        }, 500);
      }
    }; tick(); const i = setInterval(tick, 100);
    return () => { clearInterval(i); clearTimeout(graceTimeoutRef.current); };
  }, [isHost, startTime, duration, dc, socket]);

  // Non-host timer
  useEffect(() => {
    if (isHost) return;
    const tick = () => {
      setTimeLeft(Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000)));
      if (timeLeft <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true; gameOverRef.current = true;
        send(dc, { type: 'player-update', revealed: countRevealed(myBoardRef.current) });
      }
    }; tick(); const i = setInterval(tick, 100);
    return () => clearInterval(i);
  // eslint-disable-next-line
  }, [isHost, startTime, duration, dc]);

  // DC messages
  useEffect(() => {
    function handleMessage(e) {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'cell-reveal': {
          const up = cloneBoard(opponentBoardRef.current);
          for (const c of (msg.cells || [])) { if (c.row >= 0 && c.row < ROWS && c.col >= 0 && c.col < COLS) { up.grid[c.row][c.col].revealed = true; up.grid[c.row][c.col].adjacent = c.adjacent; } }
          opponentBoardRef.current = up; setOpponentBoard(up);
          const rc = countRevealed(up); opponentRevealedRef.current = rc; setOpponentRevealed(rc);
          break;
        }
        case 'cell-flag': {
          const up = cloneBoard(opponentBoardRef.current);
          if (msg.row >= 0 && msg.row < ROWS && msg.col >= 0 && msg.col < COLS) up.grid[msg.row][msg.col].flagged = msg.flagged;
          setOpponentBoard(up);
          break;
        }
        case 'sabotage': {
          const targets = getRevealedNumberedCells(myBoardRef.current);
          if (targets.length === 0) break;
          const t = targets[Math.floor(Math.random() * targets.length)], k = `${t.row},${t.col}`;
          setFlashCells(p => ({ ...p, [k]: true }));
          flashTimeoutsRef.current.push(setTimeout(() => {
            setMyBoard(p => { const n = cloneBoard(p); n.grid[t.row][t.col].sabotaged = true; return n; });
            setFlashCells(p => { const n = { ...p }; delete n[k]; return n; });
          }, 3000));
          send(dc, { type: 'cell-sabotaged', row: t.row, col: t.col });
          break;
        }
        case 'cell-sabotaged': {
          setOpponentFlashCells(p => ({ ...p, [`${msg.row},${msg.col}`]: true }));
          flashTimeoutsRef.current.push(setTimeout(() => {
            setOpponentBoard(p => { const n = cloneBoard(p); if (msg.row >= 0 && msg.row < ROWS && msg.col >= 0 && msg.col < COLS) n.grid[msg.row][msg.col].sabotaged = true; return n; });
            setOpponentFlashCells(p => { const n = { ...p }; delete n[`${msg.row},${msg.col}`]; return n; });
          }, 3000));
          break;
        }
        case 'game-over': {
          gameOverRef.current = true; setGameOver(true); setFinalScores(msg.scores);
          if (msg.winner !== undefined && msg.winner !== null) setGameResult(msg.winner === playerNumRef.current ? 'win' : 'lose');
          else {
            const pn = playerNumRef.current, on = pn === 1 ? 2 : 1, ms = msg.scores?.[pn] ?? 0, os = msg.scores?.[on] ?? 0;
            setOpponentRevealed(os); setGameResult(ms > os ? 'win' : ms < os ? 'lose' : 'tie');
          }
          if (onGameEndRef.current) onGameEndRef.current(msg.scores);
          break;
        }
        case 'restart': if (onBackToLobbyRef.current) onBackToLobbyRef.current(); break;
        case 'player-update': if (msg.revealed !== undefined) { setOpponentRevealed(msg.revealed); opponentRevealedRef.current = msg.revealed; } break;
      }
    }
    function handleDisconnect() { if (!gameOverRef.current) { gameOverRef.current = true; setGameOver(true); setFinalScores(null); setGameResult('lose'); } }
    if (dc) { dc.addEventListener('message', handleMessage); dc.addEventListener('close', handleDisconnect); dc.addEventListener('error', handleDisconnect); }
    return () => { if (dc) { dc.removeEventListener('message', handleMessage); dc.removeEventListener('close', handleDisconnect); dc.removeEventListener('error', handleDisconnect); } };
  }, [dc]);

  // Sound
  useEffect(() => { if (gameOver && !playedEndSoundRef.current) { setPlayedEndSound(true); if (gameResult === 'win') playWin(); else if (gameResult === 'lose') playLose(); } }, [gameOver, gameResult]);

  // Cleanup
  useEffect(() => { return () => { flashTimeoutsRef.current.forEach(clearTimeout); clearTimeout(graceTimeoutRef.current); }; }, []);

  // Sabotage key handler
  useEffect(() => {
    function handleKeyDown(e) {
      if (gameOverRef.current || !(e.key === 's' || e.key === 'S') || !sabotageReadyRef.current) return;
      sabotageReadyRef.current = false; setSabotageReady(false);
      send(dc, { type: 'sabotage' });
      flashTimeoutsRef.current.push(setTimeout(() => { sabotageReadyRef.current = true; setSabotageReady(true); }, SABOTAGE_COOLDOWN));
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dc]);

  // Reveal
  const handleReveal = useCallback((row, col) => {
    if (gameOverRef.current) return;
    let board = myBoardRef.current;
    let cell = board.grid[row][col];
    if (cell.revealed || cell.flagged) return;
    const isFirst = firstClickRef.current; firstClickRef.current = false;

    if (cell.mine && isFirst) { const n = cloneBoard(board); relocateMine(n.grid, row, col); board = n; cell = n.grid[row][col]; setMyBoard(n); myBoardRef.current = n; }

    if (cell.mine) {
      const n = cloneBoard(board); n.grid[row][col].revealed = true; setMyBoard(n); myBoardRef.current = n;
      gameOverRef.current = true; setGameOver(true); setGameResult('lose');
      const on = playerNumRef.current === 1 ? 2 : 1, oC = opponentRevealedRef.current, mC = countRevealed(n), s = { [playerNumRef.current]: mC, [on]: oC };
      send(dc, { type: 'cell-reveal', cells: [{ row, col, adjacent: -1 }] });
      send(dc, { type: 'game-over', scores: s, winner: on });
      setFinalScores(s); if (isHost && socket) socket.emit('game-ended'); if (onGameEndRef.current) onGameEndRef.current(s);
      return;
    }

    const nb = cloneBoard(board); floodFill(nb, row, col); setMyBoard(nb); myBoardRef.current = nb;
    const rc = []; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (nb.grid[r][c].revealed !== board.grid[r][c].revealed && !nb.grid[r][c].mine) rc.push({ row: r, col: c, adjacent: nb.grid[r][c].adjacent });
    if (rc.length > 0) send(dc, { type: 'cell-reveal', cells: rc });

    if (isWin(nb)) {
      gameOverRef.current = true; setGameOver(true); setGameResult('win');
      const mC = countRevealed(nb), on = playerNumRef.current === 1 ? 2 : 1, oC = opponentRevealedRef.current, s = { [playerNumRef.current]: mC, [on]: oC };
      playCorrect(); send(dc, { type: 'game-over', scores: s, winner: playerNumRef.current });
      setFinalScores(s); if (isHost && socket) socket.emit('game-ended'); if (onGameEndRef.current) onGameEndRef.current(s);
    }
  }, [isHost, socket, dc]);

  // Flag
  const handleFlag = useCallback((row, col, e) => {
    e.preventDefault(); if (gameOverRef.current) return;
    const board = myBoardRef.current; if (board.grid[row][col].revealed) return;
    const n = cloneBoard(board); const f = !n.grid[row][col].flagged; n.grid[row][col].flagged = f; setMyBoard(n); myBoardRef.current = n;
    send(dc, { type: 'cell-flag', row, col, flagged: f });
  }, [dc]);

  const handleRestart = () => { send(dc, { type: 'restart' }); onBackToLobby(); };

  const myR = countRevealed(myBoard), total = ROWS * COLS - NUM_MINES;

  return (
    <div style={styles.wrapper}>
      <style>{`@keyframes sabotageFlash{0%{filter:brightness(1)}100%{filter:brightness(1.8);background:#ff6b6b!important}}@keyframes heartbeat{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}`}</style>
      <div style={styles.topBar}>
        <span style={styles.modeLabel}>💣 Minesweeper</span>
        <span style={{ ...styles.timer, color: timeLeft <= 10 ? '#ff6b6b' : '#eee', animation: timeLeft <= 10 ? `heartbeat ${timeLeft <= 5 ? '0.4s' : '0.7s'} ease-in-out infinite` : 'none' }}>{timeLeft}s</span>
        <div style={styles.sabotageIndicator}>
          <span style={{ fontSize: '0.85rem', color: sabotageReady ? '#4ecca3' : '#888' }}>{sabotageReady ? 'S: Ready' : 'S: Cooldown'}</span>
          {!sabotageReady && <div style={styles.cooldownBar}><div style={styles.cooldownFill} /></div>}
        </div>
      </div>
      <div style={styles.boardsRow}>
        <div style={styles.panel}>
          <div style={styles.panelHeader}>You <span style={{ color: '#4ecca3', fontSize: '1rem' }}>{myR}/{total}</span></div>
          <div style={styles.board}>
            {myBoard.grid.map((row, r) => (
              <div key={r} style={styles.row}>{row.map((cell, c) => {
                const k = `${r},${c}`, fl = flashCells[k];
                let bg = '#2a2a4a'; if (cell.revealed) { if (cell.mine) bg = '#e94560'; else if (cell.sabotaged) bg = '#333'; else if (cell.adjacent === 0) bg = '#333'; else bg = '#3a3a5a'; }
                if (cell.flagged) bg = '#2a2a4a';
                return <div key={c} style={{ ...styles.cell, background: bg, animation: fl ? 'sabotageFlash 0.3s ease-in-out infinite alternate' : 'none', cursor: cell.revealed || gameOver ? 'default' : 'pointer' }}
                  onClick={() => handleReveal(r, c)} onContextMenu={(e) => handleFlag(r, c, e)}>
                  {cell.revealed && cell.mine ? <span style={{ fontSize: '1.2rem' }}>💥</span> : cell.revealed && cell.sabotaged ? <span style={{ fontSize: '1rem', color: '#888' }}>?</span> : cell.flagged ? <span style={{ fontSize: '1rem' }}>🚩</span> : cell.revealed ? (cell.adjacent === 0 ? null : <span style={{ fontWeight: 800, fontSize: '1rem', color: NUMBER_COLORS[cell.adjacent] || '#eee' }}>{cell.adjacent}</span>) : null}
                </div>;
              })}</div>
            ))}
          </div>
        </div>
        <div style={styles.divider} />
        <div style={styles.panel}>
          <div style={styles.panelHeader}>Opp <span style={{ color: '#e94560', fontSize: '1rem' }}>{opponentRevealed}/{total}</span></div>
          <div style={styles.board}>
            {opponentBoard.grid.map((row, r) => (
              <div key={r} style={styles.row}>{row.map((cell, c) => {
                const k = `${r},${c}`, fl = opponentFlashCells[k];
                let bg = '#2a2a4a'; if (cell.revealed) { if (cell.sabotaged) bg = '#333'; else if (cell.adjacent === 0) bg = '#333'; else bg = '#3a3a5a'; }
                if (cell.flagged) bg = '#2a2a4a';
                return <div key={c} style={{ width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '3px', userSelect: 'none', fontSize: '0.85rem', background: bg, animation: fl ? 'sabotageFlash 0.3s ease-in-out infinite alternate' : 'none', transition: 'background 0.1s ease' }}>
                  {cell.revealed && cell.sabotaged ? <span style={{ fontSize: '0.9rem', color: '#888' }}>?</span> : cell.flagged ? <span style={{ fontSize: '0.9rem' }}>🚩</span> : cell.revealed ? (cell.adjacent === 0 ? null : <span style={{ fontWeight: 700, fontSize: '0.85rem', color: NUMBER_COLORS[cell.adjacent] || '#eee' }}>{cell.adjacent}</span>) : null}
                </div>;
              })}</div>
            ))}
          </div>
        </div>
      </div>
      {!gameOver && <div style={styles.instructions}>Left-click to reveal | Right-click to flag | Press <kbd style={styles.kbd}>S</kbd> to sabotage</div>}
      {gameOver && (
        <div style={styles.gameOverOverlay}>
          <div style={styles.gameOverCard}>
            {finalScores ? <>
              <div style={styles.trophy}>{gameResult === 'win' ? '🏆' : gameResult === 'tie' ? '🤝' : '💀'}</div>
              <div style={styles.resultText}>{gameResult === 'win' ? 'You Won!' : gameResult === 'lose' ? 'You Lost' : "It's a Tie!"}</div>
              <div style={{ fontSize: '1rem', color: '#888' }}>You: {finalScores[playerNum] ?? myR} cells | Opp: {finalScores[playerNum === 1 ? 2 : 1] ?? opponentRevealed} cells</div>
            </> : <div style={{ color: '#ff6b6b', fontSize: '1.2rem' }}>Connection lost</div>}
            <button onClick={handleRestart} style={styles.restartBtn}>Play Again</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrapper: { display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '12px', background: '#1a1a2e', color: '#eee', fontFamily: 'system-ui, -apple-system, sans-serif', position: 'relative' },
  topBar: { display: 'flex', alignItems: 'center', gap: '24px', width: '100%', maxWidth: '100%', justifyContent: 'center', marginBottom: '4px' },
  modeLabel: { fontSize: '0.95rem', color: '#e94560', fontWeight: 700 },
  timer: { fontSize: '2rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' },
  sabotageIndicator: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
  cooldownBar: { width: '60px', height: '4px', background: '#333', borderRadius: '2px', overflow: 'hidden' },
  cooldownFill: { width: '100%', height: '100%', background: '#e94560', borderRadius: '2px' },
  boardsRow: { display: 'flex', gap: '16px', flex: 1, alignItems: 'center', justifyContent: 'center', width: '100%', maxWidth: '900px' },
  panel: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' },
  panelHeader: { fontSize: '1rem', fontWeight: 700, display: 'flex', gap: '8px', alignItems: 'center' },
  divider: { width: '2px', background: '#333', alignSelf: 'stretch', minHeight: '100px' },
  board: { display: 'flex', flexDirection: 'column', gap: '2px', background: '#16213e', padding: '8px', borderRadius: '8px' },
  row: { display: 'flex', gap: '2px' },
  cell: { width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', userSelect: 'none', fontSize: '0.9rem', transition: 'background 0.1s ease' },
  instructions: { fontSize: '0.8rem', color: '#666', textAlign: 'center', marginTop: '4px' },
  kbd: { background: '#333', padding: '2px 8px', borderRadius: '4px', color: '#eee', fontWeight: 700, fontSize: '0.8rem' },
  gameOverOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  gameOverCard: { background: '#16213e', border: '2px solid #2a2a4a', borderRadius: '16px', padding: '40px 48px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', textAlign: 'center' },
  trophy: { fontSize: '4rem', animation: 'heartbeat 0.6s ease-in-out 3' },
  resultText: { fontSize: '1.8rem', fontWeight: 800 },
  restartBtn: { marginTop: '8px', fontSize: '1.1rem', padding: '12px 36px', background: '#e94560', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: 'pointer' },
};
