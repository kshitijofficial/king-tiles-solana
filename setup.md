# King Tiles - Setup

This project has four runtime pieces:

- `programs/king_tiles`: Anchor program
- `relayer.ts` + `relayer/`: Express relayer and session runtime
- `db/`: leaderboard schema + Supabase integration helpers
- `app/`: React game client

## 1) Prerequisites

- Node.js 18+
- Yarn
- Rust + Cargo
- Solana CLI configured for devnet
- Anchor CLI
- A devnet wallet (Phantom/Solflare/etc)

## 2) Install dependencies

From repo root:

```bash
yarn
```

From app directory:

```bash
cd app
yarn
```

## 3) Build Anchor artifacts (required)

The relayer imports generated types from `target/types/king_tiles`.

From repo root:

```bash
anchor build
```

## 4) Configure environment

Copy and edit root env file:

```bash
copy .env.example .env
```

Required:

- `TREASURY_SECRET_BASE58`
  - Base58 private key for the treasury pubkey hardcoded in the program.
  - Must correspond to: `86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA`

Common optional relayer vars:

- `RPC_URL` (default `https://api.devnet.solana.com`)
- `ER_ENDPOINT` (default `https://devnet.magicblock.app/`)
- `ER_WS_ENDPOINT` (default `wss://devnet.magicblock.app/`)
- `PORT` (default `8787`)
- `KING_TILES_PROGRAM_ID` or `PROGRAM_ID` (program override)

Optional vars for `/move` endpoint only:

- `PLAYER_ONE_PRIVATE_KEY` ... `PLAYER_SIX_PRIVATE_KEY`

## 5) Configure leaderboard DB (Supabase)

If you want `/leaderboard` and persistent score history:

1. Create a Supabase project.
2. Run SQL from `db/schema.sql` (SQL editor is easiest).
3. Set in root `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - Optional: `SUPABASE_LEADERBOARD_TABLE` (default `leaderboard`)

Notes:

- Without Supabase env vars, relayer skips leaderboard writes and `/leaderboard` returns an error.
- `SUPABASE_DB_PASSWORD` is only needed for direct DB tooling, not for relayer runtime.

## 6) Configure app program id (only if needed)

If you deploy a new program id, set in `app/.env`:

```bash
REACT_APP_PROGRAM_ID=<NEW_PROGRAM_ID>
```

If omitted, app falls back to the hardcoded id in `app/src/game/constants.ts`.

## 7) Run relayer

From repo root:

```bash
yarn ts-node -P tsconfig.relayer.json relayer.ts
```

Quick health checks:

- `GET http://localhost:8787/`
- `GET http://localhost:8787/games`

## 8) Run web app

In another terminal:

```bash
cd app
yarn start
```

The app uses relayer URL from `app/src/game/constants.ts` (`http://localhost:8787`).

## 9) Start a game session

The app does not create sessions. Create one through relayer:

```bash
curl -X POST "http://localhost:8787/start-session" \
  -H "Content-Type: application/json" \
  -d "{\"gameId\":1,\"boardSideLen\":8,\"maxPlayers\":2,\"registrationFeeLamports\":1000000,\"lamportsPerScore\":29000}"
```

Supported `(boardSideLen, maxPlayers)` pairs:

- `(8, 2)`
- `(10, 4)`
- `(12, 6)`

## 10) Join and play

1. Open the app, connect wallets, choose mode card for your session.
2. Each player clicks Register (registration tx is sent from deterministic session key).
3. When player count reaches mode max, relayer delegates board and starts runtime loops.
4. Move with `WASD`, use power with arrow keys.
5. After ~60s, relayer commits, distributes rewards, and syncs leaderboard.

## Troubleshooting

- `Treasury key mismatch` on `/start-session`
  - `TREASURY_SECRET_BASE58` does not match program treasury constant.
- `Invalid mode` on `/start-session`
  - Use one of `(8,2)`, `(10,4)`, `(12,6)`.
- Type errors importing `target/types/king_tiles`
  - Run `anchor build` from repo root.
- App cannot fetch status or leaderboard
  - Ensure relayer is running on `http://localhost:8787`.
- `/leaderboard` fails
  - Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and apply `db/schema.sql`.
