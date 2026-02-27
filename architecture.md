# King Tiles - Architecture

King Tiles is a hybrid Solana game:

- Devnet is the base layer for session creation, player registration, and reward payout.
- Magicblock Ephemeral Rollup (ER) is used for high-frequency gameplay writes.
- A relayer runs the session lifecycle and serves read APIs.
- A Supabase-backed leaderboard stores a persistent off-chain read model.
- The React app renders state from relayer APIs and sends player transactions.

## Component map

### 1) On-chain program (`programs/king_tiles`)

- Program id (current): `GAfcEqSSQJm2coiTRf4wL1SDX78jciwE6bN9eHwUaXi9`
- Fixed treasury pubkey: `86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA`
- Main state account: `Board` PDA per `game_id`
  - Seeds: `["board", treasury_pubkey, game_id_le_bytes]`

The program supports three game modes:

- `8x8` board, `2` players
- `10x10` board, `4` players
- `12x12` board, `6` players

Core instruction flow:

- `start_game_session(game_id, board_side_len, max_players, registration_fee_lamports, lamports_per_score)`
- `register_player(game_id)` (registration fee transfer to treasury; game becomes active when `players_count == max_players`; 60s timer starts)
- `delegate_board(game_id)` (devnet -> ER delegation)
- `make_move(game_id, player_id, direction)` (up/down/left/right)
- `request_randomness_for_king_move(...)` + callback
- `request_randomness_for_powerup_move(...)` + callback
- `request_randomness_for_bomb_drop(...)` + callback
- `update_player_score(game_id)` (treasury-gated, 1 point if king tile is occupied by a player)
- `use_power(game_id, player_id, direction)` (treasury-gated)
- `end_game_session(game_id)` (commit + undelegate from ER)
- `distribute_rewards(game_id)` (treasury pays each player `score * lamports_per_score`)

Gameplay rules encoded on-chain:

- Normal collision bumps the collided player by 2 steps in move direction.
- Powerup grants `powerup_score = 4`.
- `use_power` pushes the first player in line by 4 tiles (or resolves through normal collision logic).
- Bomb tile warps the stepped-on player back toward deterministic spawn slots (with probing for empty tile).

### 2) Relayer (`relayer.ts`, `relayer/`)

The relayer is an Express service using the treasury keypair. It orchestrates session runtime on ER and settlement on devnet.

Session runtime responsibilities:

- Starts sessions via `POST /start-session`
- Listens for `GameStartedEvent` on devnet
- Delegates board when game starts
- Starts periodic loops while active:
  - King VRF request every 5s
  - Powerup VRF request every 7s
  - Bomb VRF request every 10s
  - Score tick every 1s
- Ends game when chain time reaches end timestamp, then settles rewards with retries

Resilience behavior:

- Recovers active/waiting sessions from chain at boot
- Watchdog re-checks tracked sessions and resumes runtime if needed
- Retries reward settlement and handles delegated-owner mismatch by re-finalizing from ER
- Caches `/game-status` responses with short TTLs

Relayer HTTP API:

- `GET /` health + endpoint summary
- `GET /games` active sessions + latest completed snapshots (including by mode)
- `GET /game-status?gameId=<n>` board state (ER-first for active games, devnet fallback)
- `GET /leaderboard` top players from DB read model
- `POST /start-session` create board with mode + fee config
- `POST /move` optional server-signed move path (requires player private keys in relayer env)
- `POST /use-power` treasury-signed `use_power` call
- `POST /retry-rewards` manual payout retry for ended games

### 3) Leaderboard DB (`db/`)

- Storage: Supabase PostgREST
- Table: `leaderboard` (default name; configurable via env)
- Upsert model per wallet:
  - `best_score`
  - `last_game_score`
  - `last_game_id`
  - `games_played`
  - `updated_at`

Write path:

- After end/commit, relayer reads finalized devnet board and calls `upsertLeaderboardFromBoard`.

Read path:

- `GET /leaderboard` returns top N (`5` currently in relayer route).

### 4) Web app (`app/`)

App behavior:

- Uses connected wallet only to derive/fund a deterministic session keypair (`Keypair.fromSeed(wallet.toBytes())`)
- Registers player by sending raw devnet `register_player` tx from session key
- Sends move txs directly to ER (`make_move`) from session key, with memo uniqueness and optimistic UI updates
- Uses relayer for:
  - game discovery (`/games`)
  - canonical status (`/game-status`)
  - leaderboard (`/leaderboard`)
  - power usage (`/use-power`, because treasury signer is required by on-chain instruction)

The app does not create sessions directly; session creation is done through relayer `POST /start-session`.

## Board encoding

Board storage is a fixed `[u8; 144]` array. Active cells are `board_side_len * board_side_len`.

- `0` -> empty
- `1..max_players` -> player id
- `253` -> bomb
- `254` -> powerup
- `255` -> king

Note: king may be visually tracked separately in the UI when a player occupies the king tile.

## Configuration points

- Relayer:
  - `PORT`
  - `TREASURY_SECRET_BASE58`
  - `RPC_URL`
  - `ER_ENDPOINT`, `ER_WS_ENDPOINT`
  - `KING_TILES_PROGRAM_ID` or `PROGRAM_ID` override
  - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_LEADERBOARD_TABLE`
- App:
  - `REACT_APP_PROGRAM_ID` override (otherwise uses hardcoded fallback in `app/src/game/constants.ts`)
