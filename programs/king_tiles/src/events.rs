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