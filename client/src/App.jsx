import { useState, useEffect, useCallback, useRef } from 'react';
import socket from './socket';
import { hostConnect, joinerConnect } from './webrtc';
import GameModeSelector from './components/GameModeSelector';
import Lobby from './components/Lobby';
import Game from './components/Game';

export default function App() {
  const [screen, setScreen] = useState('menu');
  const [gameId, setGameId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [playerNum, setPlayerNum] = useState(null);
  const [gameMode, setGameMode] = useState('classic');
  const [gameData, setGameData] = useState(null);
  const [error, setError] = useState(null);
  const [dcReady, setDcReady] = useState(false);
  const dcRef = useRef(null);

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

  // Socket event listeners (signaling only)
  useEffect(() => {
    socket.on('game-created', ({ gameId: id, mode }) => {
      setGameId(id);
      setGameMode(mode || 'classic');
      window.history.pushState({}, '', `/${id}`);
    });

    socket.on('joined', async ({ playerNum: pn, gameId: id, isHost: host, mode }) => {
      setPlayerNum(pn);
      setGameId(id);
      setIsHost(host);
      setGameMode(mode || 'classic');
      setError(null);

      if (host) {
        setScreen('lobby');
        socket.once('peer-joined', async () => {
          try {
            const { dc } = await hostConnect(socket);
            dcRef.current = dc;
            setDcReady(true);
          } catch (err) {
            setError(err.message);
          }
        });
      } else {
        try {
          const { dc } = await joinerConnect(socket);
          dcRef.current = dc;
          setDcReady(true);
          setScreen('lobby');
        } catch (err) {
          setError(err.message);
        }
      }
    });

    socket.on('error', ({ message }) => setError(message));

    socket.on('lobby-closed', ({ message }) => {
      setError(message);
      setScreen('menu');
      window.history.pushState({}, '', '/');
    });

    socket.on('opponent-left', () => {});

    return () => {
      socket.off('game-created');
      socket.off('joined');
      socket.off('error');
      socket.off('lobby-closed');
      socket.off('opponent-left');
    };
  }, []);

  const handleCreateGame = useCallback((mode) => {
    setError(null);
    setGameMode(mode);
    setDcReady(false);
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    socket.emit('leave-game');
    socket.emit('create-game', { mode });
  }, []);

  const handleBackToLobby = useCallback(() => {
    setGameData(null);
    setScreen('lobby');
  }, []);

  const dc = dcRef.current;

  if (screen === 'game' && dc && gameData) {
    return (
      <Game
        dc={dc}
        mode={gameMode}
        problems={gameData.problems}
        startTime={gameData.startTime}
        duration={gameData.duration}
        playerNum={playerNum}
        isHost={isHost}
        onBackToLobby={handleBackToLobby}
      />
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
        error={error}
        onGameStart={(data) => {
          setGameData(data);
          setScreen('game');
        }}
      />
    );
  }

  return <GameModeSelector onCreateGame={handleCreateGame} error={error} />;
}
