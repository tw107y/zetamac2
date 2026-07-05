import { useState, useEffect, useRef, useCallback } from 'react';
import { playCorrect, playWin, playLose } from '../sounds';

const W = 700, H = 500;
const GRAVITY = 0.4;
const BLOCK_W = 55, BLOCK_H = 22;
const TOWER_ROWS = 7;
const COOLDOWN = 2000;
const DURATION = 60;

function send(dc, msg) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg)); }

function createTower() {
  const blocks = [];
  const startX = W / 2 - (TOWER_ROWS * BLOCK_W) / 2;
  const baseY = H - 60;
  let id = 0;

  for (let row = 0; row < TOWER_ROWS; row++) {
    const cols = TOWER_ROWS - row;
    const offsetX = (row * BLOCK_W) / 2;
    for (let col = 0; col < cols; col++) {
      blocks.push({
        id: id++,
        x: startX + offsetX + col * BLOCK_W,
        y: baseY - row * BLOCK_H,
        w: BLOCK_W, h: BLOCK_H,
        hp: row < 2 ? 3 : row < 4 ? 2 : 1,
        maxHp: row < 2 ? 3 : row < 4 ? 2 : 1,
        alive: true,
      });
    }
  }
  return blocks;
}

function createDebris(x, y, count) {
  const p = [];
  for (let i = 0; i < count; i++) {
    p.push({
      x, y, vx: (Math.random() - 0.5) * 8, vy: -Math.random() * 12 - 2,
      life: 40 + Math.random() * 30, color: ['#e94560','#ffd700','#4ecca3','#ff6b6b'][Math.floor(Math.random()*4)],
    });
  }
  return p;
}

