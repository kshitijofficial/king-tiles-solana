# King Tiles

Turnless mini-game on Solana + Magicblock: players register on **devnet**, gameplay runs on an **ephemeral rollup** (fast moves + VRF king movement), and rewards settle back to devnet via a relayer.

- **Quick setup**: see `setup.md`
- **System overview**: see `architecture.md`

## Repo layout

- **`programs/king_tiles/`**: Anchor program (board PDA, registration, moves, VRF callback, settlement)
- **`relayer.ts` / `relayer/`**: Express relayer (start session, delegate to rollup, VRF/score ticks, end + distribute)
- **`app/`**: React UI (register + move via raw txs, poll relayer for status)

## Common commands

From repo root:

```bash
yarn
anchor build
yarn ts-node -P tsconfig.relayer.json relayer.ts
```

Web app:

```bash
cd app
yarn
yarn start
```

Formatting:

```bash
yarn lint
yarn lint:fix
```

