export default function MainMenu({ onCreateGame, error }) {
  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Zetamac Multiplayer</h1>
      <p style={styles.subtitle}>Mental arithmetic. Head to head.</p>

      {error && <p style={styles.error}>{error}</p>}

      <button onClick={onCreateGame} style={styles.btn}>
        Create Game
      </button>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    gap: '16px',
  },
  title: {
    fontSize: '2.5rem',
    fontWeight: 800,
    color: '#e94560',
  },
  subtitle: {
    fontSize: '1.1rem',
    color: '#888',
    marginBottom: '24px',
  },
  btn: {
    fontSize: '1.2rem',
    padding: '14px 40px',
  },
  error: {
    background: '#3d1117',
    color: '#ff6b6b',
    padding: '10px 20px',
    borderRadius: '6px',
    marginBottom: '8px',
  },
};
