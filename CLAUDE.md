## Architectural Principles

### Game State Visibility: Default ON
By default, every player's game state is visible to the opponent in real-time. This means:
- In Classic: opponent sees your current problem, input, and score
- In Duel: opponent sees the same problem and your score
- In Health: opponent sees your problem, input, score, and HP
- In Minesweeper: opponent sees your full board state (revealed cells, flags)
- This is the default unless explicitly stated otherwise for a specific feature

To hide something from the opponent, it must be explicitly implemented as a hidden mechanic (e.g., the sabotage effect for the 3-second flash is visible; the underlying mine positions in minesweeper are hidden by the game itself — revealed mines are only shown on game over).

### Per-Player Random State
Each player gets their OWN random state (not identical) unless explicitly stated:
- Classic: different problems per player
- Duel: same problem per turn (race to answer)
- Health: different problems per player
- Minesweeper: each player has a random board (different mine layouts)

When designing new features, decide per-player vs shared randomness explicitly.

### Data Flow: State Changes Are Synced
Game state changes that affect the opponent's visible view must be sent via data channel messages:
- Player-made moves (revealed cells, flagged cells, score changes)
- Only the VISIBLE portion of the state is synced (e.g., adjacent numbers but not mine positions)
- Game termination events (mine hit, board cleared, timer expiry) are always synced

### Bot Mode: Always Implement for All Game Modes
Every game mode MUST have a vs-bot option. This is NOT optional — it's a first-class feature, not a nice-to-have.

**Architecture:**
- `bot.js` exports `createBotDC({ mode, difficulty, gameData, playerNum })` which returns a mock DataChannel
- The mock DC replaces the real WebRTC DataChannel when playing vs bot
- The bot sends the same DC message format as a real opponent, using the same message types
- The bot runs on setTimeout timers at human-like speeds with configurable accuracy

**Difficulty levels (always three):**
- Easy: 30% accuracy, 3-7 second intervals, makes obvious mistakes
- Medium: 70% accuracy, 2-4 second intervals, plays reasonably  
- Hard: 95% accuracy, 1-2.5 second intervals, plays well

**Integration pattern:**
1. GameModeSelector shows "Play vs Player" (original) + "Easy/Medium/Hard Bot" buttons
2. App.jsx handles vsBot flow: skips lobby and WebRTC, generates game data inline, creates bot DC, transitions directly to game screen
3. The game component (Game.jsx, MinesweeperGame.jsx, etc.) receives the bot DC and works identically to a real game
4. No changes needed inside game components — they already use DC as an abstraction

**When adding a NEW game mode, bot support MUST be implemented as part of the initial development.**
