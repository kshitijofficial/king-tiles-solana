use anchor_lang::prelude::*;

/// Canonical cell value for an empty board tile.
pub const EMPTY: u8 = 0;

/// Cell marker for the king's current tile.
pub const KING_MARK: u8 = 255;

/// Cell marker for the bomb tile.
pub const BOMB_MARK: u8 = 253;

/// Cell marker for the powerup tile.
pub const POWERUP_MARK: u8 = 254;

/// Power up score. Player can push another player four blocks with Power up score.
pub const POWERUP_SCORE: u64 = 4;

/// Board size in cells (\(12 \times 12\)), stored as a flat array.
pub const BOARD_SIZE: usize = 144; // 12x12 grid = 144 cells

/// Global treasury account used for fees and rewards.
pub const TREASURY: Pubkey = pubkey!("86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA");

/// Deterministic starting index for the king tile for a given board side.
/// For even side lengths, this picks the upper-left of the 2x2 center block.
pub fn king_starting_position(board_side_len: u8) -> usize {
    let side = board_side_len as usize;
    let center_upper_left = side.checked_div(2).unwrap().checked_sub(1).unwrap();
    center_upper_left
        .checked_mul(side)
        .unwrap()
        .checked_add(center_upper_left)
        .unwrap()
}
