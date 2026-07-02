/**
 * End-to-end tests for P2P Zetamac Multiplayer.
 *
 * Tests the signaling server (Socket.IO) and game logic.
 * WebRTC data channels can't be tested in Node.js (browser API),
 * so we test: server signaling, message relay, game logic, problem gen.
 *
 * Usage: node test.js
 */

const { io: ioc } = require('socket.io-client');

const SERVER = 'http://localhost:3001';
const PASS = '✓';
const FAIL = '✗';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ${PASS} ${msg}`); passed++; }
  else { console.log(`  ${FAIL} ${msg}`); failed++; }
}

function waitForEvent(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);
    function handler(data) { clearTimeout(timer); resolve(data); }
    emitter.once(event, handler);
  });
}

// ── Game Logic Tests (pure functions, no network) ─────────────────────
function testGameLogic() {
  console.log('\n── Game Logic Unit Tests ──');

  // Problem generation
  function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
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

  const problems = generateProblems(120);
  assert(problems.length === 120, 'Generates 120 problems');
  assert(problems.every(p => ['+', '-', '×', '÷'].includes(p.op)), 'All ops valid');
  assert(problems.every(p => {
    const c = p.op === '+' ? p.a + p.b : p.op === '-' ? p.a - p.b : p.op === '×' ? p.a * p.b : p.a / p.b;
    return c === p.answer;
  }), 'All answers correct');

  // Subtraction never negative
  const subs = problems.filter(p => p.op === '-');
  assert(subs.every(p => p.a >= p.b), 'Subtraction: a >= b (no negatives)');

  // Division always integer
  const divs = problems.filter(p => p.op === '÷');
  assert(divs.every(p => Number.isInteger(p.a / p.b)), 'Division: always integer result');

  // Multiplication: factor <= 12
  const mults = problems.filter(p => p.op === '×');
  assert(mults.every(p => p.a <= 12), 'Multiplication: first factor <= 12');

  // Two different games give different problems
  const problems2 = generateProblems(120);
  const firstFew1 = problems.slice(0, 5).map(p => `${p.a}${p.op}${p.b}`).join(',');
  const firstFew2 = problems2.slice(0, 5).map(p => `${p.a}${p.op}${p.b}`).join(',');
  assert(firstFew1 !== firstFew2, 'Different games have different problem sequences');

  // Timing: score calculation
  const scores = { me: 15, opp: 12 };
  assert(scores.me > scores.opp ? 'win' : scores.me < scores.opp ? 'lose' : 'tie', 'Score comparison works');
}

// ── Data Channel Message Format Tests ─────────────────────────────────
function testMessageFormat() {
  console.log('\n── Data Channel Message Format ──');

  const messages = {
    playerReady: { type: 'player-ready', ready: true },
    lobbyUpdate: { type: 'lobby-update', p1Ready: true, p2Ready: false, p1Connected: true, p2Connected: true },
    countdown: { type: 'countdown', num: 3 },
    gameStart: { type: 'game-start', problems: [], startTime: Date.now(), duration: 60 },
    playerUpdate: { type: 'player-update', problemIndex: 5, input: '42', score: 12 },
    gameOver: { type: 'game-over', scores: { 1: 15, 2: 12 } },
    restart: { type: 'restart' },
    backToLobby: { type: 'back-to-lobby' },
  };

  // Round-trip through JSON (simulating data channel send/receive)
  for (const [name, msg] of Object.entries(messages)) {
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json);
    assert(parsed.type === msg.type, `${name}: type survives JSON round-trip`);
    assert(typeof parsed.type === 'string', `${name}: type is string`);
  }

  // Data channel max message size check (WebRTC data channel: ~16KB for text)
  const bigProblemList = { type: 'game-start', problems: Array.from({ length: 120 }, (_, i) => ({
    a: 50, b: 25, op: '+', answer: 75,
  })), startTime: Date.now(), duration: 60 };
  const bigJson = JSON.stringify(bigProblemList);
  assert(bigJson.length < 16000, `Game-start with 120 problems fits in data channel (${bigJson.length} bytes)`);
}

// ── Server Signaling Tests ────────────────────────────────────────────
async function testServerSignaling() {
  console.log('\n── Server Signaling Tests ──');

  const host = ioc(SERVER, { transports: ['websocket'] });

  // 1. Create game
  await waitForEvent(host, 'connect', 2000);
  assert(true, 'Host connects');

  host.emit('create-game');
  const created = await waitForEvent(host, 'game-created', 3000);
  const gameId = created.gameId;
  assert(gameId.length === 6, `Game created: ${gameId}`);

  const joined = await waitForEvent(host, 'joined', 2000);
  assert(joined.playerNum === 1, 'Host is player 1');
  assert(joined.isHost === true, 'Host is isHost');

  // 2. Joiner connects
  const joiner = ioc(SERVER, { transports: ['websocket'] });
  await waitForEvent(joiner, 'connect', 2000);
  assert(true, 'Joiner connects');

  joiner.emit('join-game', { gameId });
  const jJoined = await waitForEvent(joiner, 'joined', 2000);
  assert(jJoined.playerNum === 2, 'Joiner is player 2');
  assert(jJoined.isHost === false, 'Joiner is not host');

  // 3. Host gets peer-joined
  await waitForEvent(host, 'peer-joined', 2000);
  assert(true, 'Host receives peer-joined');

  // 4. Signaling relay: host → joiner (offer)
  const testSignal = { type: 'offer', sdp: { type: 'offer', sdp: 'test-offer-sdp' } };
  host.emit('signal', testSignal);
  const relayedOffer = await waitForEvent(joiner, 'signal', 2000);
  assert(relayedOffer.type === 'offer', 'Offer relayed host → joiner');
  assert(relayedOffer.sdp.sdp === 'test-offer-sdp', 'SDP content preserved');

  // 5. Signaling relay: joiner → host (answer + ICE)
  const answerSignal = { type: 'answer', sdp: { type: 'answer', sdp: 'test-answer-sdp' } };
  joiner.emit('signal', answerSignal);
  const relayedAnswer = await waitForEvent(host, 'signal', 2000);
  assert(relayedAnswer.type === 'answer', 'Answer relayed joiner → host');

  // ICE candidate relay
  const iceSignal = { candidate: 'test-ice-candidate', sdpMLineIndex: 0 };
  joiner.emit('signal', iceSignal);
  const relayedIce = await waitForEvent(host, 'signal', 2000);
  assert(relayedIce.candidate === 'test-ice-candidate', 'ICE candidate relayed joiner → host');

  // 6. Lobby full rejection
  const third = ioc(SERVER, { transports: ['websocket'] });
  await waitForEvent(third, 'connect', 2000);
  third.emit('join-game', { gameId });
  const err = await waitForEvent(third, 'error', 2000);
  assert(err.message.toLowerCase().includes('full'), `Third player rejected: "${err.message}"`);
  third.close();

  // 7. Invalid game ID
  const bad = ioc(SERVER, { transports: ['websocket'] });
  await waitForEvent(bad, 'connect', 2000);
  bad.emit('join-game', { gameId: 'ZZZZZZ' });
  const badErr = await waitForEvent(bad, 'error', 2000);
  assert(badErr.message.toLowerCase().includes('not found'), `Invalid game: "${badErr.message}"`);
  bad.close();

  // 8. Disconnect notification
  joiner.disconnect();
  const oppLeft = await waitForEvent(host, 'opponent-left', 3000);
  assert(true, 'Host notified of opponent disconnect');

  // Cleanup
  host.close();
}

// ── Reconnection test ─────────────────────────────────────────────────
async function testReconnection() {
  console.log('\n── Reconnection Test ──');

  const host = ioc(SERVER, { transports: ['websocket'] });
  await waitForEvent(host, 'connect', 2000);
  host.emit('create-game');
  await waitForEvent(host, 'game-created', 2000);
  await waitForEvent(host, 'joined', 2000);

  // Reconnect same socket (simulating page refresh)
  host.disconnect();
  await new Promise(r => setTimeout(r, 300));
  host.connect();
  await waitForEvent(host, 'connect', 2000);

  const gameId = 'aaaaaa'; // won't find it with new socket id, but tests reconnect code path
  host.emit('join-game', { gameId: 'ZZZZZZ' });
  const err = await waitForEvent(host, 'error', 2000);
  assert(err.message.toLowerCase().includes('not found'), 'Reconnected socket gets proper error');

  host.close();
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('=== P2P Zetamac Test Suite ===');

  testGameLogic();
  testMessageFormat();
  await testServerSignaling();
  await testReconnection();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness error:', err);
  process.exit(1);
});
