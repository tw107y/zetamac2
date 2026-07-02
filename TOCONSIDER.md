# P2P Architecture — Tradeoffs & Considerations

## Can you just "share an IP"?

**No, not across different networks.** Here's why:

Every home WiFi uses NAT (Network Address Translation). Your computer has a *local* IP like `192.168.1.5`. The outside world only sees your router's *public* IP. Incoming connections from the internet hit your router and don't know which device to reach — they get dropped unless you manually set up **port forwarding**.

So "here's my IP: 73.14.xxx.xxx, connect to port 3001" won't work without router config. This is why WebRTC exists.

## The actual solution: WebRTC

WebRTC is built into every browser. It uses STUN servers (free, public) to punch through NAT and establish a direct peer-to-peer connection. No router config needed.

Architecture:
```
  ┌─────────────────────────────────────────────┐
  │          Central Server (minimal)            │
  │  - Creates lobby IDs                         │
  │  - Relays WebRTC signaling (offer/answer)    │
  │  - Lobby cleanup (10-min TTL)                │
  │  - NO game data passes through               │
  └─────────────────────────────────────────────┘
         │  signaling           │  signaling
         ▼                      ▼
  ┌──────────────┐      ┌──────────────┐
  │   Player 1   │◄────►│   Player 2   │
  │   (Host)     │ P2P  │   (Joiner)   │
  │              │      │              │
  └──────────────┘      └──────────────┘
       Game data flows directly (no server)
```

## How it works

1. **Host** creates lobby on central server → gets gameId
2. **Joiner** opens link, connects to central server, joins lobby
3. Both create `RTCPeerConnection` (browser API, zero dependencies)
4. Host creates an **offer**, sends it to joiner via server relay
5. Joiner receives offer, creates an **answer**, sends it back
6. They exchange **ICE candidates** through the server
7. Connection established → a direct peer-to-peer **data channel** opens
8. All game data (ready, countdown, problem updates, scores) flows P2P
9. Central server is done — it just keeps the lobby alive for cleanup

## Server becomes truly minimal

| Event | Before (relay) | After (P2P) |
|---|---|---|
| `player-update` | Server relays 10/sec | Direct P2P, 0 server load |
| `opponent-update` | Server relays 10/sec | Direct P2P |
| `countdown` | Server manages timer | Host manages timer |
| `game-start` | Server generates problems | Host generates problems |
| `game-over` | Server decides when | Host is authoritative |
| Signaling | N/A | Server relays offer/answer (~6 msgs total) |

The server only handles ~6 messages per game (signaling), vs thousands before (game updates every 100ms for 60s = 600 updates).

## Cons

### 1. Host can cheat (you mentioned this)
Since the host generates problems, runs the timer, and tallies scores, they can manipulate everything. For a competitive game this is a real concern, but you said you don't care for now.

### 2. NAT traversal isn't 100% guaranteed
STUN works ~85-90% of the time. Symmetric NATs (corporate networks, some mobile hotspots) require a TURN relay server. Without TURN, some players simply can't connect. Google provides free STUN but not TURN. A TURN server costs ~$5/month or you can self-host. We'd add STUN first and see how often TURN is needed.

### 3. Connection setup is slower
WebRTC signaling takes 1-3 seconds (offer → answer → ICE gathering). Current Socket.IO approach connects instantly. This is a one-time cost per lobby, not per game.

### 4. Host disconnects = game dies
Currently if one player disconnects, the server keeps the other player's state. P2P means if the host's browser crashes or they close the tab, the game is gone for both players. No recovery possible.

### 5. More client-side complexity
The host now runs game logic (problem generation, timer, scoring). The client code roughly doubles in responsibility. Currently the server is the single source of truth.

### 6. Harder to debug
No server-side logs for game events. You can't see what happened in a game unless you have access to both players' browsers.

### 7. Local testing is limited
- **Same machine (two tabs)**: Works fine, WebRTC on localhost
- **Same WiFi (two computers)**: Works fine, local IPs
- **Different WiFi**: Works if STUN succeeds (~85% of home networks). Some ISPs use symmetric NAT.
- **Testing the NAT traversal path**: You need two different networks to truly verify it works end-to-end

## Local testing with your setup

You have 2 computers on the same WiFi. Here's what will and won't work:

| Scenario | Works? |
|---|---|
| Two browser tabs on Mac #1 | ✅ Yes |
| Mac #1 ↔ Mac #2 (same WiFi) | ✅ Yes |
| Mac #1 (home WiFi) ↔ Mac #2 (phone hotspot) | ⚠️ Depends on carrier NAT |
| Mac #1 (home) ↔ friend on different home WiFi | ⚠️ ~85% chance with STUN |

## Recommendation

For MVP, I'd implement WebRTC with:
1. **Google's free STUN server** (`stun:stun.l.google.com:19302`) — handles ~85% of cases
2. **No TURN** — accept that some networks won't work
3. **Host does everything** — problem generation, timer, scoring
4. **Server is signaling-only** — 6 messages per game, no game data relay

If this P2P approach causes too many connection failures, we can always fall back to the current relay model — the protocol is the same, just the transport changes.

---

## Decision needed before I implement

Do you want to proceed with WebRTC P2P (with the cons above), or stick with the current server-relay model?
