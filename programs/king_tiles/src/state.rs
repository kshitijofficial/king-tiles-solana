
use anchor_lang::prelude::*;

use crate::constants::BOARD_SIZE;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Player {
    pub player: Pubkey,
    pub score: u64,
    pub current_position: i16,
    pub id: u8,

    pub powerup_score: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

impl Direction {
    pub fn offset(self, board_side_len: u8) -> i16 {
        let side = board_side_len as i16;
        match self {
            Direction::Right => 1,
            Direction::Left => -1,
            Direction::Down => side,
            Direction::Up => -side,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Board {
    pub game_id: u64,
    #[max_len(6)]
    pub players: Vec<Player>,
    pub is_active: bool,
    pub board: [u8; BOARD_SIZE],
    pub board_side_len: u8,
    pub max_players: u8,
    pub registration_fee_lamports: u64,
    pub lamports_per_score: u64,
    pub players_count: u8,
    pub king_current_position: u8,
    pub last_move_timestamp: i64,
    pub game_end_timestamp: i64,

    pub powerup_current_position: u8,
    pub bomb_current_position: u8,
}

impl Board {
    #[inline(always)]
    pub fn active_board_cells(&self) -> usize {
        let side = self.board_side_len as usize;
        side.checked_mul(side).unwrap()
    }
}
