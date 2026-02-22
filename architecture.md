# King Tiles — Architecture

King Tiles is a small on-chain game that uses:

- **Solana devnet** for player registration and reward distribution (L1 / base layer)
- **Magicblock Ephemeral Rollup** for fast in-game moves + VRF-driven king movement
- A **relayer** to orchestrate delegation, VRF ticks, scoring ticks, and end-of-game settlement
- A **React UI** for players (with a deterministic “session key” per wallet)

## Components

### On-chain program (`programs/king_tiles`)

- **Program id**: default is hardcoded in `programs/king_tiles/src/lib.rs` (can be overridden in the relayer via env).
- **Treasury**: fixed pubkey constant in `programs/king_tiles/src/constants.rs`. Registration fees are paid into it; rewards are paid out from it.
- **Core account**: a `Board` PDA per `game_id`, derived as:
  - seeds: `["board", treasury_pubkey, game_id_le_bytes]`

Key instructions (simplified):

- **`start_game_session(game_id)`**: initializes the board PDA on devnet.
- **`register_player(game_id)`**: up to 2 players pay a registration fee into the treasury; when the 2nd registers, emits `GameStartedEvent` and starts a 60s timer.
- **`delegate_board(game_id)`**: delegates the board PDA for ephemeral execution.
- **`make_move(game_id, player_id, delta)`**: applies player movement (orthogonal, wraparound).
- **`request_randomness(client_seed, game_id)`**: asks VRF for randomness; callback moves the king tile.
- **`update_player_score(game_id)`**: treasury-gated tick that increments score for whoever stands on the king tile.
- **`end_game_session(game_id)`**: exits + commits state back to devnet and undelegates.
- **`distribute_rewards(game_id)`**: devnet settlement; pays each player `score * lamports_per_score`.

### Relayer (`relayer.ts`, `relayer/`)

The relayer is an Express service that holds the **treasury keypair** and orchestrates the game lifecycle:

- **Starts sessions**: `POST /start-session` calls `start_game_session` on devnet.
- **Watches for start**: listens to `GameStartedEvent` on devnet.
- **Delegates to ER**: on start event, sends `delegate_board` on devnet so the board can be mutated on the rollup.
- **Runs the game loop** (while active):
  - every ~5s: `request_randomness` on the rollup (moves the king via VRF callback)
  - every ~1s: `update_player_score` on the rollup (treasury-gated)
- **Ends + settles**:
  - after ~60s: `end_game_session` on the rollup (commit back to devnet)
  - then `distribute_rewards` on devnet (with retries)
- **Serves read model**:
  - `GET /game-status` fetches the board from ER first (if active) and falls back to devnet (if inactive).

### Web app (`app/`)

The UI is intentionally thin and uses a deterministic **session keypair** derived from the connected wallet’s pubkey:

- **Registration**: sends a raw devnet transaction calling `register_player`.
- **Moves**: sends raw rollup transactions calling `make_move` (plus an extra memo instruction to keep txs unique).
- **State**: polls the relayer every second for `/game-status` to render the canonical board + scores.

## Data model (board encoding)

The board is a flat `12 × 12` array (size 144) with these cell values:

- `0`: empty
- `1..4`: player id
- `5`: king tile marker (may be “covered” by a player when standing on it)

## Configuration knobs

- **Relayer port**: `PORT` (default `8787`)
- **Devnet RPC**: `RPC_URL` (default is in `relayer/config.ts`)
- **Magicblock endpoints**: `ER_ENDPOINT`, `ER_WS_ENDPOINT` (defaults are in `relayer/config.ts`)
- **Program id override**: `KING_TILES_PROGRAM_ID` / `PROGRAM_ID`
- **React program id override**: `REACT_APP_PROGRAM_ID` (falls back to a hardcoded id in `app/src/game/constants.ts`)

