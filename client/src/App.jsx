import { useState, useEffect, useCallback, useRef } from 'react';
import socket from './socket';
import { hostConnect, joinerConnect } from './webrtc';
import MainMenu from './components/MainMenu';
import Lobby from './components/Lobby';
import Game from './components/Game';

export default function App() {
  const [screen, setScreen] = useState('menu');
  const [gameId, setGameId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [playerNum, setPlayerNum] = useState(null);
  const [gameData, setGameData] = useState(null);
  const [error, setError] = useState(null);
  const dcRef = useRef(null); // RTCDataChannel — the P2P game channel

  // Connect socket on mount
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
    socket.on('game-created', ({ gameId: id }) => {
      setGameId(id);
      window.history.pushState({}, '', `/${id}`);
    });

    socket.on('joined', async ({ playerNum: pn, gameId: id, isHost: host }) => {
      setPlayerNum(pn);
      setGameId(id);
      setIsHost(host);
      setError(null);

      if (host) {
        // Host: wait for peer-joined, then start WebRTC
        socket.once('peer-joined', async () => {
          try {
            const { dc } = await hostConnect(socket);
            dcRef.current = dc;
            setScreen('lobby');
          } catch (err) {
            setError(err.message);
          }
        });
      } else {
        // Joiner: start WebRTC immediately (waits for offer)
        try {
          const { dc } = await joinerConnect(socket);
          dcRef.current = dc;
          setScreen('lobby');
        } catch (err) {
          setError(err.message);
        }
      }
    });

    socket.on('game-state', (data) => {
      // Reconnect during game — restore state
      setGameData(data);
      if (data.state === 'playing') setScreen('game');
    });

    socket.on('error', ({ message }) => setError(message));

    socket.on('lobby-closed', ({ message }) => {
      setError(message);
      setScreen('menu');
      window.history.pushState({}, '', '/');
    });

    return () => {
      socket.off('game-created');
      socket.off('joined');
      socket.off('game-state');
      socket.off('error');
      socket.off('lobby-closed');
    };
  }, []);

  const handleCreateGame = useCallback(() => {
    setError(null);
    socket.emit('create-game');
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
        problems={gameData.problems}
        startTime={gameData.startTime}
        duration={gameData.duration}
        playerNum={playerNum}
        isHost={isHost}
        onBackToLobby={handleBackToLobby}
      />
    );
  }

  if (screen === 'lobby' && dc) {
    return (
      <Lobby
        dc={dc}
        socket={socket}
        gameId={gameId}
        playerNum={playerNum}
        isHost={isHost}
        error={error}
        onGameStart={(data) => {
          setGameData(data);
          setScreen('game');
        }}
      />
    );
  }

  return <MainMenu onCreateGame={handleCreateGame} error={error} />;
}
