use anchor_lang::prelude::*;

/// Canonical cell value for an empty board tile.
pub const EMPTY: u8 = 0;

/// Cell marker for the king's current tile.
pub const KING_MARK: u8 = 5;

/// Board size in cells (\(12 \times 12\)), stored as a flat array.
pub const BOARD_SIZE: usize = 144; // 12x12 grid = 144 cells

/// One-time registration fee paid into the treasury (lamports).
pub const REGISTRATION_FEE_LAMPORTS: u64 = 1_000_000; // 0.001 SOL

/// Reward paid per score point when distributing rewards (lamports).
pub const LAMPORTS_PER_SCORE: u64 = 29_000; // 0.000029 SOL

/// Global treasury account used for fees and rewards.
pub const TREASURY: Pubkey = pubkey!("86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA");

/// Deterministic starting index for the king tile.
// 12x12 has an even width, so there is no single "middle" cell.
// This picks the upper-left of the 2x2 center block: (row=5, col=5) => 5*12+5 = 65.
pub const KING_STARTING_POSITION: usize = 65;

/// Cell marker for the powerup tile.
pub const POWERUP_MARK: u8 = 6;

/// Power up score. Player can push another player four blocks with Power up score.
pub const POWERUP_SCORE: u64 = 4;

pub const POWER_USE_DIRECTION_DOWNWARDS: i16 = 12;
pub const POWER_USE_DIRECTION_RIGHTWARDS: i16 = 1;
pub const POWER_USE_DIRECTION_UPWARDS: i16 = -12;
pub const POWER_USE_DIRECTION_LEFTWARDS: i16 = -1;

/// Cell marker for the bomb tile.
pub const BOMB_MARK: u8 = 7;




