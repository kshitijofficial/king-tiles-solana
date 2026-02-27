//! Anchor events emitted for indexing and UI updates.

use anchor_lang::prelude::*;

#[event]
/// Emitted when a player registers for a game.
pub struct PlayerRegisteredEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
/// Emitted when the second player registers and the game becomes active.
pub struct GameStartedEvent {
    pub game_id: u64,
}

#[event]
/// Emitted after the board PDA is delegated to an ephemeral validator.
pub struct DelegateBoardEvent {
    pub game_id: u64,
}

#[event]
/// Emitted after undelegation + commit completes.
pub struct UndelegateAndCommitEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
/// Emitted after a player successfully makes a move.
pub struct MoveMadeEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
/// Emitted when the king tile changes position.
pub struct KingMoveEvent {
    pub game_id: u64,
    pub king_move: u8,
}

#[event]
/// Emitted when a move results in landing on the king tile.
pub struct PlayerScoredEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
/// Emitted when the powerup tile changes position.
pub struct PowerupMoveEvent {
    pub game_id: u64,
    pub powerup_move: u8,
}

#[event]
/// Emitted when a player uses their powerup.
pub struct PowerUsedEvent {
    pub player: u8,
    pub game_id: u64,
}
#[event]
/// Emitted when a player gains powerup.
pub struct PlayerScoredPowerupEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
/// Emitted when the bomb tile changes position.
pub struct BombDropEvent {
    pub game_id: u64,
    pub bomb_drop: u8,
}
#[event]
/// Emitted when a player gains bomb.
pub struct PlayerScoredBombEvent {
    pub player: Pubkey,
    pub game_id: u64,
}
