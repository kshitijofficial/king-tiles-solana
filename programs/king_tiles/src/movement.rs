//! Movement helpers for a 1D board representation.
//!
//! The board is stored as a flat array of length [`BOARD_SIZE`]. Callers are responsible for
//! validating move deltas and ensuring indices are within range.

use crate::constants::{BOARD_SIZE, EMPTY};
use crate::state::Board;

#[inline(always)]
/// Convert a 1-based player id into a 0-based index into `board.players`.
///
/// # Panics
/// Panics if `player_id` is `0`. Instruction handlers should validate player identity before
/// calling into movement helpers.
pub fn player_id_to_index(player_id: u8) -> usize {
    player_id.checked_sub(1).expect("player_id must be >= 1") as usize
}

/// Apply a move into an empty destination cell.
pub fn new_position_is_empty(
    board: &mut Board,
    player_id: u8,
    current_position: i16,
    new_position: usize,
) {
    let player_index = player_id_to_index(player_id);
    board.board[new_position] = board.players[player_index].id;
    board.board[current_position as usize] = EMPTY;
    board.players[player_index].current_position = new_position as i16;
}

/// Resolve a move into an occupied cell (non-king).
///
/// Current behavior "bumps" the collided player by `2 * move_position` relative to their current
/// position, then moves the active player into `new_position`.
///
/// Note: this assumes the bumped-to cell is empty (no chaining/cascading collisions).
pub fn new_position_is_not_empty_and_not_king(
    board: &mut Board,
    player_id: u8,
    current_position: i16,
    move_position: i16,
    new_position: usize,
) {
    // Update the collided player's position first.
    let collision_player_id = board.board[new_position];
    let collision_player_current_position =
        board.players[player_id_to_index(collision_player_id)].current_position;
    let collision_player_new_position = collision_player_current_position
        .checked_add(move_position)
        .unwrap()
        .checked_add(move_position)
        .unwrap()
        .rem_euclid(BOARD_SIZE as i16) as usize;
    board.board[collision_player_new_position] = collision_player_id;
    board.players[player_id_to_index(collision_player_id)].current_position =
        collision_player_new_position as i16;
    // Move the active player into the destination cell.
    new_position_is_empty(board, player_id, current_position, new_position);
}

/// Apply a move onto the king's tile.
///
/// Scoring is handled by the instruction handler; this helper only updates board state.
pub fn new_position_is_king(
    board: &mut Board,
    player_id: u8,
    current_position: i16,
    new_position: usize,
) {
    let player_index = player_id_to_index(player_id);
    board.board[new_position] = board.players[player_index].id;
    board.board[current_position as usize] = EMPTY;
    board.players[player_index].current_position = new_position as i16;
}
