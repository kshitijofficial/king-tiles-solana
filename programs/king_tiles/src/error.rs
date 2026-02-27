use anchor_lang::prelude::*;

#[error_code]
pub enum KingTilesError {
    #[msg("Maximum players already registered for this game")]
    MaxPlayersReached,

    #[msg("Game has already started; no more registrations allowed")]
    GameAlreadyStarted,

    #[msg("Player is not registered for this game")]
    NotPlayer,

    #[msg("Game is not active")]
    GameNotActive,

    #[msg("Game is not full")]
    GameNotFull,

    #[msg("Game is not started")]
    GameNotStarted,

    #[msg("Game has ended")]
    GameEnded,

    #[msg("Game is not over")]
    GameNotOver,

    #[msg("Invalid move")]
    InvalidMove,

    #[msg("No powerup available")]
    NoPowerup,

    #[msg("Invalid powerup move")]
    InvalidPowerupMove,

    #[msg("Invalid game configuration")]
    InvalidGameConfig,
}
