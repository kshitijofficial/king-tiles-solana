export interface PlayerInfo {
  id: number;
  player: string;
  score: string;
  currentPosition: number;
}

export interface TxTrace {
  startSessionTxHash?: string;
  delegateBoardTxHash?: string;
  endSessionTxHash?: string;
  rewardTxHash?: string;
  rewardTxSolscanUrl?: string;
  rewardError?: string;
}

export interface CompletedGameSnapshot {
  source?: string;
  currentGameId: number;
  boardPDA?: string;
  playersCount?: number;
  isActive?: boolean;
  gameEndTimestamp?: number;
  secondsRemaining?: number;
  players?: PlayerInfo[];
  board?: number[][];
  boardLegend?: { 0: string; "1-4": string; 5: string };
  completedAtIso: string;
  txTrace: TxTrace;
}

export interface GameStatus {
  ok: boolean;
  source?: string;
  currentGameId: number | null;
  boardPDA?: string;
  playersCount?: number;
  isActive?: boolean;
  gameEndTimestamp?: number;
  secondsRemaining?: number;
  players?: PlayerInfo[];
  board?: number[][];
  message?: string;
  lastCompletedGame?: CompletedGameSnapshot | null;
}

