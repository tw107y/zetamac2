import { useState, useEffect, useRef, useCallback } from 'react';

function send(dc, msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  }
}

export default function Game({ dc, mode, problems, startTime, duration, playerNum, isHost, onBackToLobby }) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const [myProblemIndex, setMyProblemIndex] = useState(0);
  const [myInput, setMyInput] = useState('');
  const [myScore, setMyScore] = useState(0);
  const [myHp, setMyHp] = useState(100);
  const [opponentState, setOpponentState] = useState({ problemIndex: 0, input: '', score: 0, hp: 100 });
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [streak, setStreak] = useState(0);
  const [lastAnswerTime, setLastAnswerTime] = useState(0);

  const inputRef = useRef(null);
  const lastEmitRef = useRef(0);
  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false);
  const scoreRef = useRef(0);
  const hpRef = useRef(100);
  const problemIndexRef = useRef(0);
  const inputRef2 = useRef('');
  const oppScoreRef = useRef(0);
  const oppHpRef = useRef(100);

  const isHealth = mode === 'health';
  const isDuel = mode === 'duel';

  // ── Host timer (authoritative) ──────────────────────────────────────
  useEffect(() => {
    if (!isHost) return;

    const tick = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
      setTimeLeft(remaining);

      if (remaining <= 0 && !gracePeriodRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
        setGameOver(true);

        setTimeout(() => {
          const finalScores = { 1: scoreRef.current, 2: oppScoreRef.current };
          send(dc, { type: 'game-over', scores: finalScores, hp: { 1: hpRef.current, 2: oppHpRef.current } });
          setScores(finalScores);
        }, 500);
      }
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [isHost, startTime, duration, dc]);

  // ── Joiner timer ────────────────────────────────────────────────────
  useEffect(() => {
    if (isHost) return;

    const tick = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
      setTimeLeft(remaining);

      if (remaining <= 0 && !gracePeriodRef.current) {
        gracePeriodRef.current = true;
        lastEmitRef.current = 0;
        send(dc, { type: 'player-update', problemIndex: problemIndexRef.current, input: inputRef2.current, score: scoreRef.current, hp: hpRef.current });
      }
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [isHost, startTime, duration, dc]);

  // ── Data channel messages ───────────────────────────────────────────
  useEffect(() => {
    function handleMessage(e) {
      const msg = JSON.parse(e.data);

      switch (msg.type) {
        case 'player-update':
          setOpponentState({
            problemIndex: msg.problemIndex,
            input: msg.input || '',
            score: msg.score,
            hp: msg.hp ?? 100,
          });
          oppScoreRef.current = msg.score;
          oppHpRef.current = msg.hp ?? oppHpRef.current;
          break;

        case 'duel-claim':
          if (msg.problemIndex >= problemIndexRef.current) {
            problemIndexRef.current = msg.problemIndex + 1;
            setMyProblemIndex(msg.problemIndex + 1);
            setMyInput('');
            inputRef2.current = '';
          }
          oppScoreRef.current = msg.score;
          setOpponentState(prev => ({ ...prev, problemIndex: msg.problemIndex + 1, score: msg.score }));
          break;

        case 'game-over':
          gameOverRef.current = true;
          setGameOver(true);
          setScores(msg.scores);
          break;

        case 'restart':
          onBackToLobby();
          break;
      }
    }

    dc.addEventListener('message', handleMessage);
    return () => dc.removeEventListener('message', handleMessage);
  }, [dc]);

  // ── Auto-focus ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!gameOver && inputRef.current) inputRef.current.focus();
  }, [myProblemIndex, gameOver]);

  // ── Emit player state (throttled, non-duel modes) ───────────────────
  const emitUpdate = useCallback((index, input, score, hp) => {
    const now = Date.now();
    if (now - lastEmitRef.current < 100) return;
    lastEmitRef.current = now;
    send(dc, { type: 'player-update', problemIndex: index, input, score, hp });
  }, [dc]);

  const currentProblem = problems[myProblemIndex];

  const handleChange = (e) => {
    if (gameOver) return;
    const value = e.target.value;
    if (!/^-?\d*$/.test(value)) return;

    setMyInput(value);
    inputRef2.current = value;

    if (value !== '' && value !== '-') {
      const parsed = parseInt(value, 10);
      if (currentProblem && parsed === currentProblem.answer) {
        const newScore = myScore + 1;
        const newIndex = myProblemIndex + 1;
        const now = Date.now();
        const timeSinceLast = now - lastAnswerTime;
        const newStreak = timeSinceLast < 1500 && lastAnswerTime > 0 ? streak + 1 : 1;
        setStreak(newStreak);
        setLastAnswerTime(now);

        setMyScore(newScore);
        setMyProblemIndex(newIndex);
        setMyInput('');
        scoreRef.current = newScore;
        problemIndexRef.current = newIndex;
        inputRef2.current = '';

        if (isHealth) {
          // Deal 10 damage to opponent
          const newOppHp = Math.max(0, oppHpRef.current - 10);
          oppHpRef.current = newOppHp;
          setOpponentState(prev => ({ ...prev, hp: newOppHp }));
          // Check if opponent is defeated
          if (newOppHp <= 0 && isHost && !gameOverRef.current) {
            gracePeriodRef.current = true;
            gameOverRef.current = true;
            setGameOver(true);
            const finalScores = { 1: newScore, 2: oppScoreRef.current };
            send(dc, { type: 'game-over', scores: finalScores, hp: { 1: hpRef.current, 2: newOppHp } });
            setScores(finalScores);
            return;
          }
        }

        if (isDuel) {
          lastEmitRef.current = 0;
          send(dc, { type: 'duel-claim', problemIndex: myProblemIndex, score: newScore });
        } else {
          emitUpdate(newIndex, '', newScore, hpRef.current);
        }
        return;
      }
    }

    if (!isDuel) {
      emitUpdate(myProblemIndex, value, myScore, hpRef.current);
    }
  };

  const handleKeyDown = (e) => {
    if (gameOver) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      const parsed = parseInt(myInput, 10);
      if (e.key === 'Enter' && currentProblem && parsed !== currentProblem.answer) {
        setMyInput('');
        setStreak(0);
      }
      if (e.key === 'Escape') {
        setMyInput('');
        setStreak(0);
      }
    }
  };

  const handleRestart = () => {
    if (isHost) {
      send(dc, { type: 'restart' });
      onBackToLobby();
    }
  };

  const handleContainerClick = () => {
    if (!gameOver && inputRef.current) inputRef.current.focus();
  };

  const opponentNum = playerNum === 1 ? 2 : 1;
  const myFinalScore = scores ? scores[playerNum] : myScore;

  // ── Render ──────────────────────────────────────────────────────────
  const modeLabel = isDuel ? '⚔️ Duel' : isHealth ? '❤️ Health' : '🧮 Classic';

  return (
    <div style={styles.wrapper} onClick={handleContainerClick}>
      <div style={styles.topBar}>
        <span style={styles.modeLabel}>{modeLabel}</span>
        <span style={{ ...styles.timer, color: timeLeft <= 10 ? '#ff6b6b' : '#eee' }}>
          {timeLeft}s
        </span>
        {streak >= 3 && (
          <span style={styles.streakBadge}>{streak}× STREAK!</span>
        )}
      </div>

      {isHealth && (
        <div style={styles.hpBars}>
          <div style={styles.hpRow}>
            <span style={styles.hpLabel}>You</span>
            <div style={styles.hpTrack}><div style={{ ...styles.hpFill, width: `${myHp}%`, background: myHp > 30 ? '#4ecca3' : '#ff6b6b' }} /></div>
            <span style={styles.hpNum}>{myHp}</span>
          </div>
          <div style={styles.hpRow}>
            <span style={styles.hpLabel}>Opp</span>
            <div style={styles.hpTrack}><div style={{ ...styles.hpFill, width: `${opponentState.hp}%`, background: opponentState.hp > 30 ? '#4ecca3' : '#ff6b6b' }} /></div>
            <span style={styles.hpNum}>{opponentState.hp}</span>
          </div>
        </div>
      )}

      <div style={styles.panels}>
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            You <span style={styles.score}>{isHealth ? myHp : myScore}</span>
          </div>
          <div style={styles.panelBody}>
            {!gameOver && currentProblem && (
              <>
                <div style={styles.problem}>
                  {currentProblem.a} {currentProblem.op} {currentProblem.b} ={' '}
                  <span style={styles.blank}>___</span>
                </div>
                <input ref={inputRef} type="text" value={myInput}
                  onChange={handleChange} onKeyDown={handleKeyDown}
                  style={styles.input} autoComplete="off" autoFocus />
              </>
            )}
            {gameOver && (
              <div style={styles.gameOverText}>
                {scores ? (
                  <>
                    <div style={{ fontSize: '2rem', marginBottom: '8px' }}>
                      {myFinalScore > (scores[opponentNum] || 0) ? '🏆 You Won!'
                        : myFinalScore < (scores[opponentNum] || 0) ? 'You Lost'
                        : "🤝 It's a Tie!"}
                    </div>
                    <div style={{ fontSize: '1.2rem', color: '#888' }}>
                      {myFinalScore} – {scores[opponentNum]}
                    </div>
                  </>
                ) : (
                  <div style={{ color: '#ff6b6b' }}>Connection lost</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={styles.divider} />

        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            Opponent <span style={styles.score}>{isHealth ? opponentState.hp : opponentState.score}</span>
          </div>
          <div style={styles.panelBody}>
            {opponentState.problemIndex < problems.length && (
              <>
                <div style={styles.problem}>
                  {isDuel
                    ? `${currentProblem?.a} ${currentProblem?.op} ${currentProblem?.b} = ___`
                    : `${problems[opponentState.problemIndex]?.a} ${problems[opponentState.problemIndex]?.op} ${problems[opponentState.problemIndex]?.b} = ___`}
                </div>
                <div style={styles.opponentInput}>
                  {opponentState.input || ' '}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {gameOver && isHost && (
        <button onClick={handleRestart} style={styles.restartBtn}>Play Again</button>
      )}
      {gameOver && !isHost && (
        <p style={{ color: '#888', marginTop: '16px' }}>Waiting for host to restart...</p>
      )}
    </div>
  );
}

const styles = {
  wrapper: { display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '8px' },
  topBar: { display: 'flex', alignItems: 'center', gap: '20px', width: '100%', maxWidth: '900px', justifyContent: 'center' },
  modeLabel: { fontSize: '0.9rem', color: '#e94560', fontWeight: 700 },
  timer: { fontSize: '2rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' },
  streakBadge: { fontSize: '1rem', fontWeight: 800, color: '#ffd700', background: '#2a2a1a', padding: '4px 12px', borderRadius: '20px', animation: 'none' },
  hpBars: { width: '100%', maxWidth: '600px', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' },
  hpRow: { display: 'flex', alignItems: 'center', gap: '10px' },
  hpLabel: { fontSize: '0.85rem', color: '#888', width: '36px', textAlign: 'right' },
  hpTrack: { flex: 1, height: '16px', background: '#1a1a2e', borderRadius: '8px', overflow: 'hidden' },
  hpFill: { height: '100%', borderRadius: '8px', transition: 'width 0.3s ease, background 0.3s ease' },
  hpNum: { fontSize: '0.9rem', fontWeight: 700, color: '#eee', width: '36px' },
  panels: { display: 'flex', gap: '0', flex: 1, width: '100%', maxWidth: '900px' },
  panel: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px' },
  panelHeader: { fontSize: '1.1rem', fontWeight: 700, marginBottom: '20px', display: 'flex', gap: '12px', alignItems: 'center' },
  score: { color: '#4ecca3', fontSize: '1.5rem', fontWeight: 800 },
  panelBody: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', flex: 1, justifyContent: 'center' },
  problem: { fontSize: '2rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  blank: { color: '#888' },
  input: { fontSize: '1.8rem', width: '180px', padding: '8px 16px' },
  opponentInput: { fontSize: '1.8rem', color: '#555', background: '#16213e', border: '2px solid #333', borderRadius: '6px', width: '180px', padding: '8px 16px', textAlign: 'center', minHeight: '54px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  divider: { width: '2px', background: '#333', alignSelf: 'stretch' },
  gameOverText: { textAlign: 'center', fontSize: '1.2rem' },
  restartBtn: { marginTop: '16px', fontSize: '1.1rem', padding: '12px 36px' },
};
