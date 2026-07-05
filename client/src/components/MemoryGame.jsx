import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

const EMOJIS = ['🍎','🍊','🍋','🍇','🌟','🔥','💎','🎯','🌈','🦄','🍕','🎸'];
const PAIRS = 8;
const GRID = 4;
const MATCH_PAUSE = 500;
const PEEK_DURATION = 1000;

function send(dc, msg) {
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg));
}

function generateLayout(seed) {
  // Use seeded shuffle for same layout on both clients
  const picks = EMOJIS.slice(0, PAIRS);
  const cards = [...picks, ...picks];
  // Fisher-Yates with simple seeded random
  let s = seed || Date.now();
  function rand() { s = (s * 1664525 + 1013904223) | 0; return (s >>> 0) / 4294967296; }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards.map((emoji, i) => ({
    id: i, emoji, revealed: false, matched: false,
    row: Math.floor(i / GRID), col: i % GRID,
  }));
}

export default function MemoryGame({
  dc, layoutSeed, startTime, duration, playerNum, isHost, socket,
  onBackToLobby, onGameEnd,
}) {
  const [cards, setCards] = useState(() => generateLayout(layoutSeed));
  const [opponentState, setOpponentState] = useState({ score: 0, flipped: [] });
  const [timeLeft, setTimeLeft] = useState(duration);
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [selected, setSelected] = useState([]);
  const [peekCard, setPeekCard] = useState(null);
  const [shake, setShake] = useState(false);

  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false);
  const graceTimeoutRef = useRef(null);
  const scoreRef = useRef(0);
  const oppScoreRef = useRef(0);
  const lockedRef = useRef(false);
  const playerNumRef = useRef(playerNum);
  const onGameEndRef = useRef(onGameEnd);
  const onBackToLobbyRef = useRef(onBackToLobby);
  const cardsRef = useRef(cards);
  const selectedRef = useRef([]);
  const scoresFinalizedRef = useRef(false);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);
  useEffect(() => { onBackToLobbyRef.current = onBackToLobby; }, [onBackToLobby]);
  useEffect(() => { cardsRef.current = cards; }, [cards]);

  // Host timer
  useEffect(() => {
    if (!isHost) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
        setGameOver(true);
        graceTimeoutRef.current = setTimeout(() => {
          const p = playerNumRef.current;
          const o = p === 1 ? 2 : 1;
          const s = { [p]: scoreRef.current, [o]: oppScoreRef.current };
          scoresFinalizedRef.current = true;
          send(dc, { type: 'game-over', scores: s });
          setScores(s);
          if (socket) socket.emit('game-ended');
          if (onGameEndRef.current) onGameEndRef.current(s);
        }, 500);
      }
    };
    tick();
    const i = setInterval(tick, 100);
    return () => { clearInterval(i); clearTimeout(graceTimeoutRef.current); };
  }, [isHost, startTime, duration, dc]);

  // Joiner timer
  useEffect(() => {
    if (isHost) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
        send(dc, { type: 'player-update', score: scoreRef.current });
      }
    };
    tick();
    const i = setInterval(tick, 100);
    return () => clearInterval(i);
  }, [isHost, startTime, duration, dc]);

  // DC messages
  useEffect(() => {
    function handle(e) {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'player-update':
          oppScoreRef.current = msg.score ?? oppScoreRef.current;
          setOpponentState(p => ({ ...p, score: oppScoreRef.current, flipped: msg.flipped ? msg.flipped : p.flipped }));
          if (msg.gameOver && isHost) {
            gameOverRef.current = true;
            setGameOver(true);
            scoresFinalizedRef.current = true;
            const pNum = playerNumRef.current;
            const oNum = pNum === 1 ? 2 : 1;
            const s = { [pNum]: scoreRef.current, [oNum]: oppScoreRef.current };
            setScores(s);
            send(dc, { type: 'game-over', scores: s });
            if (socket) socket.emit('game-ended');
            if (onGameEndRef.current) onGameEndRef.current(s);
            const w = scoreRef.current > oppScoreRef.current;
            if (w) playWin(); else playLose();
          }
          break;
        case 'card-flip':
          setOpponentState(p => ({ ...p, flipped: msg.cards }));
          break;
        case 'match-found':
          oppScoreRef.current = msg.score;
          setOpponentState(p => ({ ...p, score: msg.score, flipped: [] }));
          // Memory Thief: peek at opponent's unrevealed card
          if (msg.peekCard !== undefined) {
            setPeekCard(msg.peekCard);
            setTimeout(() => setPeekCard(null), PEEK_DURATION);
          }
          break;
        case 'game-over':
          gameOverRef.current = true;
          setGameOver(true);
          scoresFinalizedRef.current = true;
          setScores(msg.scores);
          if (onGameEndRef.current) onGameEndRef.current(msg.scores);
          const p = playerNumRef.current;
          const o = p === 1 ? 2 : 1;
          const w = (msg.scores[p] ?? 0) > (msg.scores[o] ?? 0);
          if (w) playWin(); else playLose();
          break;
        case 'restart':
          if (onBackToLobbyRef.current) onBackToLobbyRef.current();
          break;
      }
    }
    dc.addEventListener('message', handle);
    return () => dc.removeEventListener('message', handle);
  }, [dc, isHost, socket]);

  // Card click
  const handleClick = useCallback((id) => {
    if (gameOver || gameOverRef.current || lockedRef.current) return;

    const card = cardsRef.current[id];
    if (card.revealed || card.matched) return;

    // Flip card
    const newCards = cardsRef.current.map(c => c.id === id ? { ...c, revealed: true } : c);
    const newSelected = [...selectedRef.current, id];
    selectedRef.current = newSelected;
    setCards(newCards);
    setSelected(newSelected);

    // Send flip to opponent
    send(dc, { type: 'card-flip', cards: newSelected });

    if (newSelected.length === 2) {
      lockedRef.current = true;
      const [a, b] = newSelected;
      const cardA = newCards[a], cardB = newCards[b];

      if (cardA.emoji === cardB.emoji) {
        // Match!
        setTimeout(() => {
          const matched = newCards.map(c =>
            c.id === a || c.id === b ? { ...c, matched: true } : c
          );
          setCards(matched);
          cardsRef.current = matched;
          const newScore = scoreRef.current + 1;
          scoreRef.current = newScore;
          setSelected([]); selectedRef.current = [];
          lockedRef.current = false;
          playCorrect();

          // Memory Thief: reveal one random unrevealed opponent card
          const unrevealed = matched.filter(c => !c.matched && !c.revealed);
          const peek = unrevealed.length > 0
            ? unrevealed[Math.floor(Math.random() * unrevealed.length)].id
            : undefined;

          send(dc, { type: 'match-found', score: newScore, peekCard: peek });

          // Check win
          if (newScore >= PAIRS && !scoresFinalizedRef.current) {
            gameOverRef.current = true;
            scoresFinalizedRef.current = true;
            setGameOver(true);
            const p = playerNumRef.current;
            const o = p === 1 ? 2 : 1;
            const s = { [p]: newScore, [o]: oppScoreRef.current };
            setScores(s);
            if (isHost) {
              send(dc, { type: 'game-over', scores: s });
              if (socket) socket.emit('game-ended');
              if (onGameEndRef.current) onGameEndRef.current(s);
            } else {
              send(dc, { type: 'player-update', score: newScore, gameOver: true, myRevealedCount: newScore });
            }
            playWin();
            return;
          }

          // Update opponent score
          setOpponentState(p => ({ ...p, score: oppScoreRef.current, flipped: [] }));
        }, MATCH_PAUSE);
      } else {
        // No match — flip back
        setShake(true);
        setTimeout(() => setShake(false), 300);
        setTimeout(() => {
          const reset = newCards.map(c =>
            c.id === a || c.id === b ? { ...c, revealed: false } : c
          );
          setCards(reset);
          cardsRef.current = reset;
          setSelected([]); selectedRef.current = [];
          lockedRef.current = false;
          send(dc, { type: 'card-flip', cards: [], score: scoreRef.current });
        }, MATCH_PAUSE);
      }
    }
  }, [gameOver, dc, socket, isHost]);

  const handleRestart = () => {
    send(dc, { type: 'restart' });
    if (onBackToLobbyRef.current) onBackToLobbyRef.current();
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.top}>
        <span style={styles.mode}>🃏 Memory</span>
        <span style={{ ...styles.timer, color: timeLeft <= 10 ? '#ff6b6b' : '#eee', animation: timeLeft <= 10 ? 'heartbeat 0.7s infinite' : 'none' }}>
          {timeLeft}s
        </span>
      </div>

      <div style={styles.panels}>
        {/* My board */}
        <div style={{ ...styles.panel, transform: shake ? 'translateX(4px)' : 'none' }}>
          <div style={styles.head}>You <span style={styles.score}>{scoreRef.current}/{PAIRS}</span></div>
          <div style={styles.grid}>
            {cards.map(c => (
              <button
                key={c.id}
                onClick={() => handleClick(c.id)}
                style={{
                  ...styles.cell,
                  background: c.matched ? '#1a3a1a' : c.revealed ? '#1a1a3a' : '#16213e',
                  borderColor: c.matched ? '#4ecca3' : selected.includes(c.id) ? '#e94560' : '#333',
                  transform: selected.includes(c.id) ? 'scale(1.05)' : 'scale(1)',
                }}
                disabled={gameOver}
              >
                <span style={styles.emoji}>
                  {(c.revealed || c.matched) ? c.emoji : '?'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div style={styles.divider} />

        {/* Opponent board */}
        <div style={styles.panel}>
          <div style={styles.head}>Opponent <span style={styles.score}>{opponentState.score}/{PAIRS}</span></div>
          <div style={styles.grid}>
            {cards.map(c => (
              <div
                key={c.id}
                style={{
                  ...styles.cell,
                  background: opponentState.flipped.includes(c.id)
                    ? '#1a1a3a'
                    : peekCard === c.id
                      ? '#2a2a1a'
                      : '#16213e',
                  borderColor: peekCard === c.id ? '#ffd700' : opponentState.flipped.includes(c.id) ? '#e94560' : '#333',
                  transition: 'background 0.2s, border-color 0.2s',
                }}
              >
                <span style={styles.emoji}>
                  {peekCard === c.id ? c.emoji : opponentState.flipped.includes(c.id) ? c.emoji : '?'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {gameOver && (
        <div style={styles.overlay}>
          <div style={styles.trophy}>
            {scores && (scores[playerNum] ?? 0) > (scores[playerNum === 1 ? 2 : 1] ?? 0) ? '🏆' : '🤖'}
          </div>
          <div style={styles.result}>
            {scores ? `${scores[playerNum] ?? 0} – ${scores[playerNum === 1 ? 2 : 1] ?? 0}` : 'Connection lost'}
          </div>
          <button onClick={handleRestart} style={styles.btn}>Play Again</button>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '12px' },
  top: { display: 'flex', alignItems: 'center', gap: '24px' },
  mode: { color: '#e94560', fontWeight: 700 },
  timer: { fontSize: '2rem', fontWeight: 800 },
  panels: { display: 'flex', gap: '24px', flexWrap: 'wrap', justifyContent: 'center' },
  panel: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', transition: 'transform 0.1s' },
  head: { fontSize: '1.1rem', fontWeight: 700, display: 'flex', gap: '12px' },
  score: { color: '#4ecca3', fontSize: '1.3rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(4, 70px)', gap: '6px' },
  cell: { width: '70px', height: '70px', border: '2px solid #333', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.15s', fontSize: '1.8rem' },
  emoji: { fontSize: '1.8rem', userSelect: 'none' },
  divider: { width: '2px', background: '#222', alignSelf: 'stretch' },
  overlay: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginTop: '20px' },
  trophy: { fontSize: '4rem', animation: 'heartbeat 0.6s 3' },
  result: { fontSize: '1.2rem', color: '#888' },
  btn: { padding: '10px 28px', fontSize: '1rem' },
};
