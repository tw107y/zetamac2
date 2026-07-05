import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

const BOMB_CHANCE = 0.2;

function send(dc, msg) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg)); }

export default function TapperGame({ dc, startTime, duration, playerNum, isHost, socket, onBackToLobby, onGameEnd }) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [myScore, setMyScore] = useState(0);
  const [oppScore, setOppScore] = useState(0);
  const [tapType, setTapType] = useState('normal');
  const [shake, setShake] = useState(false);
  const [stunned, setStunned] = useState(false);

  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false);
  const graceTimeoutRef = useRef(null);
  const scoreRef = useRef(0);
  const oppScoreRef = useRef(0);
  const playerNumRef = useRef(playerNum);
  const onGameEndRef = useRef(onGameEnd);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);

  // Host timer
  useEffect(() => {
    if (!isHost) return;
    const tick = () => {
      const r = Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000));
      setTimeLeft(r);
      if (r <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true; gameOverRef.current = true; setGameOver(true);
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
  }, [isHost, startTime, duration, dc, socket]);

  // Joiner timer
  useEffect(() => {
    if (isHost) return;
    const tick = () => {
      const r = Math.max(0, Math.ceil(duration - (Date.now() - startTime) / 1000));
      setTimeLeft(r);
      if (r <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
      }
    };
    tick();
    const i = setInterval(tick, 100);
    return () => clearInterval(i);
  }, [isHost, startTime, duration]);

  // DC
  useEffect(() => {
    function handle(e) {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'player-update': oppScoreRef.current = msg.score ?? oppScoreRef.current; setOppScore(oppScoreRef.current); break;
        case 'tap': oppScoreRef.current = msg.score; setOppScore(msg.score); break;
        case 'game-over':
          gameOverRef.current = true; setGameOver(true); setScores(msg.scores);
          if (onGameEndRef.current) onGameEndRef.current(msg.scores);
          (msg.scores[playerNum] ?? 0) > (msg.scores[playerNum === 1 ? 2 : 1] ?? 0) ? playWin() : playLose();
          break;
        case 'restart': if (onBackToLobby) onBackToLobby(); break;
      }
    }
    dc.addEventListener('message', handle);
    return () => dc.removeEventListener('message', handle);
  }, [dc, playerNum, onBackToLobby]);

  // Spawn tap types (host)
  useEffect(() => {
    if (!isHost || gameOver) return;
    function spawn() {
      if (gameOverRef.current) return;
      const isBomb = Math.random() < BOMB_CHANCE;
      setTapType(isBomb ? 'bomb' : 'normal');
      send(dc, { type: 'tapType', tapType: isBomb ? 'bomb' : 'normal' });
    }
    const i = setInterval(spawn, 1200 + Math.random() * 1800);
    return () => clearInterval(i);
  }, [isHost, gameOver, dc]);

  // Receive tap types (joiner)
  useEffect(() => {
    if (isHost) return;
    function handle(e) {
      const msg = JSON.parse(e.data);
      if (msg.type === 'tapType') setTapType(msg.tapType);
    }
    dc.addEventListener('message', handle);
    return () => dc.removeEventListener('message', handle);
  }, [isHost, dc]);

  const handleTap = useCallback(() => {
    if (gameOver || gameOverRef.current || stunned) return;
    if (tapType === 'bomb') {
      const ns = Math.max(0, scoreRef.current - 3);
      scoreRef.current = ns; setMyScore(ns);
      setShake(true); setStunned(true);
      setTimeout(() => { setShake(false); setStunned(false); }, 500);
      send(dc, { type: 'tap', score: ns });
      return;
    }
    const ns = scoreRef.current + 1;
    scoreRef.current = ns; setMyScore(ns);
    playCorrect();
    send(dc, { type: 'tap', score: ns });
  }, [gameOver, stunned, tapType, dc]);

  // Keyboard: space to tap
  useEffect(() => {
    function key(e) { if (e.code === 'Space') { e.preventDefault(); handleTap(); } }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [handleTap]);

  const isBomb = tapType === 'bomb';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <span style={{ color: '#e94560', fontWeight: 700 }}>👆 Speed Tapper</span>
        <span style={{ fontSize: '2rem', fontWeight: 800, color: timeLeft <= 10 ? '#ff6b6b' : '#eee' }}>{timeLeft}s</span>
        <span style={{ color: '#888' }}>You {myScore} – {oppScore} Opp</span>
      </div>
      <p style={{ color: '#888', fontSize: '0.85rem' }}>Tap the button FAST — but DON'T tap bombs! (or press Space)</p>
      <button
        onClick={handleTap}
        disabled={gameOver || stunned}
        style={{
          width: '200px', height: '200px', borderRadius: '50%', border: '4px solid #fff3',
          background: isBomb ? '#ff4444' : '#4ecca3',
          fontSize: '2.5rem', cursor: gameOver ? 'default' : 'pointer',
          transform: shake ? 'translateX(8px)' : 'none',
          transition: 'transform 0.05s, background 0.15s',
          boxShadow: isBomb ? '0 0 30px #ff444488' : '0 0 30px #4ecca388',
        }}
      >
        {isBomb ? '💣' : '👆'}
      </button>
      {stunned && <div style={{ color: '#ff4444', fontWeight: 800, fontSize: '1.2rem' }}>BOMB! -3</div>}
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
