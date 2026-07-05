import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

const TOTAL_TARGETS = 20;
const TARGET_DURATION = 1500;
const FAKE_CHANCE = 0.35;

function send(dc, msg) {
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg));
}

function randomPos() {
  return {
    x: 15 + Math.random() * 70,  // % from left
    y: 15 + Math.random() * 60,  // % from top
  };
}

export default function ReactionGame({
  dc, startTime, duration, playerNum, isHost, socket,
  onBackToLobby, onGameEnd,
}) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [target, setTarget] = useState(null); // { id, x, y, isFake, round }
  const [myScore, setMyScore] = useState(0);
  const [oppScore, setOppScore] = useState(0);
  const [shake, setShake] = useState(false);
  const [feedback, setFeedback] = useState(null); // 'hit' | 'miss' | 'fake'

  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false);
  const graceTimeoutRef = useRef(null);
  const scoreRef = useRef(0);
  const oppScoreRef = useRef(0);
  const roundRef = useRef(0);
  const targetTimerRef = useRef(null);
  const playerNumRef = useRef(playerNum);
  const onGameEndRef = useRef(onGameEnd);
  const onBackToLobbyRef = useRef(onBackToLobby);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);
  useEffect(() => { onBackToLobbyRef.current = onBackToLobby; }, [onBackToLobby]);

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

  // Merged DC message handler
  useEffect(() => {
    function handle(e) {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'player-update':
          oppScoreRef.current = msg.score ?? oppScoreRef.current;
          setOppScore(oppScoreRef.current);
          break;
        case 'claim':
          oppScoreRef.current = msg.score;
          setOppScore(msg.score);
          break;
        case 'game-over':
          gameOverRef.current = true; setGameOver(true); setScores(msg.scores);
          if (onGameEndRef.current) onGameEndRef.current(msg.scores);
          const p = playerNumRef.current, o = p === 1 ? 2 : 1;
          (msg.scores[p] ?? 0) > (msg.scores[o] ?? 0) ? playWin() : playLose();
          break;
        case 'restart':
          if (onBackToLobbyRef.current) onBackToLobbyRef.current();
          break;
        case 'target':
          if (isHost) return;
          setTarget({ id: msg.id, x: msg.x, y: msg.y, isFake: msg.isFake, round: msg.round });
          targetTimerRef.current = setTimeout(() => setTarget(null), TARGET_DURATION);
          break;
      }
    }
    dc.addEventListener('message', handle);
    return () => dc.removeEventListener('message', handle);
  }, [dc, isHost]);

  // Spawn targets (host only)
  useEffect(() => {
    if (!isHost) return;
    function spawn() {
      if (gameOverRef.current) return;
      roundRef.current++;
      // If we've already passed TOTAL_TARGETS, trigger game-over instead
      if (roundRef.current > TOTAL_TARGETS) {
        gameOverRef.current = true;
        setGameOver(true);
        const p = playerNumRef.current, o = p === 1 ? 2 : 1;
        const s = { [p]: scoreRef.current, [o]: oppScoreRef.current };
        send(dc, { type: 'game-over', scores: s });
        setScores(s);
        if (socket) socket.emit('game-ended');
        if (onGameEndRef.current) onGameEndRef.current(s);
        return;
      }
      const isFake = Math.random() < FAKE_CHANCE;
      const t = { id: Date.now(), ...randomPos(), isFake, round: roundRef.current };
      setTarget(t);
      // Send target to joiner
      send(dc, { type: 'target', ...t });
      // Auto-miss if not clicked
      targetTimerRef.current = setTimeout(() => {
        setTarget(null);
        if (roundRef.current >= TOTAL_TARGETS && !gameOverRef.current) {
          // All targets done
          gameOverRef.current = true;
          setGameOver(true);
          const p = playerNumRef.current, o = p === 1 ? 2 : 1;
          const s = { [p]: scoreRef.current, [o]: oppScoreRef.current };
          send(dc, { type: 'game-over', scores: s });
          setScores(s);
          if (socket) socket.emit('game-ended');
          if (onGameEndRef.current) onGameEndRef.current(s);
        } else {
          setTimeout(spawn, 400 + Math.random() * 800);
        }
      }, TARGET_DURATION);
    }
    setTimeout(spawn, 1000);
    return () => clearTimeout(targetTimerRef.current);
  }, [isHost]);

  // Click handler
  const handleHit = useCallback(() => {
    if (!target || gameOver || gameOverRef.current) return;
    clearTimeout(targetTimerRef.current);

    if (target.isFake) {
      // Fake target — penalty!
      const newScore = Math.max(0, scoreRef.current - 1);
      scoreRef.current = newScore;
      setMyScore(newScore);
      setShake(true);
      setTimeout(() => setShake(false), 400);
      setFeedback('fake');
      setTimeout(() => setFeedback(null), 300);
      setTarget(null);
      send(dc, { type: 'claim', score: newScore });
      if (roundRef.current >= TOTAL_TARGETS) {
        gameOverRef.current = true;
        setGameOver(true);
        const p = playerNumRef.current, o = p === 1 ? 2 : 1;
        const s = { [p]: scoreRef.current, [o]: oppScoreRef.current };
        send(dc, { type: 'game-over', scores: s });
        setScores(s);
        if (socket) socket.emit('game-ended');
        if (onGameEndRef.current) onGameEndRef.current(s);
      }
      return;
    }

    // Real target — score!
    const newScore = scoreRef.current + 1;
    scoreRef.current = newScore;
    setMyScore(newScore);
    playCorrect();
    setFeedback('hit');
    setTimeout(() => setFeedback(null), 200);
    setTarget(null);
    send(dc, { type: 'claim', score: newScore });
    if (roundRef.current >= TOTAL_TARGETS) {
      gameOverRef.current = true;
      setGameOver(true);
      const p = playerNumRef.current, o = p === 1 ? 2 : 1;
      const s = { [p]: scoreRef.current, [o]: oppScoreRef.current };
      send(dc, { type: 'game-over', scores: s });
      setScores(s);
      if (socket) socket.emit('game-ended');
      if (onGameEndRef.current) onGameEndRef.current(s);
    }
  }, [target, gameOver, dc, socket]);

  const handleRestart = () => {
    send(dc, { type: 'restart' });
    if (onBackToLobbyRef.current) onBackToLobbyRef.current();
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.top}>
        <span style={styles.mode}>⚡ Reaction</span>
        <span style={{ ...styles.timer, color: timeLeft <= 10 ? '#ff6b6b' : '#eee' }}>
          {timeLeft}s
        </span>
        <span style={styles.scores}>You {myScore} – {oppScore} Opp</span>
      </div>

      <div style={{ ...styles.arena, transform: shake ? 'translateX(6px)' : 'none' }}>
        {!gameOver && target && (
          <button
            onClick={(e) => { e.stopPropagation(); handleHit(); }}
            style={{
              ...styles.target,
              left: `${target.x}%`,
              top: `${target.y}%`,
              background: target.isFake ? '#ff4444' : '#4ecca3',
              boxShadow: target.isFake ? '0 0 20px #ff444488' : '0 0 20px #4ecca388',
            }}
          >
            {target.isFake ? '👿' : '👆'}
          </button>
        )}
        {!target && !gameOver && (
          <div style={styles.wait}>Get ready...</div>
        )}
        {feedback && (
          <div style={{ ...styles.feedback, color: feedback === 'hit' ? '#4ecca3' : '#ff4444' }}>
            {feedback === 'hit' ? '+1' : feedback === 'fake' ? '-1 FAKE!' : 'MISS'}
          </div>
        )}
      </div>

      {gameOver && (
        <div style={styles.overlay}>
          <div style={styles.trophy}>
            {scores && (scores[playerNum] ?? 0) > (scores[playerNum === 1 ? 2 : 1] ?? 0) ? '🏆' : '🤖'}
          </div>
          <div style={{ fontSize: '1.2rem', color: '#888' }}>
            {scores ? `${scores[playerNum] ?? 0} – ${scores[playerNum === 1 ? 2 : 1] ?? 0}` : 'Done'}
          </div>
          <button onClick={handleRestart} style={{ padding: '10px 28px' }}>Play Again</button>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '12px', userSelect: 'none' },
  top: { display: 'flex', alignItems: 'center', gap: '24px' },
  mode: { color: '#e94560', fontWeight: 700 },
  timer: { fontSize: '2rem', fontWeight: 800 },
  scores: { fontSize: '1rem', color: '#888' },
  arena: { flex: 1, width: '100%', maxWidth: '600px', position: 'relative', background: '#0f0f23', borderRadius: '12px', overflow: 'hidden', transition: 'transform 0.1s', minHeight: '400px' },
  target: { position: 'absolute', width: '70px', height: '70px', borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: '1.5rem', transform: 'translate(-50%, -50%)', animation: 'heartbeat 0.8s infinite', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  wait: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: '#555', fontSize: '1.5rem' },
  feedback: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', fontSize: '3rem', fontWeight: 900, zIndex: 5, pointerEvents: 'none' },
  overlay: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginTop: '20px' },
  trophy: { fontSize: '4rem' },
};
