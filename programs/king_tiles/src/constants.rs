use anchor_lang::prelude::*;

pub const EMPTY: u8 = 0;

pub const KING_MARK: u8 = 255;

pub const BOMB_MARK: u8 = 253;

pub const POWERUP_MARK: u8 = 254;

pub const POWERUP_SCORE: u64 = 4;

pub const BOARD_SIZE: usize = 144; // 12x12 grid = 144 cells

pub const TREASURY: Pubkey = pubkey!("86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA");

pub fn king_starting_position(board_side_len: u8) -> usize {
    let side = board_side_len as usize;
    let center_upper_left = side.checked_div(2).unwrap().checked_sub(1).unwrap();
    center_upper_left
        .checked_mul(side)
        .unwrap()
        .checked_add(center_upper_left)
        .unwrap()
}
