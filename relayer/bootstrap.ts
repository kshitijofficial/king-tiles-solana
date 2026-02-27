import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { sendAndConfirmTransaction, PublicKey, SystemProgram } from "@solana/web3.js";
import express, { Request, Response } from "express";

import { KingTiles } from "../target/types/king_tiles";
import {
  DEFAULT_DEVNET_RPC,
  DEFAULT_ER_ENDPOINT,
  DEFAULT_ER_WS_ENDPOINT,
  PORT,
  PROGRAM_TREASURY_PUBKEY,
  SOLSCAN_DEVNET_TX_BASE,
} from "./config";
import { getBoardPDA, toBoardStatusPayload } from "./board";
import { loadKeypair } from "./keypair";
import { sleep } from "./sleep";
import { CompletedGameSnapshot, TxTrace } from "./types";
import { fetchTopLeaderboard, upsertLeaderboardFromBoard } from "../db/leaderboard";

export async function bootstrapRelayer(): Promise<void> {
  const treasuryKeypair = loadKeypair(process.env.TREASURY_SECRET_BASE58);
  const treasuryPubkey = treasuryKeypair.publicKey;
  const configuredPlayerKeypairs = [
    process.env.PLAYER_ONE_PRIVATE_KEY,
    process.env.PLAYER_TWO_PRIVATE_KEY,
    process.env.PLAYER_THREE_PRIVATE_KEY,
    process.env.PLAYER_FOUR_PRIVATE_KEY,
    process.env.PLAYER_FIVE_PRIVATE_KEY,
    process.env.PLAYER_SIX_PRIVATE_KEY,
  ]
    .filter(Boolean)
    .map((k) => loadKeypair(k));
  const playerKeypairByPubkey = new Map(
    configuredPlayerKeypairs.map((kp) => [kp.publicKey.toBase58(), kp] as const)
  );

  // Base layer (devnet) â€” built directly from env vars, no Anchor CLI dependency
  const solanaConnection = new anchor.web3.Connection(
    process.env.RPC_URL || DEFAULT_DEVNET_RPC,
    "confirmed"
  );
  const provider = new anchor.AnchorProvider(
    solanaConnection,
    new anchor.Wallet(treasuryKeypair),
    { commitment: "confirmed" }
  );

  // Ephemeral Rollup â€” direct connection (used for VRF requests and game txs)
  const ER_ENDPOINT = process.env.ER_ENDPOINT || DEFAULT_ER_ENDPOINT;
  const ER_WS_ENDPOINT = process.env.ER_WS_ENDPOINT || DEFAULT_ER_WS_ENDPOINT;
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

  // ER program â€” uses direct connection to avoid router "different ER nodes" errors
  const providerER = new anchor.AnchorProvider(
    connectionER,
    new anchor.Wallet(treasuryKeypair)
  );
  const programER = new anchor.Program<KingTiles>(program.idl, providerER);

  // Oracle queue for VRF on the Ephemeral Rollup
  const EPHEMERAL_ORACLE_QUEUE = new PublicKey(
    "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"
  );
  const KING_MOVE_INTERVAL_MS = 5_000;
  const POWERUP_SPAWN_INTERVAL_MS = 7_000;
  const BOMB_DROP_INTERVAL_MS = 10_000;
  const GAME_DURATION_MS = 60_000;

  // â”€â”€â”€ Relayer state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  type SessionState = {
    gameId: number;
    boardPDA: PublicKey;
    boardSideLen: number;
    maxPlayers: number;
    registrationFeeLamports: number;
    lamportsPerScore: number;
    txTrace: TxTrace;
    gameTimer: NodeJS.Timeout | null;
    kingMoveInterval: NodeJS.Timeout | null;
    powerupSpawnInterval: NodeJS.Timeout | null;
    bombDropInterval: NodeJS.Timeout | null;
    scoreInterval: NodeJS.Timeout | null;
  };
  const sessions = new Map<number, SessionState>();
  const completedGames = new Map<number, CompletedGameSnapshot>();
  let lastCompletedGame: CompletedGameSnapshot | null = null;
  const sessionStartInFlight = new Set<number>();
  const sessionEndInFlight = new Set<number>();
  const gameStatusCache = new Map<number, { payload: Record<string, any>; cachedAtMs: number; ttlMs: number }>();
  const ACTIVE_STATUS_CACHE_TTL_MS = 400;
  const INACTIVE_STATUS_CACHE_TTL_MS = 1_500;
  const WATCHDOG_INTERVAL_MS = 5_000;

  const toCompletedModeKey = (
    snapshot: Pick<CompletedGameSnapshot, "boardSideLen" | "maxPlayers">
  ): string | null => {
    const boardSideLen = Number(snapshot.boardSideLen ?? Number.NaN);
    const maxPlayers = Number(snapshot.maxPlayers ?? Number.NaN);
    if (!Number.isFinite(boardSideLen) || !Number.isFinite(maxPlayers)) return null;
    return `${boardSideLen}x${maxPlayers}`;
  };

  const completedSnapshotRank = (
    snapshot: Pick<CompletedGameSnapshot, "completedAtIso" | "currentGameId">
  ): number => {
    const completedAtMs = Date.parse(snapshot.completedAtIso ?? "");
    if (Number.isFinite(completedAtMs)) return completedAtMs;
    const gameId = Number(snapshot.currentGameId ?? Number.NaN);
    return Number.isFinite(gameId) ? gameId : 0;
  };

  const upsertLatestCompletedByMode = (
    byMode: Record<string, CompletedGameSnapshot>,
    snapshot: CompletedGameSnapshot | null | undefined
  ): void => {
    if (!snapshot) return;
    const key = toCompletedModeKey(snapshot);
    if (!key) return;
    const existing = byMode[key];
    if (!existing || completedSnapshotRank(snapshot) >= completedSnapshotRank(existing)) {
      byMode[key] = snapshot;
    }
  };

  const buildLastCompletedByMode = (): Record<string, CompletedGameSnapshot> => {
    const byMode: Record<string, CompletedGameSnapshot> = {};
    for (const snapshot of completedGames.values()) {
      upsertLatestCompletedByMode(byMode, snapshot);
    }
    upsertLatestCompletedByMode(byMode, lastCompletedGame);
    return byMode;
  };

  const getCachedGameStatusPayload = (gameId: number): Record<string, any> | null => {
    const entry = gameStatusCache.get(gameId);
    if (!entry) return null;
    if (Date.now() - entry.cachedAtMs > entry.ttlMs) {
      gameStatusCache.delete(gameId);
      return null;
    }
    return entry.payload;
  };

  const setCachedGameStatusPayload = (gameId: number, payload: Record<string, any>): void => {
    const ttlMs = payload?.isActive ? ACTIVE_STATUS_CACHE_TTL_MS : INACTIVE_STATUS_CACHE_TTL_MS;
    gameStatusCache.set(gameId, {
      payload,
      cachedAtMs: Date.now(),
      ttlMs,
    });
  };

  const clearGameStatusCache = (gameId: number): void => {
    gameStatusCache.delete(gameId);
  };

  type DirectionArg = { up: {} } | { down: {} } | { left: {} } | { right: {} };
  const toDirectionArg = (offset: number, boardSideLen: number): DirectionArg | null => {
    if (offset === -1) return { left: {} };
    if (offset === 1) return { right: {} };
    if (offset === -boardSideLen) return { up: {} };
    if (offset === boardSideLen) return { down: {} };
    return null;
  };

  async function getChainNowSec(): Promise<number> {
    try {
      const slot = await solanaConnection.getSlot("processed");
      const blockTime = await solanaConnection.getBlockTime(slot);
      if (typeof blockTime === "number" && blockTime > 0) {
        return blockTime;
      }
    } catch {
      // Fallback below
    }
    return Math.floor(Date.now() / 1000);
  }

  function getRetryDelayMs(
    attempt: number,
    baseMs: number,
    maxMs: number,
    jitterRatio = 0.2
  ): number {
    const expDelay = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
    const jitter = Math.floor(expDelay * jitterRatio * Math.random());
    return expDelay + jitter;
  }

  // â”€â”€â”€ Update player score on the ER (called every 1s during game) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      console.error(
        `  [Score] updatePlayerScore failed for gameId ${gameId}:`,
        err.message ?? err
      );
    }
  }

  function stopScoreInterval(session: SessionState): void {
    if (session.scoreInterval) {
      clearInterval(session.scoreInterval);
      session.scoreInterval = null;
      console.log(`  [Score] Interval stopped for gameId=${session.gameId}.`);
    }
  }

  function startScoreInterval(session: SessionState): void {
    console.log(`  [Score] Starting score update interval every 1s...`);
    // Fire immediately, then every 1s
    updatePlayerScore(session.gameId, session.boardPDA);
    session.scoreInterval = setInterval(
      () => updatePlayerScore(session.gameId, session.boardPDA),
      1_000
    );
  }

  // â”€â”€â”€ Request king move randomness on the ER (called every 5s during game) â”€â”€
  async function requestKingMove(gameId: number, boardPDA: PublicKey): Promise<void> {
    try {
      const clientSeed = Math.floor(Math.random() * 256); // random u8
      const txHash = await programER.methods
        .requestRandomnessForKingMove(clientSeed, new anchor.BN(gameId))
        .accountsPartial({
          treasurySigner: treasuryPubkey,
          boardAccount: boardPDA,
          oracleQueue: EPHEMERAL_ORACLE_QUEUE,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`  [King] VRF request sent â†’ seed=${clientSeed} txHash=${txHash}`);
    } catch (err: any) {
      console.error(`  [King] VRF request failed for gameId ${gameId}:`, err.message ?? err);
    }
  }

  // â”€â”€â”€ Request powerup spawn randomness on the ER (called every 5s during game) â”€â”€
  async function requestPowerupSpawn(gameId: number, boardPDA: PublicKey): Promise<void> {
    try {
      const clientSeed = Math.floor(Math.random() * 256); // random u8
      const txHash = await programER.methods
        .requestRandomnessForPowerupMove(clientSeed, new anchor.BN(gameId))
        .accountsPartial({
          treasurySigner: treasuryPubkey,
          boardAccount: boardPDA,
          oracleQueue: EPHEMERAL_ORACLE_QUEUE,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`  [Powerup] VRF request sent â†’ seed=${clientSeed} txHash=${txHash}`);
    } catch (err: any) {
      console.error(`  [Powerup] VRF request failed for gameId ${gameId}:`, err.message ?? err);
    }
  }

  // â”€â”€â”€ Request bomb drop randomness on the ER (called every 10s during game) â”€â”€
  async function requestBombDrop(gameId: number, boardPDA: PublicKey): Promise<void> {
    try {
      const clientSeed = Math.floor(Math.random() * 256); // random u8
      const txHash = await programER.methods
        .requestRandomnessForBombDrop(clientSeed, new anchor.BN(gameId))
        .accountsPartial({
          treasurySigner: treasuryPubkey,
          boardAccount: boardPDA,
          oracleQueue: EPHEMERAL_ORACLE_QUEUE,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log(`  [Bomb] VRF request sent â†’ seed=${clientSeed} txHash=${txHash}`);
    } catch (err: any) {
      console.error(`  [Bomb] VRF request failed for gameId ${gameId}:`, err.message ?? err);
    }
  }

  function stopAllIntervals(session: SessionState, clearGameTimer = false): void {
    if (session.kingMoveInterval) {
      clearInterval(session.kingMoveInterval);
      session.kingMoveInterval = null;
      console.log(`  [King] Interval stopped for gameId=${session.gameId}.`);
    }
    if (session.powerupSpawnInterval) {
      clearInterval(session.powerupSpawnInterval);
      session.powerupSpawnInterval = null;
      console.log(`  [Powerup] Interval stopped for gameId=${session.gameId}.`);
    }
    if (session.bombDropInterval) {
      clearInterval(session.bombDropInterval);
      session.bombDropInterval = null;
      console.log(`  [Bomb] Interval stopped for gameId=${session.gameId}.`);
    }
    if (clearGameTimer && session.gameTimer) {
      clearTimeout(session.gameTimer);
      session.gameTimer = null;
    }
    stopScoreInterval(session);
  }

  function startKingMoveInterval(session: SessionState, gameDurationMs = GAME_DURATION_MS): void {
    stopAllIntervals(session, true);
    console.log(
      `  [King]   Starting VRF interval every ${KING_MOVE_INTERVAL_MS / 1000}s for gameId=${session.gameId}...`
    );
    console.log(
      `  [Powerup] Starting VRF interval every ${POWERUP_SPAWN_INTERVAL_MS / 1000}s...`
    );
    console.log(
      `  [Bomb]   Starting VRF interval every ${BOMB_DROP_INTERVAL_MS / 1000}s...`
    );

    // Fire king move immediately, then every 5s
    requestKingMove(session.gameId, session.boardPDA);
    session.kingMoveInterval = setInterval(
      () => requestKingMove(session.gameId, session.boardPDA),
      KING_MOVE_INTERVAL_MS
    );

    // Fire powerup spawn immediately, then every 5s
    requestPowerupSpawn(session.gameId, session.boardPDA);
    session.powerupSpawnInterval = setInterval(
      () => requestPowerupSpawn(session.gameId, session.boardPDA),
      POWERUP_SPAWN_INTERVAL_MS
    );

    // Fire bomb drop immediately, then every 10s
    requestBombDrop(session.gameId, session.boardPDA);
    session.bombDropInterval = setInterval(
      () => requestBombDrop(session.gameId, session.boardPDA),
      BOMB_DROP_INTERVAL_MS
    );

    // Start score update ticker (every 1s)
    startScoreInterval(session);
    session.gameTimer = setTimeout(
      () => void endGameSession(session),
      gameDurationMs
    );
  }

  async function recoverSessionsFromChain(): Promise<void> {
    console.log("\n[Recovery] Scanning chain for active boards...");
    try {
      const allBoards = await program.account.board.all();
      const nowSec = await getChainNowSec();
      let recovered = 0;

      for (const entry of allBoards) {
        const board = entry.account as any;
        const isActive = !!board?.isActive;
        const endTs = Number(board?.gameEndTimestamp ?? 0);
        const isWaitingForPlayers = !isActive && endTs === 0;
        if (!isActive && !isWaitingForPlayers) continue;
        const gameId = Number(board.gameId);
        if (!Number.isFinite(gameId)) continue;
        if (sessions.has(gameId)) continue;

        const session: SessionState = {
          gameId,
          boardPDA: entry.publicKey,
          boardSideLen: Number(board.boardSideLen),
          maxPlayers: Number(board.maxPlayers),
          registrationFeeLamports: Number(board.registrationFeeLamports),
          lamportsPerScore: Number(board.lamportsPerScore),
          txTrace: {},
          gameTimer: null,
          kingMoveInterval: null,
          powerupSpawnInterval: null,
          bombDropInterval: null,
          scoreInterval: null,
        };
        sessions.set(gameId, session);
        recovered += 1;

        const remainingMs = Math.max(0, (endTs - nowSec) * 1000);
        if (isWaitingForPlayers) {
          console.log(
            `  [Recovery] Restored waiting board gameId=${gameId} (${session.boardSideLen}x${session.boardSideLen}, players=${session.maxPlayers}).`
          );
        } else if (remainingMs > 0) {
          console.log(
            `  [Recovery] Restored gameId=${gameId} (${session.boardSideLen}x${session.boardSideLen}, players=${session.maxPlayers}) with ${Math.ceil(
              remainingMs / 1000
            )}s remaining.`
          );
          startKingMoveInterval(session, remainingMs);
        } else {
          console.log(
            `  [Recovery] Restored gameId=${gameId} already past end time; settling now.`
          );
          void endGameSession(session);
        }
      }

      console.log(`[Recovery] Completed. Recovered active sessions: ${recovered}.`);
    } catch (err: any) {
      console.error("[Recovery] Failed to recover sessions:", err?.message ?? err);
    }
  }

  function startSessionWatchdog(): void {
    setInterval(async () => {
      for (const session of sessions.values()) {
        if (session.gameTimer) continue;
        try {
          const board = (await program.account.board.fetch(session.boardPDA)) as any;
          if (board?.isActive) {
            await delegateAndStartSessionRuntime(session);
          }
        } catch {
          // board might be moved/closed/transiently unavailable
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  // â”€â”€â”€ End game (called after 60s timer fires) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function endGameSession(session: SessionState): Promise<void> {
    const { gameId, boardPDA } = session;
    if (sessionEndInFlight.has(gameId)) {
      console.log(`  [Timer] endGameSession already in-flight for gameId=${gameId}; skipping duplicate call.`);
      return;
    }
    sessionEndInFlight.add(gameId);
    stopAllIntervals(session, true);
    console.log(`\n[Timer] 60s elapsed -> ending game session for gameId: ${gameId}`);
    try {
      // Guard against local clock skew: don't settle before chain end timestamp.
      try {
        const committedBoard = (await program.account.board.fetch(boardPDA)) as any;
        const chainNowSec = await getChainNowSec();
        const endTs = Number(committedBoard?.gameEndTimestamp ?? 0);
        if (endTs > 0 && chainNowSec < endTs) {
          const remainingMs = Math.max(0, (endTs - chainNowSec) * 1000);
          console.log(
            `  [Timer] gameId=${gameId} not over on-chain yet (${Math.ceil(
              remainingMs / 1000
            )}s left). Resuming runtime.`
          );
          startKingMoveInterval(session, remainingMs);
          return;
        }
      } catch (guardErr: any) {
        console.warn(
          `  [Timer] Could not read chain end timestamp for gameId=${gameId}; proceeding with end attempt:`,
          guardErr?.message ?? guardErr
        );
      }

      const endTx = await programER.methods
        .endGameSession(new anchor.BN(gameId))
        .accountsPartial({
          treasury: treasuryPubkey,
          boardAccount: boardPDA,
          systemProgram: SystemProgram.programId,
        })
        .transaction();

      const erTxHash = await sendAndConfirmTransaction(connectionER, endTx, [treasuryKeypair], {
        skipPreflight: true,
        commitment: "confirmed",
      });
      console.log(`  ER tx confirmed  â†’ ER signature  : ${erTxHash}`);
      console.log(`  ER explorer      : https://explorer.magicblock.app/tx/${erTxHash}`);
      const endPhaseTxTrace: TxTrace = {
        ...session.txTrace,
        endSessionTxHash: erTxHash,
      };
      session.txTrace = endPhaseTxTrace;

      console.log(`  Waiting 5s for devnet commitment to propagate...`);
      await sleep(5_000);
      try {
        const postEndBoard = await program.account.board.fetch(boardPDA);
        const snapshot: CompletedGameSnapshot = {
          ...toBoardStatusPayload(postEndBoard, gameId, boardPDA, "devnet"),
          completedAtIso: new Date().toISOString(),
          txTrace: endPhaseTxTrace,
        };
        completedGames.set(gameId, snapshot);
        lastCompletedGame = snapshot;
        clearGameStatusCache(gameId);
        try {
          await upsertLeaderboardFromBoard(gameId, postEndBoard);
        } catch (leaderboardError: any) {
          console.error(
            "  [Leaderboard] Failed to sync game results:",
            leaderboardError?.message ?? leaderboardError
          );
        }
      } catch (snapshotErr: any) {
        console.warn(
          "  [Snapshot] Unable to capture post-end board:",
          snapshotErr?.message ?? snapshotErr
        );
      }
      sessions.delete(gameId);
      await distributeRewards(gameId, boardPDA, endPhaseTxTrace, session);
    } catch (err: any) {
      console.error(`  Error ending game ${gameId}:`, err.message ?? err);
      stopAllIntervals(session, true);
      sessions.delete(gameId);
    } finally {
      sessionEndInFlight.delete(gameId);
    }
  }

  async function distributeRewards(
    gameId: number,
    boardPDA: PublicKey,
    txTrace: TxTrace,
    session: SessionState | undefined,
    attempt = 1
  ): Promise<void> {
    const MAX_ATTEMPTS = 10;
    const RETRY_BASE_DELAY_MS = 12_000;
    const RETRY_MAX_DELAY_MS = 60_000;
    const OWNER_RETRY_BASE_DELAY_MS = 6_000;
    const OWNER_RETRY_MAX_DELAY_MS = 30_000;
    console.log(
      `  [Rewards] Distributing rewards on devnet for gameId: ${gameId} (attempt ${attempt}/${MAX_ATTEMPTS})`
    );
    try {
      const boardAccountInfo = await solanaConnection.getAccountInfo(boardPDA, "confirmed");
      if (!boardAccountInfo) {
        throw new Error(`Board account missing on devnet for gameId=${gameId}`);
      }
      if (!boardAccountInfo.owner.equals(program.programId)) {
        const owner = boardAccountInfo.owner.toBase58();
        console.warn(
          `  [Rewards] board_account owner mismatch for gameId=${gameId}. Owner=${owner}, expected=${program.programId.toBase58()}. Retrying with exponential backoff...`
        );

        // Best-effort finalize from ER: if the board is still delegated on devnet,
        // trigger end_game_session on ER to commit+undelegate back to base layer.
        try {
          const finalizeTx = await programER.methods
            .endGameSession(new anchor.BN(gameId))
            .accountsPartial({
              treasury: treasuryPubkey,
              boardAccount: boardPDA,
              systemProgram: SystemProgram.programId,
            })
            .transaction();
          const finalizeTxHash = await sendAndConfirmTransaction(
            connectionER,
            finalizeTx,
            [treasuryKeypair],
            { skipPreflight: true, commitment: "confirmed" }
          );
          console.log(
            `  [Rewards] Triggered ER finalize for delegated board -> gameId=${gameId} txHash=${finalizeTxHash}`
          );
          await sleep(5_000);
        } catch (finalizeErr: any) {
          const finalizeMsg = finalizeErr?.message ?? String(finalizeErr);
          console.warn(
            `  [Rewards] ER finalize attempt failed for gameId=${gameId}: ${finalizeMsg}`
          );
          try {
            let logs: string[] | undefined;
            if (typeof finalizeErr?.getLogs === "function") {
              logs = await finalizeErr.getLogs(connectionER);
            } else if (Array.isArray(finalizeErr?.logs)) {
              logs = finalizeErr.logs as string[];
            }
            if (logs?.length) {
              console.warn(
                `  [Rewards] ER finalize logs for gameId ${gameId}:\n${logs.join("\n")}`
              );
            }
          } catch {
            // best effort only
          }
        }

        if (attempt < MAX_ATTEMPTS) {
          const ownerRetryDelayMs = getRetryDelayMs(
            attempt,
            OWNER_RETRY_BASE_DELAY_MS,
            OWNER_RETRY_MAX_DELAY_MS
          );
          console.log(
            `  [Rewards] Owner mismatch retry scheduled in ${Math.ceil(ownerRetryDelayMs / 1000)}s (attempt ${
              attempt + 1
            }/${MAX_ATTEMPTS}).`
          );
          setTimeout(
            () => distributeRewards(gameId, boardPDA, txTrace, session, attempt + 1),
            ownerRetryDelayMs
          );
          return;
        }
        throw new Error(
          `board_account owner mismatch persisted after ${MAX_ATTEMPTS} attempts: owner=${owner}, expected=${program.programId.toBase58()}`
        );
      }

      const committedBoard = await program.account.board.fetch(boardPDA);
      const chainNowSec = await getChainNowSec();
      const endTs = Number(committedBoard?.gameEndTimestamp ?? 0);
      if (endTs > 0 && chainNowSec < endTs) {
        const waitMs = Math.max(2_000, (endTs - chainNowSec) * 1000 + 500);
        console.log(
          `  [Rewards] gameId=${gameId} not over on-chain yet. Waiting ${Math.ceil(
            waitMs / 1000
          )}s before retry.`
        );
        setTimeout(
          () => distributeRewards(gameId, boardPDA, txTrace, session, attempt),
          waitMs
        );
        return;
      }
      const playerPubkeys = committedBoard.players
        .slice(0, committedBoard.playersCount)
        .map((p: any) => new PublicKey(p.player));
      console.log(
        `  [Rewards] Board state â€” isActive: ${committedBoard.isActive}, playersCount: ${committedBoard.playersCount}`
      );
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
          playerPubkeys.map((pk) => ({
            pubkey: pk,
            isSigner: false,
            isWritable: true,
          }))
        )
        .transaction();

      const rewardTxHash = await sendAndConfirmTransaction(
        solanaConnection,
        rewardTx,
        [treasuryKeypair],
        { skipPreflight: true, commitment: "confirmed" }
      );
      const rewardTxSolscanUrl = `${SOLSCAN_DEVNET_TX_BASE}/${rewardTxHash}?cluster=devnet`;
      console.log(`  [Rewards] Devnet tx confirmed â†’ txHash: ${rewardTxHash}`);
      console.log(`  [Rewards] Solscan             â†’ ${rewardTxSolscanUrl}`);
      const finalizedBoard = await program.account.board.fetch(boardPDA);
      const finalizedTxTrace: TxTrace = {
        ...txTrace,
        rewardTxHash,
        rewardTxSolscanUrl,
        rewardError: undefined,
      };
      if (session) {
        session.txTrace = finalizedTxTrace;
      }
      const snapshot: CompletedGameSnapshot = {
        ...toBoardStatusPayload(finalizedBoard, gameId, boardPDA, "devnet"),
        completedAtIso: new Date().toISOString(),
        txTrace: finalizedTxTrace,
      };
      completedGames.set(gameId, snapshot);
      lastCompletedGame = snapshot;
      clearGameStatusCache(gameId);
      console.log(`\n========== Game ${gameId} completed successfully ==========\n`);
    } catch (err: any) {
      const msg = err.message ?? String(err);
      console.error(`  [Rewards] Attempt ${attempt} failed for gameId ${gameId}: ${msg}`);
      try {
        let logs: string[] | undefined;
        if (typeof err?.getLogs === "function") {
          logs = await err.getLogs(solanaConnection);
        } else if (Array.isArray(err?.logs)) {
          logs = err.logs as string[];
        }
        if (logs?.length) {
          console.error(`  [Rewards] Program logs for gameId ${gameId}:\n${logs.join("\n")}`);
        }
      } catch (logsErr: any) {
        console.error(
          `  [Rewards] Unable to fetch transaction logs for gameId ${gameId}:`,
          logsErr?.message ?? logsErr
        );
      }
      if (attempt < MAX_ATTEMPTS) {
        const retryDelayMs = getRetryDelayMs(attempt, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS);
        console.log(
          `  [Rewards] Retrying in ${Math.ceil(retryDelayMs / 1000)}s (attempt ${
            attempt + 1
          }/${MAX_ATTEMPTS})...`
        );
        setTimeout(
          () => distributeRewards(gameId, boardPDA, txTrace, session, attempt + 1),
          retryDelayMs
        );
      } else {
        console.error(
          `  [Rewards] All ${MAX_ATTEMPTS} attempts exhausted for gameId ${gameId}. Manual intervention needed.`
        );
        const existing = completedGames.get(gameId);
        if (existing) {
          const failedSnapshot: CompletedGameSnapshot = {
            ...existing,
            txTrace: {
              ...existing.txTrace,
              rewardError: msg,
            },
          };
          completedGames.set(gameId, failedSnapshot);
          lastCompletedGame = failedSnapshot;
          clearGameStatusCache(gameId);
        }
      }
    }
  }

  async function delegateAndStartSessionRuntime(session: SessionState): Promise<void> {
    if (session.gameTimer || sessionStartInFlight.has(session.gameId)) return;
    sessionStartInFlight.add(session.gameId);
    try {
      const gameId = session.gameId;
      const boardPDA = session.boardPDA;
      const boardInfo = await solanaConnection.getAccountInfo(boardPDA, "confirmed");
      const alreadyDelegated = !!boardInfo && !boardInfo.owner.equals(program.programId);

      if (!alreadyDelegated) {
        const delegateTx = await program.methods
          .delegateBoard(new anchor.BN(gameId))
          .accountsPartial({
            treasurySigner: treasuryPubkey,
            boardAccount: boardPDA,
            pda: boardPDA,
            systemProgram: SystemProgram.programId,
          })
          .transaction();

        const delegateTxHash = await sendAndConfirmTransaction(
          solanaConnection,
          delegateTx,
          [treasuryKeypair],
          { skipPreflight: true, commitment: "confirmed" }
        );
        session.txTrace = {
          ...session.txTrace,
          delegateBoardTxHash: delegateTxHash,
        };
        console.log(`  Board delegated to ER -> gameId=${gameId} txHash=${delegateTxHash}`);
      } else {
        console.log(
          `  Board already delegated for gameId=${gameId} (owner=${boardInfo?.owner.toBase58()}); skipping delegate call.`
        );
      }
      let remainingMs = GAME_DURATION_MS;
      try {
        const committedBoard = (await program.account.board.fetch(boardPDA)) as any;
        const endTs = Number(committedBoard?.gameEndTimestamp ?? 0);
        const nowSec = await getChainNowSec();
        remainingMs = Math.max(0, (endTs - nowSec) * 1000);
      } catch (timingErr: any) {
        console.warn(
          `  [Timer] Could not fetch game end timestamp for gameId=${gameId}; falling back to ${GAME_DURATION_MS}ms:`,
          timingErr?.message ?? timingErr
        );
      }

      if (remainingMs <= 0) {
        console.log(`  [Timer] gameId=${gameId} already elapsed on-chain; settling immediately.`);
        await endGameSession(session);
        return;
      }

      console.log(`  [Timer] Starting runtime for gameId=${gameId} with ${Math.ceil(remainingMs / 1000)}s remaining.`);
      startKingMoveInterval(session, remainingMs);
    } catch (err: any) {
      console.error(
        `  Error delegating/starting runtime for gameId ${session.gameId}:`,
        err?.message ?? err
      );
      try {
        let logs: string[] | undefined;
        if (typeof err?.getLogs === "function") {
          logs = await err.getLogs(solanaConnection);
        } else if (Array.isArray(err?.logs)) {
          logs = err.logs as string[];
        }
        if (logs?.length) {
          console.error(
            `  [Delegate/Start] Program logs for gameId ${session.gameId}:\n${logs.join("\n")}`
          );
        }
      } catch {
        // best effort only
      }
      stopAllIntervals(session, true);
    } finally {
      sessionStartInFlight.delete(session.gameId);
    }
  }

  // â”€â”€â”€ Listen for GameStartedEvent on devnet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Uses base-layer program because register_player runs on devnet
  program.addEventListener("gameStartedEvent", async (event: any) => {
    const gameId = Number(event.gameId);
    console.log(`\n[Event] GameStartedEvent -> gameId: ${gameId}`);

    const session = sessions.get(gameId);
    if (!session) {
      console.log(`  Skipping: gameId ${gameId} is not tracked by this relayer session map.`);
      return;
    }
    await delegateAndStartSessionRuntime(session);
  });

  // â”€â”€â”€ Express API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: Function) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  // GET / â€” health check
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      message: "King Tiles Relayer is running",
      activeGameIds: Array.from(sessions.keys()),
      treasury: treasuryPubkey.toBase58(),
      endpoints: {
        startSession:
          "POST /start-session  body: { gameId, boardSideLen, maxPlayers, registrationFeeLamports, lamportsPerScore }",
        gameStatus: "GET /game-status?gameId=<number>",
        retryRewards: "POST /retry-rewards body: { gameId }",
      },
    });
  });

  // GET /games — list currently tracked active sessions with config
  app.get("/games", async (_req: Request, res: Response) => {
    try {
      const activeGames = await Promise.all(
        Array.from(sessions.values()).map(async (s) => {
          let isActive = false;
          let playersCount = 0;
          let gameEndTimestamp = 0;
          try {
            const board = (await program.account.board.fetch(s.boardPDA)) as any;
            isActive = !!board?.isActive;
            playersCount = Number(board?.playersCount ?? 0);
            gameEndTimestamp = Number(board?.gameEndTimestamp ?? 0);
          } catch {
            // Keep session metadata even if fetch transiently fails.
          }
          return {
            gameId: s.gameId,
            boardPDA: s.boardPDA.toBase58(),
            boardSideLen: s.boardSideLen,
            maxPlayers: s.maxPlayers,
            registrationFeeLamports: s.registrationFeeLamports,
            lamportsPerScore: s.lamportsPerScore,
            isActive,
            playersCount,
            gameEndTimestamp,
          };
        })
      );

      activeGames.sort((a, b) => a.gameId - b.gameId);
      const lastCompletedByMode = buildLastCompletedByMode();

      res.json({
        ok: true,
        activeGames,
        activeGameIds: activeGames.map((g) => g.gameId),
        lastCompletedGame,
        lastCompletedByMode,
      });
    } catch (error: any) {
      res.status(500).json({
        ok: false,
        error: error?.message ?? "Unable to list games",
      });
    }
  });

  // GET /leaderboard - top players from DB read-model
  app.get("/leaderboard", async (_req: Request, res: Response) => {
    try {
      const leaderboard = await fetchTopLeaderboard(5);
      res.json({
        ok: true,
        leaderboard,
      });
    } catch (error: any) {
      res.status(500).json({
        ok: false,
        error: error?.message ?? "Unable to fetch leaderboard",
      });
    }
  });

  // POST /start-session â€” relayer creates the board on devnet
  // Call this first, then run the test script to register players
  app.post("/start-session", async (req: Request, res: Response) => {
    try {
      const gameId = Number(req.body?.gameId ?? 0);
      const boardSideLen = Number(req.body?.boardSideLen ?? 12);
      const maxPlayers = Number(req.body?.maxPlayers ?? 6);
      const registrationFeeLamports = Number(req.body?.registrationFeeLamports ?? 1_000_000);
      const lamportsPerScore = Number(req.body?.lamportsPerScore ?? 29_000);

      const validMode =
        (boardSideLen === 8 && maxPlayers === 2) ||
        (boardSideLen === 10 && maxPlayers === 4) ||
        (boardSideLen === 12 && maxPlayers === 6);
      if (!validMode) {
        res.status(400).json({
          ok: false,
          error:
            "Invalid mode. Supported combinations are: 8x8/2 players, 10x10/4 players, 12x12/6 players.",
        });
        return;
      }

      if (
        !Number.isFinite(registrationFeeLamports) ||
        !Number.isFinite(lamportsPerScore) ||
        registrationFeeLamports <= 0 ||
        lamportsPerScore <= 0
      ) {
        res.status(400).json({
          ok: false,
          error: "registrationFeeLamports and lamportsPerScore must be positive numbers.",
        });
        return;
      }

      const [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, gameId);
      console.log(`\n[/start-session] gameId=${gameId} boardPDA=${boardPDA.toBase58()}`);

      if (treasuryPubkey.toBase58() !== PROGRAM_TREASURY_PUBKEY) {
        res.status(400).json({
          ok: false,
          error: `Treasury key mismatch. Relayer treasury is ${treasuryPubkey.toBase58()} but the program expects ${PROGRAM_TREASURY_PUBKEY}. Set TREASURY_SECRET_BASE58 in .env to the private key for that address.`,
        });
        return;
      }

      // Board for this gameId already exists â†’ init would fail with Custom 0
      try {
        await program.account.board.fetch(boardPDA);
        res.status(400).json({
          ok: false,
          error: `Board for gameId=${gameId} already exists. Use a new gameId (e.g. body: { "gameId": 1 }) or wait for the current game to end.`,
        });
        return;
      } catch (_) {
        // Account does not exist â€” OK to init
      }

      const tx = await (program.methods as any)
        .startGameSession(
          new anchor.BN(gameId),
          boardSideLen,
          maxPlayers,
          new anchor.BN(registrationFeeLamports),
          new anchor.BN(lamportsPerScore)
        )
        .accountsPartial({
          treasurySigner: treasuryPubkey,
          boardAccount: boardPDA,
          systemProgram: SystemProgram.programId,
        })
        .transaction();

      // startGameSession is a devnet tx â€” send via solanaConnection
      const txHash = await sendAndConfirmTransaction(solanaConnection, tx, [treasuryKeypair], {
        skipPreflight: true,
        commitment: "confirmed",
      });
      console.log(`  Board initialized on devnet â†’ txHash: ${txHash}`);

      sessions.set(gameId, {
        gameId,
        boardPDA,
        boardSideLen,
        maxPlayers,
        registrationFeeLamports,
        lamportsPerScore,
        txTrace: {
          startSessionTxHash: txHash,
        },
        gameTimer: null,
        kingMoveInterval: null,
        powerupSpawnInterval: null,
        bombDropInterval: null,
        scoreInterval: null,
      });
      clearGameStatusCache(gameId);

      res.json({
        ok: true,
        gameId,
        boardPDA: boardPDA.toBase58(),
        txHash,
        message:
          `Board created on devnet (${boardSideLen}x${boardSideLen}, ${maxPlayers} players). ` +
          "Relayer will delegate this board and start its 60s timer when full.",
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

  // GET /game-status?gameId=<n> — inspect current board state (tries ER first, falls back to devnet)
  app.get("/game-status", async (req: Request, res: Response) => {
    const requestedRaw = req.query?.gameId;
    const requestedGameId =
      requestedRaw !== undefined ? Number(requestedRaw) : Number.NaN;

    let gameId: number | null = null;
    if (Number.isFinite(requestedGameId)) {
      gameId = requestedGameId;
    } else if (sessions.size > 0) {
      gameId = Array.from(sessions.keys()).sort((a, b) => a - b)[0];
    }

    if (gameId === null) {
      res.json({
        ok: true,
        message: "No active game",
        currentGameId: null,
        activeGameIds: Array.from(sessions.keys()),
        lastCompletedGame,
      });
      return;
    }

    // If this game is no longer tracked as active, prefer cached completion
    // data and avoid hammering RPC endpoints with repeated historical reads.
    if (!sessions.has(gameId)) {
      const cachedCompleted =
        completedGames.get(gameId) ??
        (lastCompletedGame && Number(lastCompletedGame.currentGameId) === gameId
          ? lastCompletedGame
          : null);

      if (cachedCompleted) {
        const responsePayload = {
          ok: true,
          ...cachedCompleted,
          activeGameIds: Array.from(sessions.keys()),
          lastCompletedGame: cachedCompleted,
        };
        setCachedGameStatusPayload(gameId, responsePayload);
        res.json(responsePayload);
        return;
      }
    }

    const cachedPayload = getCachedGameStatusPayload(gameId);
    if (cachedPayload) {
      res.json(cachedPayload);
      return;
    }

    try {
      const [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, gameId);
      let board: any;
      let source: string;
      const fetchEr = () => programER.account.board.fetch(boardPDA);
      const fetchWithRetry = async (attempts = 2) => {
        for (let i = 0; i < attempts; i++) {
          try {
            return await fetchEr();
          } catch {
            if (i < attempts - 1) await sleep(300);
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
          try {
            board = await fetchWithRetry(3);
            source = "ephemeral rollup";
          } catch {
            console.warn("[game-status] ER fetch failed for active game, returning 503");
            res.status(503).json({
              ok: false,
              error:
                "Rollup temporarily unavailable. Moves are on the rollup—retry in a moment.",
              currentGameId: gameId,
            });
            return;
          }
        } else {
          board = devnetBoard;
          source = "devnet";
        }
      }

      const payload = toBoardStatusPayload(board, gameId, boardPDA, source);
      const responsePayload = {
        ok: true,
        ...payload,
        activeGameIds: Array.from(sessions.keys()),
        lastCompletedGame: completedGames.get(gameId) ?? lastCompletedGame ?? null,
      };
      setCachedGameStatusPayload(gameId, responsePayload);
      res.json(responsePayload);
    } catch (error: any) {
      const msg = error?.message ?? "Unknown error";
      if (
        msg.includes("Account does not exist") ||
        msg.includes("could not find account")
      ) {
        const responsePayload = {
          ok: true,
          message: `No board found for gameId ${gameId}`,
          currentGameId: null,
          activeGameIds: Array.from(sessions.keys()),
          lastCompletedGame: completedGames.get(gameId) ?? lastCompletedGame ?? null,
        };
        setCachedGameStatusPayload(gameId, responsePayload);
        res.json(responsePayload);
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // POST /move â€” relayer submits move on ER using configured player keypair
  app.post("/move", async (req: Request, res: Response) => {
    try {
      const gameId = Number(req.body?.gameId);
      if (!Number.isFinite(gameId)) {
        res.status(400).json({ ok: false, error: "Invalid body. Expected gameId: number." });
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
            "Relayer does not have this player keypair. Add it in .env as PLAYER_ONE_PRIVATE_KEY .. PLAYER_SIX_PRIVATE_KEY.",
        });
        return;
      }

      const [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, gameId);
      const board = (await programER.account.board.fetch(boardPDA)) as any;
      const boardSideLen = Number(board.boardSideLen);
      const direction = toDirectionArg(movePosition, boardSideLen);
      if (!direction) {
        res.status(400).json({
          ok: false,
          error: `Invalid movePosition for this board. Use Â±1 or Â±${boardSideLen}.`,
        });
        return;
      }

      const tx = await (programER.methods as any)
        .makeMove(new anchor.BN(gameId), playerId, direction)
        .accountsPartial({
          treasury: treasuryPubkey,
          payer: playerKeypair.publicKey,
          boardAccount: boardPDA,
        })
        .transaction();

      const txHash = await sendAndConfirmTransaction(connectionER, tx, [playerKeypair], {
        skipPreflight: true,
        commitment: "confirmed",
      });

      res.json({
        ok: true,
        txHash,
        gameId,
        boardPDA: boardPDA.toBase58(),
      });
    } catch (error: any) {
      const detail = error?.message ?? "Unknown error";
      res.status(500).json({ ok: false, error: detail });
    }
  });

  // POST /use-power - relayer fires use_power on ER using treasury keypair (required signer)
  app.post("/use-power", async (req: Request, res: Response) => {
    try {
      const gameId = Number(req.body?.gameId);
      if (!Number.isFinite(gameId)) {
        res.status(400).json({ ok: false, error: "Invalid body. Expected gameId: number." });
        return;
      }

      const playerId = Number(req.body?.playerId);
      const directionOffset = Number(req.body?.direction);

      if (!Number.isFinite(playerId) || !Number.isFinite(directionOffset)) {
        res.status(400).json({
          ok: false,
          error: "Invalid body. Expected { playerId: number, direction: number }",
        });
        return;
      }

      const [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, gameId);
      const board = (await programER.account.board.fetch(boardPDA)) as any;
      const boardSideLen = Number(board.boardSideLen);
      const direction = toDirectionArg(directionOffset, boardSideLen);
      if (!direction) {
        res.status(400).json({
          ok: false,
          error: `Invalid direction for this board. Use ±1 or ±${boardSideLen}.`,
        });
        return;
      }

      const txHash = await (programER.methods as any)
        .usePower(new anchor.BN(gameId), playerId, direction)
        .accountsPartial({
          treasury: treasuryPubkey,
          boardAccount: boardPDA,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      console.log(
        `  [Power] usePower fired -> playerId=${playerId} dir=${directionOffset} txHash=${txHash}`
      );
      res.json({ ok: true, txHash, gameId });
    } catch (error: any) {
      const detail = error?.message ?? "Unknown error";
      console.error("[/use-power] Error:", detail);
      res.status(500).json({ ok: false, error: detail });
    }
  });

  // POST /retry-rewards - manually retry distribute_rewards for an ended game
  app.post("/retry-rewards", async (req: Request, res: Response) => {
    try {
      const gameId = Number(req.body?.gameId);
      if (!Number.isFinite(gameId)) {
        res.status(400).json({ ok: false, error: "Invalid body. Expected gameId: number." });
        return;
      }

      const [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, gameId);
      const board = (await program.account.board.fetch(boardPDA)) as any;
      if (board?.isActive) {
        res.status(400).json({
          ok: false,
          error: `Game ${gameId} is still active. Retry rewards only after game end.`,
        });
        return;
      }

      const existingSnapshot = completedGames.get(gameId);
      const baseTrace: TxTrace = existingSnapshot?.txTrace ?? {};
      void distributeRewards(gameId, boardPDA, baseTrace, sessions.get(gameId), 1);

      res.json({
        ok: true,
        gameId,
        boardPDA: boardPDA.toBase58(),
        message: "Reward retry triggered. Check relayer logs for attempt progress.",
      });
    } catch (error: any) {
      const detail = error?.message ?? "Unknown error";
      res.status(500).json({ ok: false, error: detail });
    }
  });
  await recoverSessionsFromChain();
  startSessionWatchdog();

  app.listen(PORT, async () => {
    console.log(`\nKing Tiles Relayer â†’ http://localhost:${PORT}`);
    console.log(
      `Program  : ${program.programId.toBase58()}${
        programIdOverride ? " (env override)" : " (from target/idl)"
      }`
    );
    console.log(`Treasury : ${treasuryPubkey.toBase58()}`);
    console.log(`Players  : ${configuredPlayerKeypairs.length} relayed keys configured`);
    console.log(`Devnet   : ${solanaConnection.rpcEndpoint}`);
    console.log(`Magic ER : ${connectionER.rpcEndpoint}`);
    const balance = await solanaConnection.getBalance(treasuryPubkey);
    console.log(`Balance  : ${balance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
    console.log(`\nListening for GameStartedEvent on devnet...\n`);
  });
}

