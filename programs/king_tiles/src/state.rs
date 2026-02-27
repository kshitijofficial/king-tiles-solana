//! Program state and domain types.
//!
//! The board is represented as a flat array where each cell contains either `EMPTY`, `KING_MARK`,
//! or a player id.

use anchor_lang::prelude::*;

use crate::constants::BOARD_SIZE;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
/// Per-player state tracked for a given game.
pub struct Player {
    /// Player wallet address.
    pub player: Pubkey,
    /// Score accrued over time while occupying the king tile.
    pub score: u64,
    /// Current position on the board (0..BOARD_SIZE), stored as `i16` to simplify delta math.
    pub current_position: i16,
    /// 1-based id used as the board cell marker.
    pub id: u8,

    /// Power up accrued over time while occupying the powerup tile.
    pub powerup_score: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
/// Orthogonal movement directions.
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
/// Main game account (PDA) holding all board and player state.
pub struct Board {
    /// Client-defined identifier used to derive the board PDA.
    pub game_id: u64,
    /// Player slots (only the first `players_count` entries are active).
    #[max_len(6)]
    pub players: Vec<Player>,
    /// Whether the game is currently active (started and not yet ended).
    pub is_active: bool,
    /// Flat board array of length [`BOARD_SIZE`].
    pub board: [u8; BOARD_SIZE],
    /// Logical board side length (8, 10, or 12).
    pub board_side_len: u8,
    /// Number of players required to start and cap registrations.
    pub max_players: u8,
    /// Per-player registration fee for this game.
    pub registration_fee_lamports: u64,
    /// Reward paid per score point for this game.
    pub lamports_per_score: u64,
    /// Number of registered players.
    pub players_count: u8,
    /// Current king tile index.
    pub king_current_position: u8,
    /// Reserved for throttling / auditing move cadence (currently unused by instructions).
    pub last_move_timestamp: i64,
    /// Wall-clock unix timestamp (seconds) at which the game ends.
    pub game_end_timestamp: i64,

    /// Current powerup tile index.
    pub powerup_current_position: u8,
    /// Current bomb tile index.
    pub bomb_current_position: u8,
}

impl Board {
    #[inline(always)]
    pub fn active_board_cells(&self) -> usize {
        let side = self.board_side_len as usize;
        side.checked_mul(side).unwrap()
    }
}
