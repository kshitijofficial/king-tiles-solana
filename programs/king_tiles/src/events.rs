
use anchor_lang::prelude::*;

#[event]
pub struct PlayerRegisteredEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
pub struct GameStartedEvent {
    pub game_id: u64,
}

#[event]
pub struct DelegateBoardEvent {
    pub game_id: u64,
}

#[event]
pub struct UndelegateAndCommitEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
pub struct MoveMadeEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
pub struct KingMoveEvent {
    pub game_id: u64,
    pub king_move: u8,
}

#[event]
pub struct PlayerScoredEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
pub struct PowerupMoveEvent {
    pub game_id: u64,
    pub powerup_move: u8,
}

#[event]
pub struct PowerUsedEvent {
    pub player: u8,
    pub game_id: u64,
}
#[event]
pub struct PlayerScoredPowerupEvent {
    pub player: Pubkey,
    pub game_id: u64,
}

#[event]
pub struct BombDropEvent {
    pub game_id: u64,
    pub bomb_drop: u8,
}
#[event]
pub struct PlayerScoredBombEvent {
    pub player: Pubkey,
    pub game_id: u64,
}
