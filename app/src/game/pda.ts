import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, TREASURY_PUBKEY } from "./constants";

export function getBoardPDA(gameId: number): PublicKey {
  const gameIdBuf = Buffer.alloc(8);
  gameIdBuf.writeBigUInt64LE(BigInt(gameId));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("board"), TREASURY_PUBKEY.toBuffer(), gameIdBuf],
    PROGRAM_ID
  );
  return pda;
}

