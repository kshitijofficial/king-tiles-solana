import { PublicKey } from "@solana/web3.js";

export type TxTrace = {
  startSessionTxHash?: string;
  delegateBoardTxHash?: string;
  endSessionTxHash?: string;
  rewardTxHash?: string;
  rewardTxSolscanUrl?: string;
  rewardError?: string;
};

export type BoardStatusPayload = {
  source: string;
  currentGameId: number;
  boardPDA: string;
  boardSideLen: number;
  maxPlayers: number;
  registrationFeeLamports: string;
  lamportsPerScore: string;
  playersCount: number;
  isActive: boolean;
  gameEndTimestamp: number;
  secondsRemaining: number;
  players: Array<{
    id: number;
    player: string;
    score: string;
    currentPosition: number;
    powerupScore: string;
  }>;
  board: number[][];
  boardLegend: { 0: string; "1-max": string; 253: string; 254: string; 255: string };
};

export type CompletedGameSnapshot = BoardStatusPayload & {
  completedAtIso: string;
  txTrace: TxTrace;
};

export type BoardPda = {
  pubkey: PublicKey;
  bump: number;
};

