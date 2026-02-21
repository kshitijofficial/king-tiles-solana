import dotenv from "dotenv";
import { resolve } from "path";
dotenv.config({ path: resolve(process.cwd(), ".env") });
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KingTiles } from "./target/types/king_tiles";
import {
  sendAndConfirmTransaction,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import express, { Request, Response } from "express";
const PORT = Number(process.env.PORT || 8787);

// Must match programs/king_tiles/src/lib.rs TREASURY constant
const PROGRAM_TREASURY_PUBKEY = "86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA";

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadKeypair(privateKeyBase58?: string): Keypair {
  if (!privateKeyBase58) {
    throw new Error("Missing private key. Set TREASURY_SECRET_BASE58 in .env.");
  }
  try {
    const privateKeyBytes = bs58.decode(privateKeyBase58);
    if (privateKeyBytes.length === 32) return Keypair.fromSeed(privateKeyBytes);
    if (privateKeyBytes.length === 64) return Keypair.fromSecretKey(privateKeyBytes);
    throw new Error(`Invalid key length: ${privateKeyBytes.length}. Expected 32 or 64 bytes.`);
  } catch (error) {
    console.error("Error loading keypair:", error);
    throw new Error("Failed to load keypair. Ensure it is base58 encoded.");
  }
}

function getBoardPDA(
  treasuryPubkey: PublicKey,
  programId: PublicKey,
  gameId: number
): [PublicKey, number] {
  const gameIdBuffer = Buffer.alloc(8);
  gameIdBuffer.writeBigUInt64LE(BigInt(gameId));
  return anchor.web3.PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode("board"),
      treasuryPubkey.toBuffer(),
      gameIdBuffer,
    ],
    programId
  );
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const treasuryKeypair = loadKeypair(process.env.TREASURY_SECRET_BASE58);
  const treasuryPubkey = treasuryKeypair.publicKey;
  const configuredPlayerKeypairs = [
    process.env.PLAYER_ONE_PRIVATE_KEY,
    process.env.PLAYER_TWO_PRIVATE_KEY,
    process.env.PLAYER_THREE_PRIVATE_KEY,
    process.env.PLAYER_FOUR_PRIVATE_KEY,
  ]
    .filter(Boolean)
    .map((k) => loadKeypair(k));
  const playerKeypairByPubkey = new Map(
    configuredPlayerKeypairs.map((kp) => [kp.publicKey.toBase58(), kp] as const)
  );

  // Base layer (devnet) — built directly from env vars, no Anchor CLI dependency
  const solanaConnection = new anchor.web3.Connection(
    process.env.RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const provider = new anchor.AnchorProvider(
    solanaConnection,
    new anchor.Wallet(treasuryKeypair),
    { commitment: "confirmed" }
  );

  // Ephemeral Rollup — direct connection (used for VRF requests and game txs)
  const ER_ENDPOINT = process.env.ER_ENDPOINT || "https://devnet.magicblock.app/";
  const ER_WS_ENDPOINT = process.env.ER_WS_ENDPOINT || "wss://devnet.magicblock.app/";
  const connectionER = new anchor.web3.Connection(ER_ENDPOINT, {
    wsEndpoint: ER_WS_ENDPOINT,
    commitment: "confirmed",
  });


  anchor.setProvider(provider);
  // Program ID comes from target/idl/king_tiles.json (updated on `anchor build`). No .env needed.
  let program = anchor.workspace.kingTiles as Program<KingTiles>;

  // Optional: override program ID via env (e.g. point at another deployment without rebuilding)
  const programIdOverride = process.env.KING_TILES_PROGRAM_ID || process.env.PROGRAM_ID;
  if (programIdOverride) {
    const idl = JSON.parse(JSON.stringify(program.rawIdl)) as typeof program.rawIdl;
    idl.address = programIdOverride;
    program = new anchor.Program(idl, provider) as Program<KingTiles>;
  }

  // ER program — uses direct connection to avoid router "different ER nodes" errors
  const providerER = new anchor.AnchorProvider(
    connectionER,
    new anchor.Wallet(treasuryKeypair)
  );
  const programER = new anchor.Program<KingTiles>(program.idl, providerER);

  // Oracle queue for VRF on the Ephemeral Rollup
  const EPHEMERAL_ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
  const KING_MOVE_INTERVAL_MS = 5_000;
  const GAME_DURATION_MS = 60_000;

  // ─── Relayer state ─────────────────────────────────────────────────────────
  let currentGameId: number | null = null;
  let gameTimer: NodeJS.Timeout | null = null;
  let kingMoveInterval: NodeJS.Timeout | null = null;
  let scoreInterval: NodeJS.Timeout | null = null;

  // ─── Update player score on the ER (called every 1s during game) ──────────
  async function updatePlayerScore(gameId: number, boardPDA: PublicKey): Promise<void> {
    try {
      await programER.methods
        .updatePlayerScore(new anchor.BN(gameId))
        .accountsPartial({
          treasury: treasuryPubkey,
          boardAccount: boardPDA,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
    } catch (err: any) {
      // Suppress noisy per-tick errors; game may not have started yet or is ending
      console.error(`  [Score] updatePlayerScore failed for gameId ${gameId}:`, err.message ?? err);
    }
  }

  function stopScoreInterval(): void {
    if (scoreInterval) {
      clearInterval(scoreInterval);
      scoreInterval = null;
      console.log(`  [Score] Interval stopped.`);
    }
  }

  function startScoreInterval(gameId: number, boardPDA: PublicKey): void {
    stopScoreInterval();
    console.log(`  [Score] Starting score update interval every 1s...`);
    // Fire immediately, then every 1s
    updatePlayerScore(gameId, boardPDA);
    scoreInterval = setInterval(() => updatePlayerScore(gameId, boardPDA), 1_000);
  }

  // ─── Request randomness on the ER (called every 5s during game) ────────────
  async function requestKingMove(gameId: number, boardPDA: PublicKey): Promise<void> {
    try {
      const clientSeed = Math.floor(Math.random() * 256); // random u8
      // Use .rpc() so Anchor's provider handles blockhash fetching internally
      const txHash = await programER.methods
        .requestRandomness(clientSeed, new anchor.BN(gameId))
        .accountsPartial({
          treasurySigner: treasuryPubkey,
          boardAccount: boardPDA,
          oracleQueue: EPHEMERAL_ORACLE_QUEUE,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`  [King] VRF request sent → seed=${clientSeed} txHash=${txHash}`);
    } catch (err: any) {
      console.error(`  [King] VRF request failed for gameId ${gameId}:`, err.message ?? err);
    }
  }

  function stopAllIntervals(): void {
    if (kingMoveInterval) {
      clearInterval(kingMoveInterval);
      kingMoveInterval = null;
      console.log(`  [King] Interval stopped.`);
    }
    stopScoreInterval();
  }

  function startKingMoveInterval(gameId: number, boardPDA: PublicKey): void {
    stopAllIntervals();
    console.log(`  [King] Starting VRF interval every ${KING_MOVE_INTERVAL_MS / 1000}s for ${GAME_DURATION_MS / 1000}s...`);
    // Fire immediately, then every 5s
    requestKingMove(gameId, boardPDA);
    kingMoveInterval = setInterval(() => requestKingMove(gameId, boardPDA), KING_MOVE_INTERVAL_MS);
    // Start score update ticker (every 1s)
    startScoreInterval(gameId, boardPDA);
  }

  // ─── End game (called after 60s timer fires) ───────────────────────────────
  async function endGameSession(gameId: number, boardPDA: PublicKey): Promise<void> {
    stopAllIntervals();
    console.log(`\n[Timer] 60s elapsed → ending game session for gameId: ${gameId}`);
    try {
      const endTx = await programER.methods
        .endGameSession(new anchor.BN(gameId))
        .accountsPartial({
          treasury: treasuryPubkey,
          boardAccount: boardPDA,
          systemProgram: SystemProgram.programId,
        })
        .transaction();

      const erTxHash = await sendAndConfirmTransaction(
        connectionER,
        endTx,
        [treasuryKeypair],
        { skipPreflight: true, commitment: "confirmed" }
      );
      console.log(`  ER tx confirmed  → ER signature  : ${erTxHash}`);
      console.log(`  ER explorer      : https://explorer.magicblock.app/tx/${erTxHash}`);

      currentGameId = null;
      gameTimer = null;

      console.log(`  Waiting 5s for devnet commitment to propagate...`);
      await new Promise((r) => setTimeout(r, 5_000));

      await distributeRewards(gameId, boardPDA);
    } catch (err: any) {
      console.error(`  Error ending game ${gameId}:`, err.message ?? err);
      stopAllIntervals();
      currentGameId = null;
      gameTimer = null;
    }
  }

  async function distributeRewards(gameId: number, boardPDA: PublicKey, attempt = 1): Promise<void> {
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 30_000;
    console.log(`  [Rewards] Distributing rewards on devnet for gameId: ${gameId} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    try {
      const committedBoard = await program.account.board.fetch(boardPDA);
      const playerPubkeys = committedBoard.players
        .slice(0, committedBoard.playersCount)
        .map((p: any) => new PublicKey(p.player));
      console.log(`  [Rewards] Board state — isActive: ${committedBoard.isActive}, playersCount: ${committedBoard.playersCount}`);
      for (const p of committedBoard.players) {
        console.log(`    player=${new PublicKey(p.player).toBase58()} score=${p.score}`);
      }

      const rewardTx = await program.methods
        .distributeRewards(new anchor.BN(gameId))
        .accountsPartial({
          treasury: treasuryPubkey,
          boardAccount: boardPDA,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(
          playerPubkeys.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true }))
        )
        .transaction();

      const rewardTxHash = await sendAndConfirmTransaction(
        solanaConnection,
        rewardTx,
        [treasuryKeypair],
        { skipPreflight: true, commitment: "confirmed" }
      );
      console.log(`  [Rewards] Devnet tx confirmed → txHash: ${rewardTxHash}`);
      console.log(`\n========== Game ${gameId} completed successfully ==========\n`);
    } catch (err: any) {
      const msg = err.message ?? String(err);
      console.error(`  [Rewards] Attempt ${attempt} failed for gameId ${gameId}: ${msg}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`  [Rewards] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        setTimeout(() => distributeRewards(gameId, boardPDA, attempt + 1), RETRY_DELAY_MS);
      } else {
        console.error(`  [Rewards] All ${MAX_ATTEMPTS} attempts exhausted for gameId ${gameId}. Manual intervention needed.`);
      }
    }
  }

  // ─── Listen for GameStartedEvent on devnet ─────────────────────────────────
  // Uses base-layer program because register_player runs on devnet
  program.addEventListener("gameStartedEvent", async (event: any) => {
    const gameId = Number(event.gameId);
    console.log(`\n[Event] GameStartedEvent → gameId: ${gameId}`);

    if (currentGameId !== gameId) {
      console.log(`  Skipping: not our game (currentGameId=${currentGameId})`);
      return;
    }

    const [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, gameId);

    try {
      // Step 1: Delegate board to ER (devnet tx — board moves from devnet → ER)
      // Don't pass a specific validator — let it default to the same ER node
      // that hosts the ephemeral VRF oracle queue, avoiding "accounts delegated
      // to different ER nodes" errors when requestRandomness runs.
      const delegateTx = await program.methods
        .delegateBoard(new anchor.BN(gameId))
        .accountsPartial({
          treasurySigner: treasuryPubkey,
          boardAccount: boardPDA,
          pda: boardPDA,
          systemProgram: SystemProgram.programId,
        })
        .transaction();

      // delegateBoard is a devnet tx — send via solanaConnection
      const delegateTxHash = await sendAndConfirmTransaction(
        solanaConnection,
        delegateTx,
        [treasuryKeypair],
        { skipPreflight: true, commitment: "confirmed" }
      );
      console.log(`  Board delegated to ER → txHash: ${delegateTxHash}`);

      // Step 2: Start king move VRF interval (every 5s) and 60s game timer
      startKingMoveInterval(gameId, boardPDA);
      if (gameTimer) clearTimeout(gameTimer);
      gameTimer = setTimeout(() => endGameSession(gameId, boardPDA), GAME_DURATION_MS);
    } catch (err: any) {
      console.error(`  Error delegating board for gameId ${gameId}:`, err.message ?? err);
      stopAllIntervals();
      if (gameTimer) { clearTimeout(gameTimer); gameTimer = null; }
    }
  });

  // ─── Express API ───────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: Function) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  // GET / — health check
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      message: "King Tiles Relayer is running",
      currentGameId,
      treasury: treasuryPubkey.toBase58(),
      endpoints: {
        startSession: "POST /start-session  body: { gameId: number }",
        gameStatus: "GET /game-status",
      },
    });
  });

  // POST /start-session — relayer creates the board on devnet
  // Call this first, then run the test script to register players
  app.post("/start-session", async (req: Request, res: Response) => {
    try {
      if (currentGameId !== null) {
        res.status(400).json({
          ok: false,
          error: `Game already active (gameId: ${currentGameId}). Wait for it to end.`,
        });
        return;
      }

      const gameId = Number(req.body?.gameId ?? 0);
      const [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, gameId);
      console.log(`\n[/start-session] gameId=${gameId} boardPDA=${boardPDA.toBase58()}`);

      if (treasuryPubkey.toBase58() !== PROGRAM_TREASURY_PUBKEY) {
        res.status(400).json({
          ok: false,
          error: `Treasury key mismatch. Relayer treasury is ${treasuryPubkey.toBase58()} but the program expects ${PROGRAM_TREASURY_PUBKEY}. Set TREASURY_SECRET_BASE58 in .env to the private key for that address.`,
        });
        return;
      }

      // Board for this gameId already exists → init would fail with Custom 0
      try {
        await program.account.board.fetch(boardPDA);
        res.status(400).json({
          ok: false,
          error: `Board for gameId=${gameId} already exists. Use a new gameId (e.g. body: { "gameId": 1 }) or wait for the current game to end.`,
        });
        return;
      } catch (_) {
        // Account does not exist — OK to init
      }

      const tx = await program.methods
        .startGameSession(new anchor.BN(gameId))
        .accountsPartial({
          treasurySigner: treasuryPubkey,
          boardAccount: boardPDA,
          systemProgram: SystemProgram.programId,
        })
        .transaction();

      // startGameSession is a devnet tx — send via solanaConnection
      const txHash = await sendAndConfirmTransaction(
        solanaConnection,
        tx,
        [treasuryKeypair],
        { skipPreflight: true, commitment: "confirmed" }
      );
      console.log(`  Board initialized on devnet → txHash: ${txHash}`);

      currentGameId = gameId;

      res.json({
        ok: true,
        gameId,
        boardPDA: boardPDA.toBase58(),
        txHash,
        message:
          "Board created on devnet. Register 2 players via the test script. " +
          "Relayer will delegate the board and start a 60s timer automatically.",
      });
    } catch (error: any) {
      console.error("[/start-session] Error:", error.message ?? error);
      let detail = error.message ?? String(error);
      let logs: string[] | undefined;
      if (typeof error?.getLogs === "function") {
        try {
          logs = await error.getLogs(solanaConnection);
          detail = logs?.length ? `${detail}\n\nProgram logs:\n${logs.join("\n")}` : detail;
        } catch (_) {}
      } else if (Array.isArray(error?.logs)) {
        logs = error.logs;
        detail = `${detail}\n\nProgram logs:\n${(logs as string[]).join("\n")}`;
      }
      res.status(500).json({
        ok: false,
        error: detail,
        ...(logs && { logs }),
      });
    }
  });

  // GET /game-status — inspect current board state (tries ER first, falls back to devnet)
  app.get("/game-status", async (_req: Request, res: Response) => {
    if (currentGameId === null) {
      res.json({ ok: true, message: "No active game", currentGameId: null });
      return;
    }
    try {
      const [boardPDA] = getBoardPDA(
        treasuryPubkey,
        program.programId,
        currentGameId
      );

      let board: any;
      let source: string;
      const fetchEr = () => programER.account.board.fetch(boardPDA);
      const fetchWithRetry = async (attempts = 2) => {
        for (let i = 0; i < attempts; i++) {
          try {
            return await fetchEr();
          } catch (e) {
            if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300));
          }
        }
        throw new Error("ER fetch failed");
      };
      try {
        board = await fetchWithRetry();
        source = "ephemeral rollup";
      } catch {
        const devnetBoard = await program.account.board.fetch(boardPDA);
        if (devnetBoard.isActive) {
          // Game is active on ER; devnet state is stale (moves only apply on rollup). Retry ER.
          try {
            board = await fetchWithRetry(3);
            source = "ephemeral rollup";
          } catch (retryErr) {
            console.warn("[game-status] ER fetch failed for active game, returning 503");
            res.status(503).json({
              ok: false,
              error: "Rollup temporarily unavailable. Moves are on the rollup—retry in a moment.",
              currentGameId,
            });
            return;
          }
        } else {
          board = devnetBoard;
          source = "devnet";
        }
      }

      // Format flat 144-cell array as a 12×12 grid for readability
      // 0 = empty, 1 = player mark, 2 = king mark
      const COLS = 12;
      const flatBoard: number[] = Array.from(board.board);
      const boardGrid = Array.from({ length: COLS }, (_, row) =>
        flatBoard.slice(row * COLS, row * COLS + COLS)
      );

      const now = Math.floor(Date.now() / 1000);
      const gameEndTimestamp = Number(board.gameEndTimestamp);

      res.json({
        ok: true,
        source,
        currentGameId,
        boardPDA: boardPDA.toBase58(),
        playersCount: board.playersCount,
        isActive: board.isActive,
        gameEndTimestamp,
        secondsRemaining: board.isActive ? Math.max(0, gameEndTimestamp - now) : 0,
        players: board.players.map((p: any) => ({
          id: p.id,
          player: p.player.toBase58(),
          score: p.score.toString(),
          currentPosition: p.currentPosition,
        })),
        board: boardGrid,
        boardLegend: { 0: "empty", "1-4": "player id", 5: "king" },
      });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message ?? "Unknown error" });
    }
  });

  // POST /move — relayer submits move on ER using configured player keypair
  app.post("/move", async (req: Request, res: Response) => {
    try {
      if (currentGameId === null) {
        res.status(400).json({ ok: false, error: "No active game." });
        return;
      }

      const movePosition = Number(req.body?.movePosition);
      const payer = String(req.body?.payer ?? "");
      const playerId = Number(req.body?.playerId);

      if (!Number.isFinite(movePosition) || !Number.isFinite(playerId) || !payer) {
        res.status(400).json({
          ok: false,
          error: "Invalid body. Expected { movePosition: number, payer: string, playerId: number }",
        });
        return;
      }

      const playerKeypair = playerKeypairByPubkey.get(payer);
      if (!playerKeypair) {
        res.status(403).json({
          ok: false,
          error:
            "Relayer does not have this player keypair. Add it in .env as PLAYER_ONE_PRIVATE_KEY .. PLAYER_FOUR_PRIVATE_KEY.",
        });
        return;
      }

      const [boardPDA] = getBoardPDA(
        treasuryPubkey,
        program.programId,
        currentGameId
      );

      const tx = await programER.methods
        .makeMove(
          new anchor.BN(currentGameId),
          playerId,
          movePosition
        )
        .accountsPartial({
          treasury: treasuryPubkey,
          payer: playerKeypair.publicKey,
          boardAccount: boardPDA,
        })
        .transaction();

      const txHash = await sendAndConfirmTransaction(
        connectionER,
        tx,
        [playerKeypair],
        { skipPreflight: true, commitment: "confirmed" }
      );

      res.json({
        ok: true,
        txHash,
        gameId: currentGameId,
        boardPDA: boardPDA.toBase58(),
      });
    } catch (error: any) {
      const detail = error?.message ?? "Unknown error";
      res.status(500).json({ ok: false, error: detail });
    }
  });

  app.listen(PORT, async () => {
    console.log(`\nKing Tiles Relayer → http://localhost:${PORT}`);
    console.log(`Program  : ${program.programId.toBase58()}${programIdOverride ? " (env override)" : " (from target/idl)"}`);
    console.log(`Treasury : ${treasuryPubkey.toBase58()}`);
    console.log(`Players  : ${configuredPlayerKeypairs.length} relayed keys configured`);
    console.log(`Devnet   : ${solanaConnection.rpcEndpoint}`);
    console.log(`Magic ER : ${connectionER.rpcEndpoint}`);
    const balance = await solanaConnection.getBalance(treasuryPubkey);
    console.log(`Balance  : ${balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    console.log(`\nListening for GameStartedEvent on devnet...\n`);
  });
}

bootstrap().catch((err) => {
  console.error("Fatal relayer error:", err);
  process.exit(1);
});
