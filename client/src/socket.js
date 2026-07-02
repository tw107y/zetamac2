import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.DEV
  ? '/'              // Vite proxies /socket.io to :3001
  : window.location.origin; // Same origin in production

const socket = io(SOCKET_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
});

export default socket;
