import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { BoardStatusPayload } from "./types";

export function getBoardPDA(
  treasuryPubkey: PublicKey,
  programId: PublicKey,
  gameId: number
): [PublicKey, number] {
  const gameIdBuffer = Buffer.alloc(8);
  gameIdBuffer.writeBigUInt64LE(BigInt(gameId));
  return anchor.web3.PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("board"), treasuryPubkey.toBuffer(), gameIdBuffer],
    programId
  );
}

export function toBoardGrid(flat: Uint8Array): number[][] {
  const COLS = 12;
  const flatBoard: number[] = Array.from(flat);
  return Array.from({ length: COLS }, (_, row) =>
    flatBoard.slice(row * COLS, row * COLS + COLS)
  );
}

export function toBoardStatusPayload(
  board: any,
  gameId: number,
  boardPDA: PublicKey,
  source: string
): BoardStatusPayload {
  const now = Math.floor(Date.now() / 1000);
  const gameEndTimestamp = Number(board.gameEndTimestamp);
  return {
    source,
    currentGameId: gameId,
    boardPDA: boardPDA.toBase58(),
    playersCount: Number(board.playersCount),
    isActive: !!board.isActive,
    gameEndTimestamp,
    secondsRemaining: board.isActive ? Math.max(0, gameEndTimestamp - now) : 0,
    players: board.players.map((p: any) => ({
      id: Number(p.id),
      player: p.player.toBase58(),
      score: p.score.toString(),
      currentPosition: Number(p.currentPosition),
      powerupScore: p.powerupScore.toString(),
    })),
    board: toBoardGrid(board.board),
    boardLegend: { 0: "empty", "1-4": "player id", 5: "king", 6: "powerup", 7: "bomb" },
  };
}

