import { useState, useEffect, useRef } from 'react';

// ── Problem generation ────────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateProblems(count = 120) {
  const ops = ['+', '-', '×', '÷'];
  const problems = [];
  for (let i = 0; i < count; i++) {
    const op = ops[randInt(0, 3)];
    let a, b, answer;
    switch (op) {
      case '+': a = randInt(2, 100); b = randInt(2, 100); answer = a + b; break;
      case '-': a = randInt(2, 100); b = randInt(2, a); answer = a - b; break;
      case '×': a = randInt(2, 12); b = randInt(2, 100); answer = a * b; break;
      case '÷': b = randInt(2, 12); answer = randInt(2, 100); a = answer * b; break;
    }
    problems.push({ a, b, op, answer });
  }
  return problems;
}

function send(dc, msg) {
  if (dc && dc.readyState === 'open') {
    dc.send(JSON.stringify(msg));
  }
}

export default function Lobby({ dc, socket, gameId, playerNum, isHost, error, onGameStart }) {
  const [ready, setReady] = useState(false);
  const [opponentReady, setOpponentReady] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [copied, setCopied] = useState(false);

  const readyRef = useRef(false);
  const countdownRef = useRef(null);
  const gameDuration = 60;

  // When data channel opens, send initial ready state so opponent knows we're here
  useEffect(() => {
    if (!dc) return;
    send(dc, { type: 'ready-change', ready: false });
  }, [dc]);

  // ── SINGLE message handler: both host and joiner use the same logic ──
  useEffect(() => {
    if (!dc) return;

    function handleMessage(e) {
      const msg = JSON.parse(e.data);

      switch (msg.type) {
        case 'ready-change':
          // Opponent toggled their ready state
          setOpponentReady(msg.ready);
          // If host and both ready, start countdown
          if (isHost && readyRef.current && msg.ready) {
            startCountdown();
          }
          break;

        case 'countdown':
          setCountdown(msg.num);
          break;

        case 'game-start':
          setCountdown(null);
          onGameStart(msg);
          break;

        case 'restart':
          setReady(false);
          readyRef.current = false;
          setOpponentReady(false);
          setCountdown(null);
          break;

        case 'back-to-lobby':
          setReady(false);
          readyRef.current = false;
          setOpponentReady(false);
          setCountdown(null);
          break;
      }
    }

    dc.addEventListener('message', handleMessage);
    return () => dc.removeEventListener('message', handleMessage);
  }, [dc, isHost, onGameStart]);

  // ── Socket: opponent-left ───────────────────────────────────────────
  useEffect(() => {
    socket.on('opponent-left', () => {
      // opponent-connected state is implicit: dc is open = connected
    });
    return () => socket.off('opponent-left');
  }, [socket]);

  // ── User actions ────────────────────────────────────────────────────
  const handleReady = () => {
    const newReady = !ready;
    setReady(newReady);
    readyRef.current = newReady;
    send(dc, { type: 'ready-change', ready: newReady });
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Countdown (host only) ───────────────────────────────────────────
  function startCountdown() {
    let count = 3;
    send(dc, { type: 'countdown', num: count });
    setCountdown(count);

    countdownRef.current = setInterval(() => {
      count--;
      send(dc, { type: 'countdown', num: count });
      setCountdown(count);

      if (count <= 0) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
        const problems = generateProblems(120);
        const startTime = Date.now();
        const data = { type: 'game-start', problems, startTime, duration: gameDuration };
        send(dc, data);
        setCountdown(null);
        onGameStart(data);
      }
    }, 1000);
  }

  const opponentNum = playerNum === 1 ? 2 : 1;
  // Connected state is implicit: if dc exists, opponent is connected via WebRTC
  const opponentConnected = !!dc;

  if (countdown !== null) {
    return (
      <div style={styles.overlay}>
        <div style={styles.countdownNum}>{countdown > 0 ? countdown : 'GO!'}</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Game Lobby</h1>

      <div style={styles.linkBox}>
        <span style={styles.linkLabel}>Share this link:</span>
        <code style={styles.link}>{window.location.href}</code>
        <button onClick={handleCopy} style={styles.copyBtn}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <div style={styles.players}>
        <div style={{ ...styles.playerCard, borderColor: playerNum === 1 ? '#e94560' : '#333' }}>
          <div style={styles.playerLabel}>You (Player {playerNum}){isHost ? ' • Host' : ''}</div>
          <div style={{ color: '#4ecca3' }}>Connected</div>
          <div style={{ color: ready ? '#4ecca3' : '#888' }}>
            {ready ? '✓ Ready' : 'Not Ready'}
          </div>
        </div>

        <div style={{ ...styles.playerCard, borderColor: playerNum !== 1 ? '#e94560' : '#333' }}>
          <div style={styles.playerLabel}>Opponent (Player {opponentNum}){!isHost ? ' • Host' : ''}</div>
          <div style={{ color: opponentConnected ? '#4ecca3' : '#888' }}>
            {opponentConnected ? 'Connected' : 'Waiting to join...'}
          </div>
          <div style={{ color: opponentReady ? '#4ecca3' : '#888' }}>
            {opponentReady ? '✓ Ready' : 'Not Ready'}
          </div>
        </div>
      </div>

      <button onClick={handleReady} style={ready ? styles.unreadyBtn : styles.readyBtn}>
        {ready ? 'Unready' : 'Ready'}
      </button>

      {!opponentConnected && (
        <p style={styles.waiting}>Waiting for opponent to join...</p>
      )}
      {error && <p style={{ color: '#ff6b6b' }}>{error}</p>}
    </div>
  );
}

const styles = {
  container: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', minHeight: '100vh', gap: '20px', padding: '20px',
  },
  title: { fontSize: '2rem', fontWeight: 800, color: '#e94560' },
  linkBox: {
    display: 'flex', alignItems: 'center', gap: '12px', background: '#16213e',
    padding: '12px 20px', borderRadius: '8px', flexWrap: 'wrap', justifyContent: 'center',
  },
  linkLabel: { color: '#888', fontSize: '0.9rem' },
  link: { color: '#4ecca3', fontSize: '1.1rem', fontFamily: 'monospace', background: '#0f3460', padding: '4px 12px', borderRadius: '4px' },
  copyBtn: { fontSize: '0.85rem', padding: '6px 16px' },
  players: { display: 'flex', gap: '24px', flexWrap: 'wrap' },
  playerCard: {
    background: '#16213e', border: '2px solid #333', borderRadius: '8px',
    padding: '16px 24px', minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '6px',
  },
  playerLabel: { fontWeight: 700, fontSize: '1rem', marginBottom: '4px' },
  readyBtn: { background: '#4ecca3', color: '#1a1a2e', fontSize: '1.2rem', padding: '12px 36px' },
  unreadyBtn: { background: '#555', color: '#fff', fontSize: '1.2rem', padding: '12px 36px' },
  waiting: { color: '#888', marginTop: '8px' },
  overlay: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' },
  countdownNum: { fontSize: '8rem', fontWeight: 900, color: '#e94560' },
};
