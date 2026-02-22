import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  MAKE_MOVE_DISCRIMINATOR,
  PROGRAM_ID,
  REGISTER_PLAYER_DISCRIMINATOR,
  TREASURY_PUBKEY,
} from "./constants";

export function buildRegisterPlayerIx(
  payer: PublicKey,
  boardPDA: PublicKey,
  gameId: number
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  Buffer.from(REGISTER_PLAYER_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(BigInt(gameId), 8);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: boardPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TREASURY_PUBKEY, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

export function buildMakeMoveIx(
  payer: PublicKey,
  boardPDA: PublicKey,
  gameId: number,
  playerId: number,
  movePosition: number
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 1 + 2);
  Buffer.from(MAKE_MOVE_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(BigInt(gameId), 8);
  data.writeUInt8(playerId, 16);
  data.writeInt16LE(movePosition, 17);

  return new TransactionInstruction({
    keys: [
      { pubkey: TREASURY_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: boardPDA, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

