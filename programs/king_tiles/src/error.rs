use anchor_lang::prelude::*;

#[error_code]
/// Program-specific errors returned by instruction handlers.
pub enum KingTilesError {
    #[msg("Maximum players (2) already registered for this game")]
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
}
