import { useState, useCallback, useRef, useEffect } from 'react';

const GAME_MODES = [
  {
    id: 'classic',
    title: 'Classic',
    emoji: '🧮',
    description:
      'Side-by-side arithmetic. You each get your own problems. Most correct answers in 60 seconds wins.',
  },
  {
    id: 'duel',
    title: 'Duel',
    emoji: '⚔️',
    description:
      'Same problem appears for both players. First to answer correctly steals the point. Every problem is a direct race.',
  },
  {
    id: 'health',
    title: 'Health Bars',
    emoji: '❤️',
    description:
      'Both start at 100 HP. First to answer deals 10 damage to your opponent. Last one standing wins — or whoever has more HP at 60 seconds.',
  },
  {
    id: 'tennis',
    title: 'Tennis',
    emoji: '🎾',
    description:
      'Problems get harder with each correct answer. Rally back and forth until someone breaks. Longest rally wins.',
  },
  {
    id: 'memory', title: 'Memory Match', emoji: '🃏',
    description: 'Same card grid, race to find all 8 pairs. Finding a match briefly reveals a card on your opponent\'s board — use that intel wisely!',
  },
  {
    id: 'reaction', title: 'Reaction Duel', emoji: '⚡',
    description: 'Green circles appear — first to click scores. But red circles are FAKES that cost you a point. 20 targets, pure chaos.',
  },
  {
    id: 'angrybirds', title: 'Angry Birds', emoji: '🐦',
    description: 'Both fire cannonballs at a shared block tower. Drag to aim, release to fire. Destroy more blocks than your opponent to win!',
  },
  {
    id: 'color', title: 'Color Chaos', emoji: '🎨',
    description: 'A color WORD appears in a different INK color. Press the button matching the INK color — not the word. Your brain will hate you.',
  },
  {
    id: 'tapper', title: 'Speed Tapper', emoji: '👆',
    description: 'Mash the button as fast as you can! But bombs appear randomly — hitting one costs 3 points. Press Space or tap furiously.',
  },
];

const COOP_GAME_MODES = [
  {
    id: 'coop-memory',
    title: 'Memory',
    emoji: '🧠',
    description: 'Work together! Cards are revealed briefly, then you both find matching pairs. Difficulty increases each round.',
  },
];

