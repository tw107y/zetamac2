import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

function send(dc, msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  }
}

export default function Game({ dc, mode, problems, startTime, duration, playerNum, isHost, socket, onBackToLobby, onGameEnd }) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const [myProblemIndex, setMyProblemIndex] = useState(0);
  const [myInput, setMyInput] = useState('');
  const [myScore, setMyScore] = useState(0);
  const [myHp, setMyHp] = useState(100);
  const [opponentState, setOpponentState] = useState({ problemIndex: 0, input: '', score: 0, hp: 100 });
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [finalHp, setFinalHp] = useState(null);
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
  // Stats tracking
  const totalAnsweredRef = useRef(0);
  const correctRef = useRef(0);
  const bestStreakRef = useRef(0);
  const fastestRef = useRef(Infinity);
  const problemStartTimeRef = useRef(Date.now());
  const graceTimeoutRef = useRef(null);
  const playerNumRef = useRef(playerNum);
  const onGameEndRef = useRef(onGameEnd);
  const onBackToLobbyRef = useRef(onBackToLobby);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);
  useEffect(() => { onBackToLobbyRef.current = onBackToLobby; }, [onBackToLobby]);

  const isHealth = mode === 'health';
  const isDuel = mode === 'duel';
  const isBlind = timeLeft <= 15 && timeLeft > 0;

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

        graceTimeoutRef.current = setTimeout(() => {
          const opponentNum = playerNumRef.current === 1 ? 2 : 1;
          const finalScores = { [playerNumRef.current]: scoreRef.current, [opponentNum]: oppScoreRef.current };
          const finalHpMsg = isHealth ? { [playerNumRef.current]: hpRef.current, [opponentNum]: oppHpRef.current } : undefined;
          send(dc, { type: 'game-over', scores: finalScores, hp: finalHpMsg });
          setScores(finalScores);
          if (finalHpMsg) setFinalHp(finalHpMsg);
          if (socket) socket.emit('game-ended');
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

  // ── Joiner timer ────────────────────────────────────────────────────
  useEffect(() => {
    if (isHost) return;

    const tick = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const remaining = Math.max(0, Math.ceil(duration - elapsed));
      setTimeLeft(remaining);

      if (remaining <= 0 && !gracePeriodRef.current) {
        gracePeriodRef.current = true;
        gameOverRef.current = true;
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

          // Health mode: track own HP from opponent's attack
          if (isHealth && msg.targetHp !== undefined) {
            hpRef.current = msg.targetHp;
            setMyHp(msg.targetHp);

            // Host detects defeat when own HP reaches 0
            if (isHost && msg.targetHp <= 0 && !gameOverRef.current) {
              gracePeriodRef.current = true;
              gameOverRef.current = true;
              setGameOver(true);
              const pNum = playerNumRef.current;
              const oNum = pNum === 1 ? 2 : 1;
              const finalHpMsg = { [pNum]: msg.targetHp, [oNum]: oppHpRef.current };
              send(dc, { type: 'game-over', scores: { [pNum]: scoreRef.current, [oNum]: oppScoreRef.current }, hp: finalHpMsg });
              setScores({ [pNum]: scoreRef.current, [oNum]: oppScoreRef.current });
              setFinalHp(finalHpMsg);
              if (socket) socket.emit('game-ended');
              if (onGameEndRef.current) onGameEndRef.current({ [pNum]: scoreRef.current, [oNum]: oppScoreRef.current });
            }

            // Non-host also shows game-over when own HP reaches 0
            if (msg.targetHp <= 0 && !isHost && !gameOverRef.current) {
              gameOverRef.current = true;
              setGameOver(true);
            }
          }
          break;

        case 'duel-claim':
          if (msg.problemIndex >= problemIndexRef.current) {
            problemIndexRef.current = msg.problemIndex + 1;
            setMyProblemIndex(msg.problemIndex + 1);
            setMyInput('');
            inputRef2.current = '';
            problemStartTimeRef.current = Date.now();
          }
          oppScoreRef.current = msg.score;
          setOpponentState(prev => ({ ...prev, problemIndex: msg.problemIndex + 1, score: msg.score }));
          break;

        case 'game-over':
          gameOverRef.current = true;
          setGameOver(true);
          setScores(msg.scores);
          if (msg.hp) setFinalHp(msg.hp);
          if (onGameEndRef.current) onGameEndRef.current(msg.scores);
          if (msg.scores) {
            const pNum = playerNumRef.current;
            const oNum = pNum === 1 ? 2 : 1;
            if (isHealth && msg.hp) {
              const won = (msg.hp[pNum] ?? 0) > (msg.hp[oNum] ?? 0);
              if (won) playWin(); else playLose();
            } else {
              const won = msg.scores[pNum] > msg.scores[oNum];
              if (won) playWin(); else playLose();
            }
          }
          break;

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
  }, [dc]);

  // ── Auto-focus ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!gameOver && inputRef.current) inputRef.current.focus();
  }, [myProblemIndex, gameOver]);

  // ── Emit player state (throttled, non-duel modes) ───────────────────
  const emitUpdate = useCallback((index, input, score, hp, targetHp) => {
    const now = Date.now();
    if (now - lastEmitRef.current < 100) return;
    lastEmitRef.current = now;
    send(dc, { type: 'player-update', problemIndex: index, input, score, hp, targetHp });
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
        const solveTime = now - problemStartTimeRef.current;

        // Stats
        totalAnsweredRef.current++;
        correctRef.current++;
        if (solveTime > 0 && solveTime < fastestRef.current) fastestRef.current = solveTime;

        const newStreak = timeSinceLast < 1500 && lastAnswerTime > 0 ? streak + 1 : 1;
        if (newStreak > bestStreakRef.current) bestStreakRef.current = newStreak;
        setStreak(newStreak);
        setLastAnswerTime(now);
        playCorrect();

        setMyScore(newScore);
        setMyProblemIndex(newIndex);
        setMyInput('');
        scoreRef.current = newScore;
        problemIndexRef.current = newIndex;
        inputRef2.current = '';
        problemStartTimeRef.current = now;

        if (isHealth) {
          // Deal 10 damage to opponent
          const newOppHp = Math.max(0, oppHpRef.current - 10);
          oppHpRef.current = newOppHp;
          setOpponentState(prev => ({ ...prev, hp: newOppHp }));
          // Check if opponent is defeated
          if (newOppHp <= 0 && !gameOverRef.current) {
            gracePeriodRef.current = true;
            gameOverRef.current = true;
            setGameOver(true);
            if (isHost) {
              const opponentNum = playerNum === 1 ? 2 : 1;
              const finalScores = { [playerNum]: newScore, [opponentNum]: oppScoreRef.current };
              const finalHpMsg = { [playerNum]: hpRef.current, [opponentNum]: newOppHp };
              send(dc, { type: 'game-over', scores: finalScores, hp: finalHpMsg });
              setScores(finalScores);
              setFinalHp(finalHpMsg);
              if (socket) socket.emit('game-ended');
              if (onGameEndRef.current) onGameEndRef.current(finalScores);
            } else {
              // Non-host: send player-update so host detects defeat
              emitUpdate(newIndex, '', newScore, hpRef.current, newOppHp);
            }
            return;
          }
        }

        if (isDuel) {
          send(dc, { type: 'duel-claim', problemIndex: myProblemIndex, score: newScore });
        } else {
          emitUpdate(newIndex, '', newScore, hpRef.current, isHealth ? oppHpRef.current : undefined);
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
        totalAnsweredRef.current++;
      }
      if (e.key === 'Escape') {
        setMyInput('');
        setStreak(0);
        totalAnsweredRef.current++;
      }
    }
  };

  const handleRestart = () => {
    send(dc, { type: 'restart' });
    onBackToLobby();
  };

  const handleContainerClick = () => {
    if (!gameOver && inputRef.current) inputRef.current.focus();
  };

  const opponentNum = playerNum === 1 ? 2 : 1;
  const myFinalScore = scores ? scores[playerNum] : myScore;
  const displayMyScore = isHealth && finalHp ? (finalHp[playerNum] ?? myFinalScore) : myFinalScore;
  const displayOppScore = isHealth && finalHp ? (finalHp[opponentNum] ?? (scores ? scores[opponentNum] : 0)) : (scores ? scores[opponentNum] : 0);

  // ── Render ──────────────────────────────────────────────────────────
  const modeLabel = isDuel ? '⚔️ Duel' : isHealth ? '❤️ Health' : '🧮 Classic';

  return (
    <div style={styles.wrapper} onClick={handleContainerClick}>
      <div style={styles.topBar}>
        <span style={styles.modeLabel}>{modeLabel}</span>
        <span style={{
          ...styles.timer,
          color: timeLeft <= 10 ? '#ff6b6b' : '#eee',
          animation: timeLeft <= 10 ? `heartbeat ${timeLeft <= 5 ? '0.4s' : '0.7s'} ease-in-out infinite` : 'none',
        }}>
          {timeLeft}s
        </span>
        {streak >= 3 && (
          <span style={styles.streakBadge}>{streak}× STREAK!</span>
        )}
      </div>

      {/* Progress bars */}
      <div style={styles.progressBars}>
        <div style={styles.progressRow}>
          <span style={styles.progressLabel}>You</span>
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${(myProblemIndex / problems.length) * 100}%` }} />
          </div>
          <span style={styles.progressNum}>{myProblemIndex}/{problems.length}</span>
        </div>
        {!isDuel && (
          <div style={styles.progressRow}>
            <span style={styles.progressLabel}>Opp</span>
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${(opponentState.problemIndex / problems.length) * 100}%`, background: '#e94560' }} />
            </div>
            <span style={styles.progressNum}>{opponentState.problemIndex}/{problems.length}</span>
          </div>
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
                    <div style={styles.trophy}>
                      {displayMyScore > displayOppScore ? '🏆' : '🎮'}
                    </div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 800, marginBottom: '4px' }}>
                      {displayMyScore > displayOppScore ? 'You Won!'
                        : displayMyScore < displayOppScore ? 'You Lost'
                        : "It's a Tie!"}
                    </div>
                    <div style={{ fontSize: '1rem', color: '#888', marginBottom: '12px' }}>
                      Player {playerNum} {displayMyScore}{isHealth ? ' HP' : ''} – {displayOppScore}{isHealth ? ' HP' : ''} Player {opponentNum}
                    </div>
                    <button onClick={() => setShowStats(!showStats)} style={styles.statsToggle}>
                      {showStats ? 'Hide Stats' : '📊 Stats'}
                    </button>
                    {showStats && (
                      <div style={styles.statsCard}>
                        <div style={styles.statRow}><span>Accuracy</span><span>{correctRef.current > 0 ? Math.round((correctRef.current / totalAnsweredRef.current) * 100) : 0}%</span></div>
                        <div style={styles.statRow}><span>Problems Solved</span><span>{myFinalScore}</span></div>
                        <div style={styles.statRow}><span>Best Streak</span><span>{bestStreakRef.current}×</span></div>
                        <div style={styles.statRow}><span>Fastest Answer</span><span>{fastestRef.current < Infinity ? (fastestRef.current / 1000).toFixed(2) + 's' : 'N/A'}</span></div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ color: '#ff6b6b' }}>Connection lost</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={styles.divider} />

        <div style={{
          ...styles.panel,
          opacity: isBlind ? 0.06 : 1,
          transition: 'opacity 0.5s ease',
          position: 'relative',
        }}>
          {isBlind && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b6b', fontSize: '1.5rem', fontWeight: 800, pointerEvents: 'none' }}>👁️‍🗨️</div>}
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
                  {opponentState.input || ' '}<span style={styles.ghostCursor}>|</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {gameOver && (
        <button onClick={handleRestart} style={styles.restartBtn}>Play Again</button>
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
  progressBars: { width: '100%', maxWidth: '600px', display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '4px' },
  progressRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  progressLabel: { fontSize: '0.75rem', color: '#666', width: '28px', textAlign: 'right' },
  progressTrack: { flex: 1, height: '6px', background: '#1a1a2e', borderRadius: '3px', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#4ecca3', borderRadius: '3px', transition: 'width 0.2s ease' },
  progressNum: { fontSize: '0.7rem', color: '#666', width: '48px', fontVariantNumeric: 'tabular-nums' },
  ghostCursor: { color: '#e94560', animation: 'blink 1s step-end infinite', fontWeight: 100 },
  trophy: { fontSize: '5rem', animation: 'heartbeat 0.6s ease-in-out 3' },
  statsToggle: { background: '#333', color: '#eee', fontSize: '0.85rem', padding: '6px 16px', marginBottom: '8px' },
  statsCard: { background: '#16213e', borderRadius: '8px', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '220px' },
  statRow: { display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', color: '#ccc', gap: '24px' },
};
