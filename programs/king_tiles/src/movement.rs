//! Movement helpers for a 1D board representation.
//!
//! The board is stored as a flat array of length [`BOARD_SIZE`]. Callers are responsible for
//! validating move deltas and ensuring indices are within range.
use crate::constants::{BOMB_MARK, EMPTY, KING_MARK, POWERUP_MARK, POWERUP_SCORE};
use crate::events::{PlayerScoredBombEvent, PlayerScoredEvent, PlayerScoredPowerupEvent};
use crate::state::Board;
use anchor_lang::prelude::*;

#[inline(always)]
/// Convert a 1-based player id into a 0-based index into `board.players`.
///
/// # Panics
/// Panics if `player_id` is `0`. Instruction handlers should validate player identity before
/// calling into movement helpers.
pub fn player_id_to_index(player_id: u8) -> usize {
    player_id.checked_sub(1).expect("player_id must be >= 1") as usize
}

pub fn check_board_for_new_position(
    payer_key: Pubkey,
    board: &mut Board,
    player_index: usize,
    new_position: usize,
    move_position: i16,
) {
    let cell = board.board[new_position];
    if cell == EMPTY {
        new_position_is_empty(board, player_index, new_position);
    } else if cell == KING_MARK {
        new_position_is_king(board, player_index, new_position);
        emit!(PlayerScoredEvent {
            player: payer_key,
            game_id: board.game_id,
        });
    } else if cell == BOMB_MARK {
        new_position_is_bomb(board, player_index, new_position);
    } else if cell == POWERUP_MARK {
        new_position_is_powerup(board, player_index, new_position);
    } else {
        // cell is a player id (1-4)
        new_position_is_occupied_by_player(board, player_index, move_position, new_position);
    }
}

