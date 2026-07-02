/**
 * Sound effects using Web Audio API. Zero dependencies, no audio files.
 */

let ctx = null;

function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return ctx;
}

// One-time AudioContext resume on first user interaction (bypasses autoplay policy)
function initAudioOnInteraction() {
  const handler = () => {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume();
    }
    document.removeEventListener('click', handler);
    document.removeEventListener('touchstart', handler);
    document.removeEventListener('keydown', handler);
  };
  document.addEventListener('click', handler);
  document.addEventListener('touchstart', handler);
  document.addEventListener('keydown', handler);
}
initAudioOnInteraction();

function playTone(freq, duration, type = 'sine', vol = 0.08) {
  try {
    const c = getCtx();
    // Resume context if suspended (e.g., after tab loses focus)
    if (c.state === 'suspended') {
      c.resume();
    }
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(c.currentTime);
    osc.stop(c.currentTime + duration);
  } catch (e) {
    // Audio not available — silently ignore
  }
}

export function playCorrect() {
  playTone(880, 0.08, 'sine', 0.06);
  setTimeout(() => playTone(1100, 0.06, 'sine', 0.04), 50);
}

export function playCountdown(num) {
  if (num > 0) {
    playTone(440, 0.12, 'square', 0.04);
  } else {
    playTone(880, 0.25, 'square', 0.06);
  }
}

export function playGameStart() {
  playTone(440, 0.1, 'sine', 0.05);
  setTimeout(() => playTone(660, 0.1, 'sine', 0.05), 100);
  setTimeout(() => playTone(880, 0.15, 'sine', 0.06), 200);
}

export function playWin() {
  playTone(660, 0.12, 'sine', 0.06);
  setTimeout(() => playTone(880, 0.12, 'sine', 0.06), 120);
  setTimeout(() => playTone(1100, 0.2, 'sine', 0.07), 240);
}

export function playLose() {
  playTone(330, 0.15, 'sine', 0.05);
  setTimeout(() => playTone(220, 0.2, 'sine', 0.05), 150);
}
