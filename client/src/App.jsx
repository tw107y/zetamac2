import { useState, useEffect, useCallback, useRef } from 'react';
import socket from './socket';
import { hostConnect, joinerConnect } from './webrtc';
import { createBotDC } from './bot';
import GameModeSelector from './components/GameModeSelector';
import Lobby from './components/Lobby';
import Game from './components/Game';
import MinesweeperGame from './components/MinesweeperGame';
import MemoryGame from './components/MemoryGame';
import ReactionGame from './components/ReactionGame';
import AngryBirdsGame from './components/AngryBirdsGame';
import ColorGame from './components/ColorGame';
import TapperGame from './components/TapperGame';
import CoopMemoryGame from './components/CoopMemoryGame';

export default function App() {
  const [screen, setScreen] = useState('menu');
  const [gameId, setGameId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [playerNum, setPlayerNum] = useState(null);
  const [gameMode, setGameMode] = useState('classic');
  const [gameData, setGameData] = useState(null);
  const [error, setError] = useState(null);
  const [dc, setDc] = useState(null);
  const [hostLeft, setHostLeft] = useState(false);
  const [lastWinner, setLastWinner] = useState(null); // { playerNum, streak }
  const [vsBot, setVsBot] = useState(false);
  const [botDifficulty, setBotDifficulty] = useState('medium');
  const dcRef = useRef(null);
  const pcRef = useRef(null);
  const isHostRef = useRef(false);

  useEffect(() => {
    socket.connect();
    return () => { socket.disconnect(); };
  }, []);

  // Auto-join if URL has gameId
  useEffect(() => {
    const path = window.location.pathname;
    if (path !== '/' && path.length > 1) {
      const id = path.slice(1);
      setGameId(id);
      socket.emit('join-game', { gameId: id });
    }
  }, []);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      if (path === '/' || path.length <= 1) {
        setScreen('menu');
        setGameData(null);
        setGameId(null);
        setDc(null);
        if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
        if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
      } else {
        setGameId(path.slice(1));
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Persistent peer-joined listener (registered once — never leaks)
  useEffect(() => {
    socket.on('peer-joined', async () => {
      if (!isHostRef.current) return;
      try {
        // Close any previous connections before creating new ones
        if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
        if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
        const { pc, dc: dataChannel } = await hostConnect(socket);
        pcRef.current = pc;
        dcRef.current = dataChannel;
        setDc(dataChannel);
      } catch (err) {
        setError(err.message);
      }
    });
    return () => { socket.off('peer-joined'); };
  }, []);

  // Socket event listeners (signaling only)
  useEffect(() => {
    socket.on('game-created', ({ gameId: id, mode }) => {
      setGameId(id);
      setGameMode(mode || 'classic');
      window.history.pushState({}, '', `/${id}`);
    });

    socket.on('joined', async ({ playerNum: pn, gameId: id, isHost: host, mode }) => {
      console.log(`[App] joined as player ${pn}, isHost=${host}`);
      setPlayerNum(pn);
      setGameId(id);
      setIsHost(host);
      isHostRef.current = host;
      setGameMode(mode || 'classic');
      setError(null);

      if (!host) {
        try {
          // Close any existing connection before creating a new one (prevents leak on reconnect)
          if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
          if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
          const { pc, dc: dataChannel } = await joinerConnect(socket);
          pcRef.current = pc;
          dcRef.current = dataChannel;
          setDc(dataChannel);
          setScreen('lobby');
        } catch (err) {
          setError(err.message);
        }
      } else {
        setScreen('lobby');
      }
    });

    socket.on('error', ({ message }) => setError(message));

    socket.on('lobby-closed', ({ message }) => {
      setError(message);
      setScreen('menu');
      window.history.pushState({}, '', '/');
      if (dcRef.current) {
        dcRef.current.close();
        dcRef.current = null;
      }
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      setDc(null);
    });

    socket.on('host-left', ({ message }) => {
      setHostLeft(true);
      setError(message);
    });

    socket.on('opponent-left', () => {});

    return () => {
      socket.off('game-created');
      socket.off('joined');
      socket.off('error');
      socket.off('lobby-closed');
      socket.off('host-left');
      socket.off('opponent-left');
      if (dcRef.current) {
        dcRef.current.close();
        dcRef.current = null;
      }
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, []);

  const handleCreateGame = useCallback((mode, vsBotParam = false, difficulty = 'medium') => {
    setError(null);
    setGameMode(mode);
    setLastWinner(null);
    if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    setDc(null);

    if (vsBotParam) {
      setVsBot(true);
      setBotDifficulty(difficulty);
      setPlayerNum(1);
      setIsHost(true);
      isHostRef.current = true;
      const startTime = Date.now();
      const gameDuration = 60;
      let gameData;
      if (mode === 'minesweeper') {
        gameData = { type: 'game-start', startTime, duration: gameDuration, mode };
      } else {
        const ops = ['+', '-', '×', '÷'];
        const problems = [];
        for (let i = 0; i < 120; i++) {
          const op = ops[Math.floor(Math.random() * 4)];
          let a, b, answer;
          switch (op) {
            case '+': a = Math.floor(Math.random() * 99) + 2; b = Math.floor(Math.random() * 99) + 2; answer = a + b; break;
            case '-': a = Math.floor(Math.random() * 99) + 2; b = Math.floor(Math.random() * a) + 1; answer = a - b; break;
            case '×': a = Math.floor(Math.random() * 11) + 2; b = Math.floor(Math.random() * 99) + 2; answer = a * b; break;
            case '÷': b = Math.floor(Math.random() * 11) + 2; answer = Math.floor(Math.random() * 99) + 2; a = answer * b; break;
          }
          problems.push({ a, b, op, answer });
        }
        gameData = { type: 'game-start', problems, startTime, duration: gameDuration, mode };
      }
      const botDc = createBotDC({ mode, difficulty, gameData, playerNum: 2 });
      dcRef.current = botDc;
      setDc(botDc);
      setGameData(gameData);
      setScreen('game');
      return;
    }

    setVsBot(false);
    socket.emit('leave-game');
    socket.emit('create-game', { mode });
  }, []);

  const handleBackToLobby = useCallback(() => {
    setGameData(null);
    setScreen('lobby');
  }, []);

  const handleGameEnd = useCallback((scores) => {
    const myScore = scores[playerNum];
    const oppScore = scores[playerNum === 1 ? 2 : 1];
    if (myScore > oppScore) {
      setLastWinner(prev => ({
        playerNum,
        streak: prev?.playerNum === playerNum ? prev.streak + 1 : 1,
      }));
    } else if (myScore < oppScore) {
      setLastWinner(prev => ({
        playerNum: playerNum === 1 ? 2 : 1,
        streak: prev?.playerNum === (playerNum === 1 ? 2 : 1) ? prev.streak + 1 : 1,
      }));
    }
  }, [playerNum]);

  const handleLeaveLobby = useCallback(() => {
    socket.emit('leave-game');
    setScreen('menu');
    setGameData(null);
    setGameId(null);
    setError(null);
    window.history.pushState({}, '', '/');
    if (dcRef.current) { dcRef.current.close(); dcRef.current = null; }
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    setDc(null);
  }, []);

  const handleGameStart = useCallback((data) => {
    setGameData(data);
    setScreen('game');
  }, []);

  if (hostLeft) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: '20px' }}>
        <div style={{ fontSize: '3rem' }}>👋</div>
        <h1 style={{ color: '#e94560', fontSize: '1.8rem', fontWeight: 800 }}>Host Left</h1>
        <p style={{ color: '#888', fontSize: '1.1rem' }}>{error || 'The host disconnected. The game has ended.'}</p>
        <button onClick={() => {
          setHostLeft(false);
          setError(null);
          setScreen('menu');
          setGameData(null);
          setGameId(null);
          window.history.pushState({}, '', '/');
        }} style={{ padding: '12px 36px', fontSize: '1.1rem' }}>
          Back to Menu
        </button>
      </div>
    );
  }

  if (screen === 'game' && dc && gameData) {
    return (
      <>
        {gameMode === 'minesweeper' && (
          <MinesweeperGame
            dc={dc}
            mode={gameMode}
            startTime={gameData.startTime}
            duration={gameData.duration}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
        {gameMode === 'memory' && (
          <MemoryGame
            dc={dc}
            layoutSeed={gameData.layoutSeed}
            startTime={gameData.startTime}
            duration={gameData.duration}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
        {gameMode === 'reaction' && (
          <ReactionGame
            dc={dc}
            startTime={gameData.startTime}
            duration={gameData.duration}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
        {gameMode === 'angrybirds' && (
          <AngryBirdsGame
            dc={dc}
            startTime={gameData.startTime}
            duration={gameData.duration}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
        {gameMode === 'color' && (
          <ColorGame
            dc={dc}
            startTime={gameData.startTime}
            duration={gameData.duration}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
        {gameMode === 'tapper' && (
          <TapperGame
            dc={dc}
            startTime={gameData.startTime}
            duration={gameData.duration}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
        {gameMode === 'coop-memory' && (
          <CoopMemoryGame
            dc={dc}
            startTime={gameData.startTime}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
        {(gameMode === 'classic' || gameMode === 'duel' || gameMode === 'health') && (
          <Game
            dc={dc}
            mode={gameMode}
            problems={gameData.problems}
            startTime={gameData.startTime}
            duration={gameData.duration}
            playerNum={playerNum}
            isHost={isHost}
            socket={socket}
            onBackToLobby={handleBackToLobby}
            onGameEnd={handleGameEnd}
          />
        )}
      </>
    );
  }

  if (screen === 'lobby') {
    return (
      <Lobby
        dc={dc}
        socket={socket}
        gameId={gameId}
        playerNum={playerNum}
        isHost={isHost}
        mode={gameMode}
        lastWinner={lastWinner}
        error={error}
        onGameStart={handleGameStart}
        onLeaveLobby={handleLeaveLobby}
      />
    );
  }

  return <GameModeSelector onCreateGame={handleCreateGame} error={error} />;
}