/// Apply a move into an empty destination cell.
pub fn new_position_is_empty(board: &mut Board, player_index: usize, new_position: usize) {
    let current_position = board.players[player_index].current_position;
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
pub fn new_position_is_occupied_by_player(
    board: &mut Board,
    player_index: usize,
    move_position: i16,
    new_position: usize,
) {
    let board_cells = board.active_board_cells();
    let board_side_len = board.board_side_len as i16;
    let collision_player_id = board.board[new_position];
    let collision_player_index = player_id_to_index(collision_player_id);
    let collision_player_current_position = board.players[collision_player_index].current_position;

    if move_position.abs() == 1 || move_position.abs() == board_side_len {
        // Normal move: bump the collided player by 2 * move_position
        let collision_player_new_position = collision_player_current_position
            .checked_add(move_position)
            .unwrap()
            .checked_add(move_position)
            .unwrap()
            .rem_euclid(board_cells as i16) as usize;
        check_board_for_new_position(
            board.players[collision_player_index].player,
            board,
            collision_player_index,
            collision_player_new_position,
            move_position,
        );
        // Move the active player into the now-vacated cell
        new_position_is_empty(board, player_index, new_position);
    } else {
        // Power move: shift Pn exactly ONE step in the same direction as the power
        let single_step: i16 = if move_position.abs() >= board_side_len {
            if move_position > 0 {
                board_side_len
            } else {
                -board_side_len
            }
        } else {
            if move_position > 0 {
                1
            } else {
                -1
            }
        };

        let new_pos = (collision_player_current_position
            .checked_add(single_step)
            .unwrap())
        .rem_euclid(board_cells as i16) as usize;

        if board.board[new_pos] == EMPTY {
            // Pn steps aside — P2 can now land
            new_position_is_empty(board, collision_player_index, new_pos);
            new_position_is_empty(board, player_index, new_position);
        }
        // If Pn's neighbor is also occupied, the power push is blocked —
        // Pn and P2 both stay in place (return without moving either)
    }
}

/// Apply a move onto the king's tile.
///
/// Scoring is handled by the instruction handler; this helper only updates board state.
pub fn new_position_is_king(board: &mut Board, player_index: usize, new_position: usize) {
    board.board[new_position] = board.players[player_index].id;
    let current_position = board.players[player_index].current_position;
    board.board[current_position as usize] = EMPTY;
    board.players[player_index].current_position = new_position as i16;
}

/// Apply a move onto the powerup tile.
pub fn new_position_is_powerup(board: &mut Board, player_index: usize, new_position: usize) {
    let current_position = board.players[player_index].current_position;
    board.board[new_position] = board.players[player_index].id;
    emit!(PlayerScoredPowerupEvent {
        player: board.players[player_index].player,
        game_id: board.game_id,
    });
    board.board[current_position as usize] = EMPTY;
    board.players[player_index].current_position = new_position as i16;
    board.players[player_index].powerup_score = POWERUP_SCORE;
}

pub fn check_if_player_exists(i: i16, board: &mut Board) -> bool {
    if board.board[i as usize] != EMPTY
        && board.board[i as usize] != KING_MARK
        && board.board[i as usize] != BOMB_MARK
        && board.board[i as usize] != POWERUP_MARK
    {
        return true;
    }
    return false;
}

pub fn new_position_is_bomb(board: &mut Board, player_index: usize, new_position: usize) {
    let board_cells = board.active_board_cells();
    emit!(PlayerScoredBombEvent {
        player: board.players[player_index].player,
        game_id: board.game_id,
    });
    let player_id = board.players[player_index].id;
    let current_position = board.players[player_index].current_position as usize;

    // Clear the player from their current tile and the bomb from the stepped-on tile.
    board.board[current_position] = EMPTY;
    board.board[new_position] = EMPTY;

    // Warp back to the deterministic starting position (player_index = player_id - 1).
    // If that cell is occupied, linearly probe forward until we find an empty one.
    let mut landing = player_index;
    for _ in 0..board_cells {
        if board.board[landing] == EMPTY {
            break;
        }
        landing = landing.checked_add(1).unwrap_or(0) % board_cells;
    }
    board.board[landing] = player_id;
    board.players[player_index].current_position = landing as i16;
}
/// Power up direction downwards.
pub fn use_power_with_direction(board: &mut Board, player_index: usize, power_use_direction: i16) {
    let board_cells = board.active_board_cells();
    let board_side_len = board.board_side_len as i16;
    let current_position = board.players[player_index].current_position;
    let step = power_use_direction.abs();

    // Scan one step at a time in the chosen direction from just past the player's cell.
    // For positive directions (+12 down, +1 right) scan forward toward BOARD_SIZE.
    // For negative directions (-12 up, -1 left)  scan backward toward 0.
    let mut i = current_position.checked_add(power_use_direction).unwrap();

    loop {
        // Stay within board bounds
        if i < 0 || i >= board_cells as i16 {
            break;
        }
        // Horizontal moves must not wrap to a different row
        if step == 1 {
            let from_row = current_position.rem_euclid(board_side_len);
            if from_row == 0 && power_use_direction < 0 {
                break;
            } // hit left edge
            if from_row == board_side_len - 1 && power_use_direction > 0 {
                break;
            } // hit right edge
            let cur_row = (current_position.checked_div(board_side_len).unwrap())
                .checked_mul(board_side_len)
                .unwrap();
            if i < cur_row || i >= cur_row.checked_add(board_side_len).unwrap() {
                break;
            }
        }

        if check_if_player_exists(i, board) {
            let attacked_player_id = board.board[i as usize];
            let attacked_player_index = player_id_to_index(attacked_player_id);
            let attacked_player_current_position =
                board.players[attacked_player_index].current_position;

            // Push exactly POWERUP_SCORE tiles in the same direction the power was used.
            let new_position_offset = (POWERUP_SCORE as i16)
                .checked_mul(power_use_direction)
                .unwrap();

            let attacked_player_new_position = attacked_player_current_position
                .checked_add(new_position_offset)
                .unwrap()
                .rem_euclid(board_cells as i16)
                as usize;

            check_board_for_new_position(
                board.players[attacked_player_index].player,
                board,
                attacked_player_index,
                attacked_player_new_position,
                new_position_offset,
            );
            board.players[player_index].powerup_score = 0;
            break;
        }

        i = i.checked_add(power_use_direction).unwrap();
    }
}

// pub fn powerup_direction_rightwards(
//     board: &mut Board,
//     player_index: usize,

//     power_use_direction: i16,
// ) {

//     let current_position = board.players[player_index].current_position;
//     let index_start = current_position.checked_add(power_use_direction).unwrap();
//     for i in (index_start..BOARD_SIZE as i16).step_by(power_use_direction.abs() as usize){
//         if check_if_player_exists(i, board){
//             let attacked_player_id = board.board[i as usize];
//             let attacked_player_index = player_id_to_index(attacked_player_id);
//             let attacked_player_current_position = board.players[attacked_player_index].current_position;

//             let new_position_offset = POWERUP_SCORE.checked_mul(power_use_direction.abs() as u64).unwrap() as i16;

//             let attacked_player_new_position = attacked_player_current_position
//                 .checked_add(new_position_offset as i16)
//                 .unwrap()
//                 .rem_euclid(BOARD_SIZE as i16) as usize;
//             //check if new postion is empty
//             check_board_for_new_position(board.players[attacked_player_index].player, board, attacked_player_index, attacked_player_new_position, new_position_offset as i16);
//             board.players[player_index].powerup_score = 0;
//             break;
//         }
//     }

// }

// /// Power up direction upwards.
// pub fn powerup_direction_upwards(
//     board: &mut Board,
//     player_index: usize,

//     power_use_direction: i16,
// ) {

//     let current_position = board.players[player_index].current_position;
//     let index_start = current_position.checked_add(power_use_direction).unwrap();
//     for i in (index_start..BOARD_SIZE as i16).step_by(power_use_direction.abs() as usize){
//         if check_if_player_exists(i, board){
//             let attacked_player_id = board.board[i as usize];
//             let attacked_player_index = player_id_to_index(attacked_player_id);
//             let attacked_player_current_position = board.players[attacked_player_index].current_position;

//             let new_position_offset = POWERUP_SCORE.checked_mul(power_use_direction.abs() as u64).unwrap() as i16;

//             let attacked_player_new_position = attacked_player_current_position
//                 .checked_add(new_position_offset as i16)
//                 .unwrap()
//                 .rem_euclid(BOARD_SIZE as i16) as usize;
//             //check if new postion is empty
//             check_board_for_new_position(board.players[attacked_player_index].player, board, attacked_player_index, attacked_player_new_position, new_position_offset as i16);
//             board.players[player_index].powerup_score = 0;
//             break;
//         }
//     }

// }

// /// Power up direction leftwards.
// pub fn powerup_direction_leftwards(
//     board: &mut Board,
//     player_index: usize,

//     power_use_direction: i16,
// ) {
//     let current_position = board.players[player_index].current_position;
//     let index_start = current_position.checked_add(power_use_direction).unwrap();
//     for i in (index_start..BOARD_SIZE as i16).step_by(power_use_direction.abs() as usize){
//         if check_if_player_exists(i, board){
//             let attacked_player_id = board.board[i as usize];
//             let attacked_player_index = player_id_to_index(attacked_player_id);
//             let attacked_player_current_position = board.players[attacked_player_index].current_position;

//             let new_position_offset = POWERUP_SCORE.checked_mul(power_use_direction.abs() as u64).unwrap() as i16;

//             let attacked_player_new_position = attacked_player_current_position
//                 .checked_add(new_position_offset as i16)
//                 .unwrap()
//                 .rem_euclid(BOARD_SIZE as i16) as usize;
//             //check if new postion is empty
//             check_board_for_new_position(board.players[attacked_player_index].player, board, attacked_player_index, attacked_player_new_position, new_position_offset as i16);
//             board.players[player_index].powerup_score = 0;
//             break;
//         }
//     }
// }
