import { PublicKey } from "@solana/web3.js";

// Must match the program used by the relayer (from target/idl or KING_TILES_PROGRAM_ID)
export const PROGRAM_ID = new PublicKey(
  typeof process !== "undefined" && process.env?.REACT_APP_PROGRAM_ID
    ? process.env.REACT_APP_PROGRAM_ID
    : "AN5cqzkh1fMg631UP9NcwDCaDBu1idTyJqcDqyYA9g5M"
);

export const TREASURY_PUBKEY = new PublicKey(
  "86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA"
);

// for fallback only
export const GAME_ID = 5;

export const BOARD_SIZE = 144;
export const COLS = 12;

export const RELAYER_URL = "http://localhost:8787";
export const ER_ENDPOINT = "https://devnet.magicblock.app/";

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export const EMPTY = 0;
export const KING_MARK = 5;
export const POWERUP_MARK = 6;
export const BOMB_MARK = 7;

export const REGISTRATION_FEE_LAMPORTS = 1_000_000; // 0.001 SOL

export const MAKE_MOVE_DISCRIMINATOR = [78, 77, 152, 203, 222, 211, 208, 233];
export const REGISTER_PLAYER_DISCRIMINATOR = [
  242, 146, 194, 234, 234, 145, 228, 42,
];

export const PLAYER_COLORS = ["#4FC3F7", "#EF5350", "#66BB6A", "#FFA726"];
export const PLAYER_LABELS = ["P1", "P2", "P3", "P4"];

// Pre-computed positions so Math.random() isn't called on every render
export const COIN_X_POSITIONS = Array.from({ length: 15 }, (_, i) =>
  parseFloat((10 + (i * 5.4) % 78).toFixed(1))
);

