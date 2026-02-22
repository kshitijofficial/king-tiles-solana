import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export function loadKeypair(privateKeyBase58?: string): Keypair {
  if (!privateKeyBase58) {
    throw new Error("Missing private key. Set TREASURY_SECRET_BASE58 in .env.");
  }
  try {
    const privateKeyBytes = bs58.decode(privateKeyBase58);
    if (privateKeyBytes.length === 32) return Keypair.fromSeed(privateKeyBytes);
    if (privateKeyBytes.length === 64)
      return Keypair.fromSecretKey(privateKeyBytes);
    throw new Error(
      `Invalid key length: ${privateKeyBytes.length}. Expected 32 or 64 bytes.`
    );
  } catch (error) {
    console.error("Error loading keypair:", error);
    throw new Error("Failed to load keypair. Ensure it is base58 encoded.");
  }
}

