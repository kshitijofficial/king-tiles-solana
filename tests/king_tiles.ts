import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(process.cwd(), ".env") });

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KingTiles } from "../target/types/king_tiles";
import {
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { assert } from "chai";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";

// ── Constants mirrored from lib.rs ───────────────────────────────────────────
const LAMPORTS_PER_SCORE = 29_000;
const REGISTRATION_FEE_LAMPORTS = 1_000_000;
const KING_MARK = 5;
const BOARD_SIZE = 144;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ─────────────────────────────────────────────────────────────────────────────

const anchorProvider = anchor.AnchorProvider.env();
const isLocalnet =
  anchorProvider.connection.rpcEndpoint.includes("localhost") ||
  anchorProvider.connection.rpcEndpoint.includes("127.0.0.1");

if (isLocalnet) {
  console.log(
    "Skipping King Tiles Magic Block test suite because it's running on localnet"
  );
}

const testSuite = isLocalnet ? describe.skip : describe;

function loadKeypair(privateKeyBase58?: string): Keypair {
  if (!privateKeyBase58) {
    throw new Error(
      "Missing private key in env. Set TREASURY_SECRET_BASE58 and PLAYER_*_PRIVATE_KEY for tests."
    );
  }
  try {
    const privateKeyBytes = bs58.decode(privateKeyBase58);
    if (privateKeyBytes.length === 32) {
      return Keypair.fromSeed(privateKeyBytes);
    } else if (privateKeyBytes.length === 64) {
      return Keypair.fromSecretKey(privateKeyBytes);
    } else {
      throw new Error(
        `Invalid private key length: ${privateKeyBytes.length}. Expected 32 or 64 bytes.`
      );
    }
  } catch (error) {
    console.error("Error loading private key:", error);
    throw new Error(
      "Failed to load private key. Make sure it's in base58 format."
    );
  }
}

function getBoardPDA(
  treasuryPubkey: PublicKey,
  programId: anchor.web3.PublicKey,
  gameId: number
): [anchor.web3.PublicKey, number] {
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

testSuite("King Tiles - Magic Block (Ephemeral Rollups)", () => {
  const connection = new ConnectionMagicRouter(
    process.env.ROUTER_ENDPOINT || "https://devnet-router.magicblock.app/",
    {
      wsEndpoint:
        process.env.WS_ROUTER_ENDPOINT ||
        "wss://devnet-router.magicblock.app/",
    }
  );

  const treasuryKeypair = loadKeypair(process.env.TREASURY_SECRET_BASE58);
  const treasuryPubkey = treasuryKeypair.publicKey;
  const providerMagic = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(treasuryKeypair)
  );
  const provider = anchor.AnchorProvider.env();
  const solanaConnection = provider.connection;

  anchor.setProvider(provider);
  const program = anchor.workspace.kingTiles as Program<KingTiles>;

  const programER = new anchor.Program<KingTiles>(
    program.idl,
    providerMagic
  );

  const GAME_ID = 0;

  let playerKeypairs: Keypair[] = [];
  let boardPDA: PublicKey;
  let playerBalancesBeforeEnd: number[] = [];

  before(async function () {
    console.log("Router endpoint:", connection.rpcEndpoint?.toString?.() ?? connection.rpcEndpoint);
    const balance = await solanaConnection.getBalance(treasuryPubkey);
    console.log("Treasury balance:", balance / LAMPORTS_PER_SOL, "SOL\n");

    [boardPDA] = getBoardPDA(treasuryPubkey, program.programId, GAME_ID);
    console.log("Board PDA:", boardPDA.toBase58());

    playerKeypairs = [
      process.env.PLAYER_ONE_PRIVATE_KEY,
      process.env.PLAYER_TWO_PRIVATE_KEY,
      process.env.PLAYER_THREE_PRIVATE_KEY,
      process.env.PLAYER_FOUR_PRIVATE_KEY,
    ]
      .filter(Boolean)
      .map((k) => loadKeypair(k));

    assert.isAtLeast(playerKeypairs.length, 2, "Need 2 player keys in .env");
  });

  // ── 1. Register players (relayer creates board via /start-session) ────────
  describe("1. Player registration (base layer)", () => {
    it("registers 2 players on the board", async function () {
      this.timeout(60_000);

      for (let i = 0; i < 2; i++) {
        const playerKeypair = playerKeypairs[i];
        try {
          const tx = await program.methods
            .registerPlayer(new anchor.BN(GAME_ID))
            .accountsPartial({
              payer: playerKeypair.publicKey,
              boardAccount: boardPDA,
              treasury: treasuryPubkey,
              systemProgram: SystemProgram.programId,
            })
            .signers([playerKeypair])
            .transaction();

          const txHash = await sendAndConfirmTransaction(
            solanaConnection,
            tx,
            [playerKeypair],
            { skipPreflight: true, commitment: "confirmed" }
          );
          console.log(`  Player ${i + 1} registered → txHash: ${txHash}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("MaxPlayersReached") ||
            msg.includes("GameAlreadyStarted")
          ) {
            console.log(`  Player ${i + 1} skipped: ${msg.split("\n")[0]}`);
            break;
          }
          throw err;
        }
      }
    });
  });

  // // ── 2. Wait for relayer delegation, then do deterministic game test ───────
  // describe("2. Deterministic game test on ER", () => {
  //   it("waits for relayer to delegate board and activate game on ER", async function () {
  //     this.timeout(40_000);

  //     const deadline = Date.now() + 35_000;
  //     while (Date.now() < deadline) {
  //       try {
  //         const board = await programER.account.board.fetch(boardPDA);
  //         if (board.isActive) {
  //           console.log(
  //             `  Board is active on ER. King at position ${board.kingCurrentPosition}. Players: ${board.playersCount}`
  //           );
  //           // Snapshot balances at game start
  //           playerBalancesBeforeEnd = [];
  //           for (const kp of playerKeypairs) {
  //             playerBalancesBeforeEnd.push(await solanaConnection.getBalance(kp.publicKey));
  //           }
  //           console.log(`  Player balances at game start (lamports): [${playerBalancesBeforeEnd.join(", ")}]`);
  //           return;
  //         }
  //       } catch (_) {
  //         /* board not yet delegated */
  //       }
  //       await sleep(2_000);
  //     }
  //     throw new Error("Board was not active on ER after 35s — is the relayer running?");
  //   });

  //   it("sets king to a known position and moves player 1 onto it", async function () {
  //     this.timeout(30_000);

  //     // Players occupy positions 0-3. Place king one row down from player 1 (position 12 = empty).
  //     // Valid moves are +1, -1, +12, -12 so player 1 can reach it with move_position=+12.
  //     const board = await programER.account.board.fetch(boardPDA);
  //     const player1Pos = Number(board.players[0].currentPosition);
  //     const kingTarget = player1Pos + 12; // one row down, guaranteed empty
  //     console.log(`  Player 1 is at position ${player1Pos}. Setting king to position ${kingTarget}.`);

  //     // Set king position via treasury on ER
  //     const setKingTx = await programER.methods
  //       .setKingPosition(new anchor.BN(GAME_ID), kingTarget)
  //       .accountsPartial({
  //         treasury: treasuryPubkey,
  //         boardAccount: boardPDA,
  //       })
  //       .transaction();

  //     await sendAndConfirmTransaction(
  //       (programER.provider as anchor.AnchorProvider).connection,
  //       setKingTx,
  //       [treasuryKeypair],
  //       { skipPreflight: true, commitment: "confirmed" }
  //     );
  //     console.log(`  King set to position ${kingTarget}`);

  //     // Verify king position
  //     const boardAfterKing = await programER.account.board.fetch(boardPDA);
  //     assert.equal(boardAfterKing.kingCurrentPosition, kingTarget, "King position mismatch");
  //     assert.equal(boardAfterKing.board[kingTarget], KING_MARK, "Board cell should be KING_MARK");

  //     // Move player 1 down by 12 to land on king
  //     const moveTx = await programER.methods
  //       .makeMove(new anchor.BN(GAME_ID), 1, 12) // player_id=1, move_position=+12
  //       .accountsPartial({
  //         treasurySigner: treasuryPubkey,
  //         payer: playerKeypairs[0].publicKey,
  //         boardAccount: boardPDA,
  //       })
  //       .transaction();

  //     await sendAndConfirmTransaction(
  //       (programER.provider as anchor.AnchorProvider).connection,
  //       moveTx,
  //       [treasuryKeypair, playerKeypairs[0]],
  //       { skipPreflight: true, commitment: "confirmed" }
  //     );
  //     console.log(`  Player 1 moved +12 to land on king at ${kingTarget}`);

  //     // Verify player 1 is now at the king's position
  //     const boardAfterMove = await programER.account.board.fetch(boardPDA);
  //     assert.equal(
  //       Number(boardAfterMove.players[0].currentPosition),
  //       kingTarget,
  //       "Player 1 should be at king position"
  //     );
  //     console.log(`  Player 1 confirmed at position ${boardAfterMove.players[0].currentPosition}`);
  //   });

  //   it("ticks score multiple times and verifies player 1 score increases", async function () {
  //     this.timeout(20_000);

  //     const boardBefore = await programER.account.board.fetch(boardPDA);
  //     const scoreBefore = Number(boardBefore.players[0].score);
  //     console.log(`  Player 1 score before ticks: ${scoreBefore}`);

  //     const TICKS = 3;
  //     for (let t = 0; t < TICKS; t++) {
  //       const scoreTx = await programER.methods
  //         .updatePlayerScore(new anchor.BN(GAME_ID))
  //         .accountsPartial({
  //           treasury: treasuryPubkey,
  //           boardAccount: boardPDA,
  //         })
  //         .transaction();

  //       await sendAndConfirmTransaction(
  //         (programER.provider as anchor.AnchorProvider).connection,
  //         scoreTx,
  //         [treasuryKeypair],
  //         { skipPreflight: true, commitment: "confirmed" }
  //       );
  //     }

  //     const boardAfter = await programER.account.board.fetch(boardPDA);
  //     const scoreAfter = Number(boardAfter.players[0].score);
  //     console.log(`  Player 1 score after ${TICKS} ticks: ${scoreAfter}`);
  //     assert.isAtLeast(scoreAfter, scoreBefore + TICKS, `Score should have increased by at least ${TICKS}`);
  //   });

  //   it("logs final board state on ER before game ends", async function () {
  //     this.timeout(10_000);

  //     const board = await programER.account.board.fetch(boardPDA);
  //     console.log(`  Board state on ER:`);
  //     for (let i = 0; i < 4; i++) {
  //       const p = board.players[i];
  //       console.log(`    Player ${i + 1}: pos=${p.currentPosition}, score=${p.score}, id=${p.id}`);
  //     }
  //     console.log(`  King at position: ${board.kingCurrentPosition}`);
  //   });
  // });

  // ── 3. Wait for relayer to end game + distribute rewards, then verify ─────
  describe("3. Payout verification after game ends", () => {
    it("waits for game to end and rewards to be distributed, then verifies balances", async function () {
      this.timeout(180_000);

      // Wait for board to become inactive on devnet (relayer calls end_game + distribute_rewards)
      let finalScores = [0, 0, 0, 0];
      const deadline = Date.now() + 120_000;

      console.log(`  Waiting for relayer to end game and distribute rewards...`);
      while (Date.now() < deadline) {
        try {
          const board = await program.account.board.fetch(boardPDA);
          if (!board.isActive) {
            finalScores = board.players.map((p: any) => Number(p.score));
            console.log(`\n  Game ended on devnet. Final scores: [${finalScores.join(", ")}]`);
            break;
          }
        } catch (_) {
          // Board might not be back on devnet yet
        }
        await sleep(3_000);
      }

      // Extra wait for distribute_rewards tx to land
      const totalExpectedPayout = finalScores.reduce((sum, s) => sum + s * LAMPORTS_PER_SCORE, 0);
      if (totalExpectedPayout > 0) {
        console.log(`  Waiting for distribute_rewards to confirm...`);
        const rewardDeadline = Date.now() + 60_000;
        while (Date.now() < rewardDeadline) {
          const bal = await solanaConnection.getBalance(playerKeypairs[0].publicKey);
          const expectedDelta = finalScores[0] * LAMPORTS_PER_SCORE;
          if (expectedDelta > 0 && bal - playerBalancesBeforeEnd[0] >= expectedDelta) {
            console.log(`  Rewards distributed.`);
            break;
          }
          await sleep(2_000);
        }
      }

      // Per-player payout check
      let totalActualPayout = 0;
      for (let i = 0; i < playerKeypairs.length; i++) {
        const balAfter = await solanaConnection.getBalance(playerKeypairs[i].publicKey);
        const balBefore = playerBalancesBeforeEnd[i];
        const expectedPayout = finalScores[i] * LAMPORTS_PER_SCORE;
        const actualDelta = balAfter - balBefore;
        totalActualPayout += expectedPayout;

        console.log(
          `  Player ${i + 1}` +
          ` | score: ${String(finalScores[i]).padStart(5)}` +
          ` | expected: ${String(expectedPayout).padStart(12)} lamports` +
          ` | actual delta: ${String(actualDelta).padStart(12)} lamports` +
          ` | ${actualDelta === expectedPayout ? "MATCH" : "MISMATCH"}`
        );

        assert.strictEqual(
          actualDelta,
          expectedPayout,
          `Player ${i + 1} payout mismatch: expected ${expectedPayout} but got ${actualDelta}`
        );
      }

      // Treasury summary
      const totalRegistrationFees = playerKeypairs.length * REGISTRATION_FEE_LAMPORTS;
      const netTreasuryGain = totalRegistrationFees - totalActualPayout;

      console.log(`\n  ── Treasury Summary ────────────────────────────────`);
      console.log(`  Registration fees collected : ${totalRegistrationFees} lamports  (${playerKeypairs.length} x ${REGISTRATION_FEE_LAMPORTS})`);
      console.log(`  Total paid out to players   : ${totalActualPayout} lamports`);
      console.log(`  Net treasury gain from game : ${netTreasuryGain} lamports`);
    });
  });
});
