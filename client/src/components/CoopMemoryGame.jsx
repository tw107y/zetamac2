import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

const EMOJIS = ['🍎','🍊','🍋','🍇','🌟','🔥','💎','🎯','🌈','🦄','🍕','🎸','🌮','🐙','👻','🎃','🚀','💡','🎪','🦋','🍒','🐳','🌻'];
const LEVEL_TIME = 30;

function send(dc, msg) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg)); }

function shuffle(seed, arr) {
  let s = seed;
  function rand() { s = (s * 1664525 + 1013904223) | 0; return (s >>> 0) / 4294967296; }
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function generateBoard(level) {
  const size = 4 + level; // 5x5, 6x6, 7x7...
  const pairs = Math.floor(size * size / 2);
  const picks = EMOJIS.slice(0, pairs);
  const cards = shuffle(Date.now(), [...picks, ...picks]);
  return { size, pairs, grid: cards.map((emoji, i) => ({
    id: i, emoji, revealed: false, matched: false,
    row: Math.floor(i / size), col: i % size,
  }))};
}

export default function CoopMemoryGame({
  dc, startTime, playerNum, isHost, socket, onBackToLobby, onGameEnd,
}) {
  const [level, setLevel] = useState(1);
  const [board, setBoard] = useState(null);
  const [timeLeft, setTimeLeft] = useState(LEVEL_TIME);
  const [phase, setPhase] = useState('preview'); // 'preview' | 'play' | 'gameover'
  const [selected, setSelected] = useState([]);
  const [totalScore, setTotalScore] = useState(0);
  const [shake, setShake] = useState(false);

  const boardRef = useRef(null);
  const levelRef = useRef(1);
  const scoreRef = useRef(0);
  const lockedRef = useRef(false);
  const phaseRef = useRef('preview');
  const timerRef = useRef(null);
  const playerNumRef = useRef(playerNum);
  const onBackToLobbyRef = useRef(onBackToLobby);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onBackToLobbyRef.current = onBackToLobby; }, [onBackToLobby]);

  // Host initializes board
  useEffect(() => {
    if (!isHost) return;
    const b = generateBoard(level);
    boardRef.current = b;
    setBoard(b);
    send(dc, { type: 'board', board: b, level });
  }, [isHost, level]);

  // DC messages
  useEffect(() => {
    function handle(e) {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'board':
          boardRef.current = msg.board;
          setBoard(msg.board);
          levelRef.current = msg.level;
          setLevel(msg.level);
          break;
        case 'flip':
          if (msg.cardId !== undefined && boardRef.current) {
            const b = { ...boardRef.current, grid: boardRef.current.grid.map(c =>
              c.id === msg.cardId ? { ...c, revealed: msg.revealed } : c
            )};
            boardRef.current = b; setBoard(b);
          }
          break;
        case 'match':
          if (msg.ids && boardRef.current) {
            const b = { ...boardRef.current, grid: boardRef.current.grid.map(c =>
              msg.ids.includes(c.id) ? { ...c, matched: true, revealed: true } : c
            )};
            boardRef.current = b; setBoard(b);
            scoreRef.current = msg.score;
            setTotalScore(msg.score);
          }
          break;
        case 'level-up':
          setLevel(msg.level); levelRef.current = msg.level;
          setPhase('preview'); phaseRef.current = 'preview';
          setSelected([]); lockedRef.current = false;
          if (timerRef.current) clearTimeout(timerRef.current);
          break;
        case 'game-over':
          setPhase('gameover'); phaseRef.current = 'gameover';
          if (timerRef.current) clearTimeout(timerRef.current);
          break;
        case 'restart':
          if (onBackToLobbyRef.current) onBackToLobbyRef.current();
          break;
      }
    }
    dc.addEventListener('message', handle);
    return () => dc.removeEventListener('message', handle);
  }, [dc]);

  // Preview → Play transition (host)
  useEffect(() => {
    if (!isHost || phase !== 'preview' || !board) return;
    phaseRef.current = 'preview';
    timerRef.current = setTimeout(() => {
      // Flip all cards face down
      const b = { ...boardRef.current, grid: boardRef.current.grid.map(c => ({ ...c, revealed: true })) };
      boardRef.current = b; setBoard(b);
      send(dc, { type: 'reveal-all', revealed: true });

      setTimeout(() => {
        const hidden = { ...boardRef.current, grid: boardRef.current.grid.map(c => ({ ...c, revealed: false })) };
        boardRef.current = hidden; setBoard(hidden);
        send(dc, { type: 'reveal-all', revealed: false });
        setPhase('play'); phaseRef.current = 'play';
        setTimeLeft(LEVEL_TIME);

        // Start level timer
        timerRef.current = setTimeout(() => {
          if (phaseRef.current === 'play') {
            setPhase('gameover'); phaseRef.current = 'gameover';
            send(dc, { type: 'game-over', score: scoreRef.current });
            playLose();
          }
        }, LEVEL_TIME * 1000);
      }, 1500);
    }, 500);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [isHost, phase, board, level]);

  // Card click
  const handleClick = useCallback((id) => {
    if (!board || phase !== 'play' || phaseRef.current !== 'play' || lockedRef.current) return;
    const card = boardRef.current.grid[id];
    if (!card || card.revealed || card.matched) return;

    // Flip card
    const b = { ...boardRef.current, grid: boardRef.current.grid.map(c =>
      c.id === id ? { ...c, revealed: true } : c
    )};
    boardRef.current = b; setBoard(b);
    const newSel = [...selected, id];
    setSelected(newSel);
    send(dc, { type: 'flip', cardId: id, revealed: true });

    if (newSel.length === 2) {
      lockedRef.current = true;
      const [a, b2] = newSel;
      const ca = boardRef.current.grid[a], cb = boardRef.current.grid[b2];

      if (ca.emoji === cb.emoji) {
        // Match!
        setTimeout(() => {
          const matched = { ...boardRef.current, grid: boardRef.current.grid.map(c =>
            c.id === a || c.id === b2 ? { ...c, matched: true, revealed: true } : c
          )};
          boardRef.current = matched; setBoard(matched);
          const ns = scoreRef.current + 1; scoreRef.current = ns;
          setTotalScore(ns); setSelected([]); lockedRef.current = false;
          send(dc, { type: 'match', ids: [a, b2], score: ns });
          playCorrect();

          // Check level complete
          if (matched.grid.every(c => c.matched)) {
            const nl = levelRef.current + 1;
            if (isHost) {
              setLevel(nl); levelRef.current = nl;
              send(dc, { type: 'level-up', level: nl });
            }
          }
        }, 300);
      } else {
        // No match
        setShake(true); setTimeout(() => setShake(false), 300);
        setTimeout(() => {
          const reset = { ...boardRef.current, grid: boardRef.current.grid.map(c =>
            c.id === a || c.id === b2 ? { ...c, revealed: false } : c
          )};
          boardRef.current = reset; setBoard(reset);
          setSelected([]); lockedRef.current = false;
          send(dc, { type: 'flip', cardId: a, revealed: false });
          send(dc, { type: 'flip', cardId: b2, revealed: false });
        }, 500);
      }
    }
  }, [board, phase, selected, isHost, dc]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <span style={{ color: '#4ecca3', fontWeight: 700 }}>🧠 Co-op Memory</span>
        <span style={{ fontSize: '1.5rem', fontWeight: 800, color: timeLeft <= 5 ? '#ff6b6b' : '#eee' }}>{phase === 'play' ? `${timeLeft}s` : '...'}</span>
        <span style={{ color: '#888' }}>Level {level} · Score {totalScore}</span>
      </div>
      {phase === 'preview' && <p style={{ color: '#ffd700', fontSize: '1.2rem' }}>Memorize the board!</p>}
      {phase === 'play' && <p style={{ color: '#4ecca3' }}>Find all pairs together!</p>}
      {phase === 'gameover' && (
        <div style={{ textAlign: 'center', marginTop: '12px' }}>
          <div style={{ fontSize: '3rem' }}>🏆</div>
          <div style={{ fontSize: '1.2rem', color: '#888' }}>Level {level} · {totalScore} pairs found</div>
          <button onClick={() => { send(dc, { type: 'restart' }); onBackToLobby?.(); }}
            style={{ padding: '10px 28px', marginTop: '8px' }}>Play Again</button>
        </div>
      )}
      {board && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${board.size}, 60px)`, gap: '5px', transform: shake ? 'translateX(4px)' : 'none', transition: 'transform 0.1s' }}>
          {board.grid.map(c => (
            <button key={c.id} onClick={() => handleClick(c.id)}
              disabled={phase !== 'play'}
              style={{
                width: '60px', height: '60px', border: '2px solid',
                borderColor: c.matched ? '#4ecca3' : c.revealed ? '#4466aa' : '#333',
                borderRadius: '6px', background: c.matched ? '#1a3a1a' : c.revealed ? '#1a1a3a' : '#16213e',
                fontSize: '1.5rem', cursor: phase === 'play' ? 'pointer' : 'default',
                transition: 'all 0.15s',
              }}
            >{(c.revealed || c.matched) ? c.emoji : '?'}</button>
          ))}
        </div>
      )}
    </div>
  );
}