export default function AngryBirdsGame({
  dc, startTime, playerNum, isHost, socket, onBackToLobby, onGameEnd,
}) {
  const canvasRef = useRef(null);
  const [timeLeft, setTimeLeft] = useState(DURATION);
  const [gameOver, setGameOver] = useState(false);
  const [scores, setScores] = useState(null);
  const [myScore, setMyScore] = useState(0);
  const [oppScore, setOppScore] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [aiming, setAiming] = useState(null);

  const blocksRef = useRef(createTower());
  const projectilesRef = useRef([]);
  const debrisRef = useRef([]);
  const gameOverRef = useRef(false);
  const gracePeriodRef = useRef(false);
  const graceTimeoutRef = useRef(null);
  const scoreRef = useRef(0);
  const oppScoreRef = useRef(0);
  const animRef = useRef(null);
  const playerNumRef = useRef(playerNum);
  const onGameEndRef = useRef(onGameEnd);
  const onBackToLobbyRef = useRef(onBackToLobby);

  useEffect(() => { playerNumRef.current = playerNum; }, [playerNum]);
  useEffect(() => { onGameEndRef.current = onGameEnd; }, [onGameEnd]);
  useEffect(() => { onBackToLobbyRef.current = onBackToLobby; }, [onBackToLobby]);

  // Timer — only host triggers game-over; joiner just displays the countdown
  useEffect(() => {
    const tick = () => {
      const remaining = Math.max(0, Math.ceil(DURATION - (Date.now() - startTime) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0 && !gracePeriodRef.current && !gameOverRef.current) {
        if (!isHost) return; // Only host triggers game-over
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
    return () => { clearInterval(i); if (graceTimeoutRef.current) clearTimeout(graceTimeoutRef.current); };
  }, [startTime, dc, isHost, socket]);

  // DC messages
  useEffect(() => {
    function handle(e) {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'launch':
          projectilesRef.current.push({
            x: msg.fromLeft ? 30 : W - 30, y: H - 80,
            vx: msg.vx, vy: msg.vy, player: msg.playerNum, r: 8,
          });
          break;
        case 'player-update':
          oppScoreRef.current = msg.score ?? oppScoreRef.current;
          setOppScore(oppScoreRef.current);
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
      }
    }
    dc.addEventListener('message', handle);
    return () => dc.removeEventListener('message', handle);
  }, [dc]);

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown(c => Math.max(0, c - 50)), 50);
    return () => clearInterval(t);
  }, [cooldown > 0]);

  // Game loop
  useEffect(() => {
    function loop() {
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;

      // Physics update
      const blocks = blocksRef.current;
      const projectiles = projectilesRef.current;
      const debris = debrisRef.current;

      for (const p of projectiles) {
        p.vy += GRAVITY;
        p.x += p.vx;
        p.y += p.vy;

        // Check block collisions
        for (const b of blocks) {
          if (!b.alive) continue;
          if (p.x + p.r > b.x && p.x - p.r < b.x + b.w &&
              p.y + p.r > b.y && p.y - p.r < b.y + b.h) {
            b.hp--;
            if (b.hp <= 0) {
              b.alive = false;
              const newDebris = createDebris(b.x + b.w/2, b.y + b.h/2, 8);
              debris.push(...newDebris);
              if (p.player === playerNum) {
                scoreRef.current++;
                setMyScore(scoreRef.current);
                playCorrect();
              } else {
                oppScoreRef.current++;
                setOppScore(oppScoreRef.current);
              }
              send(dc, { type: 'player-update', score: scoreRef.current });
            }
            p.alive = false;
            break;
          }
        }

        // Out of bounds
        if (p.y > H + 50 || p.x < -50 || p.x > W + 50) p.alive = false;
      }

      // Update debris
      for (const d of debris) {
        d.vy += GRAVITY * 0.6;
        d.x += d.vx;
        d.y += d.vy;
        d.life--;
      }

      // Cleanup
      projectilesRef.current = projectiles.filter(p => p.alive !== false);
      debrisRef.current = debris.filter(d => d.life > 0);

      // Render
      ctx.clearRect(0, 0, W, H);

      // Sky gradient
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#1a1a3e'); grad.addColorStop(1, '#0f0f2e');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      // Ground
      ctx.fillStyle = '#2a2a1a'; ctx.fillRect(0, H - 30, W, 30);
      ctx.fillStyle = '#3a3a2a'; ctx.fillRect(0, H - 30, W, 4);

      // Blocks
      for (const b of blocks) {
        if (!b.alive) continue;
        const health = b.hp / b.maxHp;
        const r = Math.floor(180 - health * 100);
        const g = Math.floor(60 + health * 140);
        const bl = Math.floor(30);
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
        ctx.strokeStyle = '#00000044';
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        // Face
        ctx.fillStyle = '#00000066';
        ctx.fillRect(b.x + b.w/2 - 6, b.y + 4, 4, 4);
        ctx.fillRect(b.x + b.w/2 + 2, b.y + 4, 4, 4);
        if (health < 0.5) {
          ctx.fillRect(b.x + b.w/2 - 6, b.y + b.h/2, 12, 3);
        }
      }

      // Projectiles
      for (const p of projectiles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.player === playerNum ? '#ffd700' : '#e94560';
        ctx.fill();
        ctx.strokeStyle = '#00000044';
        ctx.stroke();
      }

      // Debris
      for (const d of debris) {
        ctx.globalAlpha = d.life / 70;
        ctx.fillStyle = d.color;
        ctx.fillRect(d.x, d.y, 4, 4);
      }
      ctx.globalAlpha = 1;

      // Cannons
      const myX = 20, oppX = W - 20, cannonY = H - 50;
      ctx.fillStyle = playerNum === 1 ? '#ffd700' : '#e94560';
      ctx.fillRect(myX - 8, cannonY - 15, 16, 30);
      ctx.fillStyle = playerNum === 1 ? '#e94560' : '#ffd700';
      ctx.fillRect(oppX - 8, cannonY - 15, 16, 30);

      // Aim line
      if (aiming && !gameOver) {
        ctx.beginPath();
        ctx.moveTo(aiming.sx, aiming.sy);
        const dx = aiming.sx - aiming.mx, dy = aiming.sy - aiming.my;
        for (let t = 0; t < 40; t += 2) {
          const px = aiming.sx - dx * t * 0.04 + 0.5 * 0 * t * t;
          const py = aiming.sy - dy * t * 0.04 + 0.5 * 0.4 * t * t;
          ctx.lineTo(px, py);
        }
        ctx.strokeStyle = '#ffffff33';
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (!gameOver) animRef.current = requestAnimationFrame(loop);
    }

    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, [aiming, gameOver, playerNum, dc]);

  // Mouse handlers
  const handleMouseDown = useCallback((e) => {
    if (gameOver || cooldown > 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = playerNum === 1 ? 30 : W - 30;
    const sy = H - 65;
    setAiming({ sx, sy, mx: e.clientX - rect.left, my: e.clientY - rect.top });
  }, [gameOver, cooldown, playerNum]);

  const handleMouseUp = useCallback((e) => {
    if (!aiming || gameOver) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const dx = mx - aiming.sx;
    const dy = my - aiming.sy;
    const power = Math.min(Math.sqrt(dx * dx + dy * dy) * 0.12, 15);
    const angle = Math.atan2(dy * 0.12, dx * 0.12);

    const vx = Math.cos(angle) * power;
    const vy = Math.sin(angle) * power;

    // Launch projectile
    projectilesRef.current.push({
      x: aiming.sx, y: aiming.sy, vx, vy, player: playerNum, r: 8, alive: true,
    });

    // Send to opponent (mirrored)
    send(dc, {
      type: 'launch',
      fromLeft: playerNum === 1,
      vx,
      vy,
      playerNum,
    });

    setAiming(null);
    setCooldown(COOLDOWN);
  }, [aiming, gameOver, playerNum, dc]);

  const canvasHeight = Math.min(500, typeof window !== 'undefined' ? window.innerHeight - 200 : 500);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <span style={{ color: '#e94560', fontWeight: 700 }}>🐦 Angry Birds</span>
        <span style={{ fontSize: '1.5rem', fontWeight: 800, color: timeLeft <= 10 ? '#ff6b6b' : '#eee' }}>{timeLeft}s</span>
        <span style={{ fontSize: '0.9rem', color: '#888' }}>You {myScore} – {oppScore} Opp</span>
      </div>
      <canvas
        ref={canvasRef}
        width={W}
        height={canvasHeight}
        style={{ background: '#0a0a1e', borderRadius: '8px', cursor: cooldown > 0 ? 'default' : 'crosshair', maxWidth: '100%' }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      />
      <div style={{ color: cooldown > 0 ? '#e94560' : '#888', fontSize: '0.85rem' }}>
        {cooldown > 0 ? `Reloading... ${(cooldown / 1000).toFixed(1)}s` : 'Drag from your cannon to aim and fire'}
      </div>
      {gameOver && (
        <div style={{ textAlign: 'center', marginTop: '8px' }}>
          <div style={{ fontSize: '3rem' }}>
            {scores && (scores[playerNum] ?? 0) > (scores[playerNum === 1 ? 2 : 1] ?? 0) ? '🏆' : '🤖'}
          </div>
          <div style={{ color: '#888' }}>{scores ? `${scores[playerNum] ?? 0} – ${scores[playerNum === 1 ? 2 : 1] ?? 0}` : 'Done'}</div>
          <button onClick={() => { send(dc, { type: 'restart' }); onBackToLobby(); }}
            style={{ padding: '10px 28px', marginTop: '8px' }}>Play Again</button>
        </div>
      )}
    </div>
  );
}
