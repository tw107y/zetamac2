import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
const COLOR_HEX = { red: '#ff4444', blue: '#4488ff', green: '#44cc44', yellow: '#ffdd44', purple: '#cc44ff', orange: '#ff8844' };
const ROUND_TIME = 2500;

function send(dc, msg) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg)); }

export default function ColorGame({ dc, startTime, duration, playerNum, isHost, socket, onBackToLobby, onGameEnd }) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [myScore, setMyScore] = useState(0);
  const [oppScore, setOppScore] = useState(0);
  const [word, setWord] = useState('red');
  const [ink, setInk] = useState('blue');
  const [round, setRound] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [stunned, setStunned] = useState(false);

  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false);
  const scoreRef = useRef(0);
  const oppScoreRef = useRef(0);
  const roundRef = useRef(0);
  const roundTimerRef = useRef(null);
  const playerNumRef = useRef(playerNum);
  const onGameEndRef = useRef(onGameEnd);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);

  // Timer (host)
  useEffect(() => {
    if (!isHost) return;
    const tick = () => {
      const r = Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000));
      setTimeLeft(r);
      if (r <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
        setGameOver(true);
        setTimeout(() => {
          const p = playerNumRef.current, o = p === 1 ? 2 : 1;
          const s = { [p]: scoreRef.current, [o]: oppScoreRef.current };
          send(dc, { type: 'game-over', scores: s });
          setScores(s);
          if (socket) socket.emit('game-ended');
          if (onGameEndRef.current) onGameEndRef.current(s);
        }, 500);
      }
    };
    tick();
    const i = setInterval(tick, 100);
    return () => clearInterval(i);
  }, [isHost, startTime, duration, dc, socket]);

  // Joiner timer
  useEffect(() => {
    if (isHost) return;
    const tick = () => {
      const r = Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000));
      setTimeLeft(r);
    };
    tick();
    const i = setInterval(tick, 100);
    return () => clearInterval(i);
  }, [isHost, startTime, duration]);

  // DC messages
  useEffect(() => {
    function handle(e) {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'player-update':
          oppScoreRef.current = msg.score ?? oppScoreRef.current;
          setOppScore(oppScoreRef.current);
          break;
        case 'answer':
          oppScoreRef.current = msg.score;
          setOppScore(msg.score);
          break;
        case 'round':
          setWord(msg.word); setInk(msg.ink); setRound(msg.round);
          clearTimeout(roundTimerRef.current);
          roundTimerRef.current = setTimeout(() => {
            setFeedback('miss');
            setTimeout(() => setFeedback(null), 400);
          }, ROUND_TIME);
          break;
        case 'game-over':
          gameOverRef.current = true; setGameOver(true); setScores(msg.scores);
          if (onGameEndRef.current) onGameEndRef.current(msg.scores);
          (msg.scores[playerNum] ?? 0) > (msg.scores[playerNum === 1 ? 2 : 1] ?? 0) ? playWin() : playLose();
          break;
        case 'restart':
          if (onBackToLobby) onBackToLobby();
          break;
      }
    }
    dc.addEventListener('message', handle);
    return () => { dc.removeEventListener('message', handle); clearTimeout(roundTimerRef.current); };
  }, [dc, playerNum, onBackToLobby]);

  // Spawn rounds (host)
  useEffect(() => {
    if (!isHost || gameOver) return;
    function spawn() {
      if (gameOverRef.current) return;
      const w = COLORS[Math.floor(Math.random() * COLORS.length)];
      let ink;
      do { ink = COLORS[Math.floor(Math.random() * COLORS.length)]; } while (ink === w && COLORS.length > 1);
      const r = roundRef.current + 1;
      roundRef.current = r;
      setWord(w); setInk(ink); setRound(r);
      send(dc, { type: 'round', word: w, ink, round: r });
      clearTimeout(roundTimerRef.current);
      roundTimerRef.current = setTimeout(spawn, ROUND_TIME);
    }
    roundTimerRef.current = setTimeout(spawn, 800);
    return () => clearTimeout(roundTimerRef.current);
  }, [isHost, gameOver]);

  // Joiner receives rounds
  useEffect(() => {
    if (isHost) return;
    function handle(e) {
      const msg = JSON.parse(e.data);
      if (msg.type === 'round') {
        setWord(msg.word); setInk(msg.ink); setRound(msg.round);
        clearTimeout(roundTimerRef.current);
        roundTimerRef.current = setTimeout(() => {
          setFeedback('miss');
          setTimeout(() => setFeedback(null), 400);
        }, ROUND_TIME);
      }
    }
    dc.addEventListener('message', handle);
    return () => dc.removeEventListener('message', handle);
  }, [isHost, dc]);

  const handleAnswer = useCallback((color) => {
    if (gameOver || stunned || !ink) return;
    clearTimeout(roundTimerRef.current);
    if (color === ink) {
      const ns = scoreRef.current + 1;
      scoreRef.current = ns;
      setMyScore(ns);
      playCorrect();
      setFeedback('hit');
      setTimeout(() => setFeedback(null), 300);
      send(dc, { type: 'answer', score: ns });
    } else {
      setStunned(true);
      setFeedback('wrong');
      setTimeout(() => { setStunned(false); setFeedback(null); }, 600);
    }
  }, [gameOver, stunned, ink, dc]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <span style={{ color: '#e94560', fontWeight: 700 }}>🎨 Color Chaos</span>
        <span style={{ fontSize: '2rem', fontWeight: 800, color: timeLeft <= 10 ? '#ff6b6b' : '#eee' }}>{timeLeft}s</span>
        <span style={{ color: '#888' }}>You {myScore} – {oppScore} Opp</span>
      </div>
      <p style={{ color: '#888', fontSize: '0.85rem' }}>Press the button matching the INK COLOR, not the word!</p>
      <div style={{ fontSize: '4rem', fontWeight: 900, color: COLOR_HEX[ink] || '#fff', textShadow: '0 0 10px currentColor', margin: '20px 0' }}>
        {word?.toUpperCase()}
      </div>
      {!gameOver && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
          {COLORS.map(c => (
            <button key={c} onClick={() => handleAnswer(c)}
              disabled={stunned || gameOver}
              style={{
                padding: '14px 24px', fontSize: '1rem', fontWeight: 700,
                background: COLOR_HEX[c], color: '#fff', border: '2px solid #fff3',
                borderRadius: '8px', cursor: stunned ? 'default' : 'pointer',
                opacity: stunned ? 0.5 : 1,
              }}>{c}</button>
          ))}
        </div>
      )}
      {feedback && (
        <div style={{ fontSize: '2rem', fontWeight: 900, color: feedback === 'hit' ? '#4ecca3' : feedback === 'wrong' ? '#ff4444' : '#ff8800' }}>
          {feedback === 'hit' ? '+1' : feedback === 'wrong' ? 'WRONG!' : 'MISS'}
        </div>
      )}
      {gameOver && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '3rem' }}>{(scores?.[playerNum] ?? 0) > (scores?.[playerNum === 1 ? 2 : 1] ?? 0) ? '🏆' : '🤖'}</div>
          <div style={{ color: '#888' }}>{scores ? `${scores[playerNum] ?? 0} – ${scores[playerNum === 1 ? 2 : 1] ?? 0}` : ''}</div>
          <button onClick={() => { send(dc, { type: 'restart' }); onBackToLobby?.(); }}
            style={{ padding: '10px 28px', marginTop: '8px' }}>Play Again</button>
        </div>
      )}
    </div>
  );
}