export default function GameModeSelector({ onCreateGame, error }) {
  const [tab, setTab] = useState('vs'); // 'vs' | 'coop'
  const [selectedId, setSelectedId] = useState(null);
  const [panelClosing, setPanelClosing] = useState(false);

  const selectedIdRef = useRef(selectedId);
  const transitionTimerRef = useRef(null);

  // Keep the ref in sync with state
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Cleanup transition timer on unmount
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  const selectedMode = GAME_MODES.find((m) => m.id === selectedId);

  const handleSelect = useCallback((modeId) => {
    // Clear any pending transition to prevent overlapping timeouts
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
    }

    const currentId = selectedIdRef.current;

    if (currentId === modeId) {
      // Deselect — animate panel out first
      setPanelClosing(true);
      transitionTimerRef.current = setTimeout(() => {
        setSelectedId(null);
        setPanelClosing(false);
      }, 250);
    } else if (currentId && currentId !== modeId) {
      // Switching modes — quick transition
      setPanelClosing(true);
      transitionTimerRef.current = setTimeout(() => {
        setSelectedId(modeId);
        setPanelClosing(false);
      }, 150);
    } else {
      // First selection
      setSelectedId(modeId);
    }
  }, []); // No dependency on selectedId — reads from ref

  const handleCreate = useCallback(() => {
    if (selectedMode) {
      onCreateGame(selectedMode.id, false);
    }
  }, [selectedMode, onCreateGame]);

  const panelVisible = selectedId !== null && !panelClosing;

  const modes = tab === 'vs' ? GAME_MODES : COOP_GAME_MODES;

  return (
    <div style={styles.page}>
      <div style={styles.main}>
        <h1 style={styles.title}>Zetamac</h1>

        {error && <p style={styles.error}>{error}</p>}

        {/* Tab selector */}
        <div style={styles.tabs}>
          <button onClick={() => { setTab('vs'); setSelectedId(null); }}
            style={{ ...styles.tabBtn, background: tab === 'vs' ? '#e94560' : '#2a2a4a' }}>
            ⚔️ VS
          </button>
          <button onClick={() => { setTab('coop'); setSelectedId(null); }}
            style={{ ...styles.tabBtn, background: tab === 'coop' ? '#4ecca3' : '#2a2a4a' }}>
            🤝 Co-op
          </button>
        </div>

        <div style={styles.modeList}>
          {modes.map((mode) => (
            <button
              key={mode.id}
              onClick={() => handleSelect(mode.id)}
              style={{
                ...styles.modeCard,
                borderColor: selectedId === mode.id ? (tab === 'coop' ? '#4ecca3' : '#e94560') : '#2a2a4a',
                background: selectedId === mode.id ? '#1e1e3f' : '#16213e',
              }}
            >
              <span style={styles.modeEmoji}>{mode.emoji}</span>
              <div>
                <div style={styles.modeTitle}>{mode.title}</div>
                <div style={styles.modeDesc}>{mode.description}</div>
              </div>
            </button>
          ))}
        </div>
        {tab === 'coop' && (
          <p style={{ color: '#888', fontSize: '0.8rem', marginTop: '12px' }}>
            Co-op games can be played solo or with a friend. No bots.
          </p>
        )}
      </div>

      {/* Right: detail panel */}
      <div
        style={{
          ...styles.detailPanel,
          transform: panelVisible ? 'translateX(0)' : 'translateX(110%)',
          pointerEvents: panelVisible ? 'auto' : 'none',
        }}
      >
        {selectedMode && (
          <div style={styles.panelContent}>
            <button
              onClick={() => handleSelect(selectedMode.id)}
              style={styles.closeBtn}
              aria-label="Close"
            >
              ✕
            </button>
            <div style={styles.panelEmoji}>{selectedMode.emoji}</div>
            <h2 style={styles.panelTitle}>{selectedMode.title}</h2>
            <p style={styles.panelDesc}>{selectedMode.description}</p>
            <button onClick={() => onCreateGame(selectedMode.id, false)} style={styles.createBtn}>
              Play vs Player
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '8px' }}>
              <div style={{ color: '#888', fontSize: '0.85rem', textAlign: 'center' }}>— or play vs Bot —</div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                <button onClick={() => onCreateGame(selectedMode.id, true, 'easy')} style={{...styles.createBtn, background: '#4ecca3', fontSize: '0.95rem', padding: '10px 20px'}}>Easy Bot</button>
                <button onClick={() => onCreateGame(selectedMode.id, true, 'medium')} style={{...styles.createBtn, background: '#e9a820', fontSize: '0.95rem', padding: '10px 20px'}}>Medium Bot</button>
                <button onClick={() => onCreateGame(selectedMode.id, true, 'hard')} style={{...styles.createBtn, background: '#e94560', fontSize: '0.95rem', padding: '10px 20px'}}>Hard Bot</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    display: 'flex',
    minHeight: '100vh',
    overflow: 'hidden',
    position: 'relative',
  },
  main: {
    flex: 1,
    padding: '60px 40px',
    display: 'flex',
    flexDirection: 'column',
    maxWidth: '650px',
  },
  title: {
    fontSize: '2.8rem',
    fontWeight: 900,
    color: '#e94560',
    marginBottom: '4px',
  },
  tabs: { display: 'flex', gap: '8px', marginBottom: '20px' },
  tabBtn: { padding: '8px 20px', borderRadius: '6px', border: 'none', color: '#fff', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer', transition: 'background 0.15s' },
  error: {
    background: '#3d1117',
    color: '#ff6b6b',
    padding: '10px 20px',
    borderRadius: '6px',
    marginBottom: '16px',
  },
  modeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  modeCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '16px 20px',
    border: '2px solid #2a2a4a',
    borderRadius: '10px',
    background: '#16213e',
    color: '#eee',
    textAlign: 'left',
    fontSize: '1rem',
    transition: 'border-color 0.15s, background 0.15s',
    width: '100%',
  },
  modeEmoji: {
    fontSize: '2rem',
    flexShrink: 0,
  },
  modeTitle: {
    fontWeight: 700,
    fontSize: '1.1rem',
    marginBottom: '2px',
  },
  modeDesc: {
    fontSize: '0.85rem',
    color: '#999',
    lineHeight: 1.4,
  },
  detailPanel: {
    position: 'fixed',
    right: 0,
    top: 0,
    bottom: 0,
    width: '420px',
    background: '#0f0f23',
    borderLeft: '2px solid #2a2a4a',
    display: 'flex',
    flexDirection: 'column',
    transition: 'transform 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
    zIndex: 10,
    boxShadow: '-8px 0 30px rgba(0,0,0,0.5)',
  },
  panelContent: {
    padding: '50px 36px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    height: '100%',
    justifyContent: 'center',
    gap: '20px',
  },
  closeBtn: {
    position: 'absolute',
    top: '20px',
    right: '20px',
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: '1.4rem',
    padding: '4px 10px',
  },
  panelEmoji: {
    fontSize: '5rem',
  },
  panelTitle: {
    fontSize: '2rem',
    fontWeight: 800,
    color: '#e94560',
  },
  panelDesc: {
    fontSize: '1rem',
    color: '#aaa',
    lineHeight: 1.6,
    maxWidth: '300px',
  },
  createBtn: {
    fontSize: '1.2rem',
    padding: '14px 48px',
    marginTop: '16px',
  },
};

export { GAME_MODES };
