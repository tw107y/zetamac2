import { useState, useEffect, useRef, useCallback } from 'react';

function send(dc, msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  }
}

export default function Game({ dc, problems, startTime, duration, playerNum, isHost, onBackToLobby }) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const [myProblemIndex, setMyProblemIndex] = useState(0);
  const [myInput, setMyInput] = useState('');
  const [myScore, setMyScore] = useState(0);
  const [opponentState, setOpponentState] = useState({ problemIndex: 0, input: '', score: 0 });
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);

  const inputRef = useRef(null);
  const lastEmitRef = useRef(0);
  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false); // true after timer hits 0, before final scores
  // Refs for timer callback
  const scoreRef = useRef(0);
  const problemIndexRef = useRef(0);
  const inputRef2 = useRef('');
  // Store opponent's score for host to report
  const oppScoreRef = useRef(0);

  // ── Host timer (authoritative) ──────────────────────────────────────
  useEffect(() => {
    if (!isHost) return;

    const tick = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
      setTimeLeft(remaining);

      if (remaining <= 0 && !gracePeriodRef.current) {
        // Timer hit 0 — enter 500ms grace period to collect final scores
        gracePeriodRef.current = true;
        // Block local input now (game is effectively over)
        gameOverRef.current = true;
        setGameOver(true);

        setTimeout(() => {
          const myScoreFinal = scoreRef.current;
          const oppScoreFinal = oppScoreRef.current;
          const finalScores = { 1: myScoreFinal, 2: oppScoreFinal };
          send(dc, { type: 'game-over', scores: finalScores });
          setScores(finalScores);
        }, 500);
      }
    };

    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [isHost, startTime, duration, dc]);

  // ── Joiner timer (display + force-emit final score) ─────────────────
  useEffect(() => {
    if (isHost) return;

    const tick = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
      setTimeLeft(remaining);

      if (remaining <= 0 && !gracePeriodRef.current) {
        gracePeriodRef.current = true;
        // Force-emit final score to host (bypass throttle)
        lastEmitRef.current = 0;
        send(dc, {
          type: 'player-update',
          problemIndex: problemIndexRef.current,
          input: inputRef2.current,
          score: scoreRef.current,
        });
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
          // Opponent's state update
          setOpponentState({
            problemIndex: msg.problemIndex,
            input: msg.input,
            score: msg.score,
          });
          oppScoreRef.current = msg.score;
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
    if (!gameOver && inputRef.current) {
      inputRef.current.focus();
    }
  }, [myProblemIndex, gameOver]);

  // ── Emit player state (throttled) ───────────────────────────────────
  const emitUpdate = useCallback(
    (index, input, score) => {
      const now = Date.now();
      if (now - lastEmitRef.current < 100) return;
      lastEmitRef.current = now;
      send(dc, { type: 'player-update', problemIndex: index, input, score });
    },
    [dc]
  );

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
        setMyScore(newScore);
        setMyProblemIndex(newIndex);
        setMyInput('');
        scoreRef.current = newScore;
        problemIndexRef.current = newIndex;
        inputRef2.current = '';
        emitUpdate(newIndex, '', newScore);
        return;
      }
    }

    scoreRef.current = myScore;
    problemIndexRef.current = myProblemIndex;
    emitUpdate(myProblemIndex, value, myScore);
  };

  const handleKeyDown = (e) => {
    if (gameOver) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      const parsed = parseInt(myInput, 10);
      if (e.key === 'Enter' && currentProblem && parsed !== currentProblem.answer) {
        setMyInput('');
      }
      if (e.key === 'Escape') {
        setMyInput('');
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
  const oppFinalScore = scores ? scores[opponentNum] : opponentState.score;

  return (
    <div style={styles.wrapper} onClick={handleContainerClick}>
      <div style={styles.timer}>
        <span style={{ color: timeLeft <= 10 ? '#ff6b6b' : '#eee' }}>
          {timeLeft}s
        </span>
      </div>

      <div style={styles.panels}>
        {/* My Panel */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            You {isHost ? '(Host)' : ''} <span style={styles.score}>{myScore}</span>
          </div>
          <div style={styles.panelBody}>
            {!gameOver && currentProblem && (
              <>
                <div style={styles.problem}>
                  {currentProblem.a} {currentProblem.op} {currentProblem.b} ={' '}
                  <span style={styles.blank}>___</span>
                </div>
                <input
                  ref={inputRef}
                  type="text"
                  value={myInput}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                  style={styles.input}
                  autoComplete="off"
                  autoFocus
                />
              </>
            )}
            {gameOver && (
              <div style={styles.gameOverText}>
                {scores ? (
                  <>
                    <div style={{ fontSize: '2rem', marginBottom: '8px' }}>
                      {myFinalScore > oppFinalScore ? '🏆 You Won!' : myFinalScore < oppFinalScore ? 'You Lost' : "🤝 It's a Tie!"}
                    </div>
                    <div style={{ fontSize: '1.2rem', color: '#888' }}>
                      {myFinalScore} – {oppFinalScore}
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

        {/* Opponent Panel */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            Opponent <span style={styles.score}>{opponentState.score}</span>
          </div>
          <div style={styles.panelBody}>
            {opponentState.problemIndex < problems.length && (
              <>
                <div style={styles.problem}>
                  {problems[opponentState.problemIndex].a}{' '}
                  {problems[opponentState.problemIndex].op}{' '}
                  {problems[opponentState.problemIndex].b} ={' '}
                  <span style={styles.blank}>___</span>
                </div>
                <div style={styles.opponentInput}>
                  {opponentState.input || ' '}
                </div>
              </>
            )}
            {opponentState.problemIndex >= problems.length && (
              <div style={{ color: '#888' }}>Finished all problems!</div>
            )}
          </div>
        </div>
      </div>

      {gameOver && isHost && (
        <button onClick={handleRestart} style={styles.restartBtn}>
          Play Again
        </button>
      )}
      {gameOver && !isHost && (
        <p style={{ color: '#888', marginTop: '16px' }}>
          Waiting for host to restart...
        </p>
      )}
    </div>
  );
}

const styles = {
  wrapper: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    minHeight: '100vh', padding: '20px', gap: '12px',
  },
  timer: { fontSize: '2rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' },
  panels: { display: 'flex', gap: '0', flex: 1, width: '100%', maxWidth: '900px' },
  panel: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px' },
  panelHeader: { fontSize: '1.1rem', fontWeight: 700, marginBottom: '20px', display: 'flex', gap: '12px', alignItems: 'center' },
  score: { color: '#4ecca3', fontSize: '1.5rem', fontWeight: 800 },
  panelBody: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', flex: 1, justifyContent: 'center' },
  problem: { fontSize: '2rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  blank: { color: '#888' },
  input: { fontSize: '1.8rem', width: '180px', padding: '8px 16px' },
  opponentInput: {
    fontSize: '1.8rem', color: '#555', background: '#16213e', border: '2px solid #333',
    borderRadius: '6px', width: '180px', padding: '8px 16px', textAlign: 'center',
    minHeight: '54px', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  divider: { width: '2px', background: '#333', alignSelf: 'stretch' },
  gameOverText: { textAlign: 'center', fontSize: '1.2rem' },
  restartBtn: { marginTop: '16px', fontSize: '1.1rem', padding: '12px 36px' },
};
