//! King Tiles — an on-chain, turnless mini-game built on Magic Block.
//!
//! High level flow:
//! - A `Board` PDA is created per `game_id` (seeded by the treasury and `game_id`).
//! - Players register by paying the game-specific fee into the treasury.
//! - Players move on a configured board; landing on the king tile triggers scoring.
//! - The king tile can be moved via VRF callback (or manually by the treasury for admin/testing).
//! - A relayer can periodically increment score for the player currently standing on the king tile.
//! - After the game ends, rewards are distributed from the treasury based on final scores.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
mod constants;
mod error;
use error::*;
mod events;
use events::*;
mod movement;
mod state;
use constants::*;
use movement::*;
use state::*;
declare_id!("GAfcEqSSQJm2coiTRf4wL1SDX78jciwE6bN9eHwUaXi9");

#[ephemeral]
#[program]
pub mod king_tiles {
    use super::*;

    /// Initialize a new game board for `game_id` with game configuration and deterministic king start.
    pub fn start_game_session(
        ctx: Context<StartGameSession>,
        game_id: u64,
        board_side_len: u8,
        max_players: u8,
        registration_fee_lamports: u64,
        lamports_per_score: u64,
    ) -> Result<()> {
        msg!("Starting game session for game_id: {}", game_id);
        require!(
            valid_mode(board_side_len, max_players),
            KingTilesError::InvalidGameConfig
        );
        require!(
            registration_fee_lamports > 0 && lamports_per_score > 0,
            KingTilesError::InvalidGameConfig
        );

        let board_account = &mut ctx.accounts.board_account;
        board_account.game_id = game_id;
        board_account.board_side_len = board_side_len;
        board_account.max_players = max_players;
        board_account.registration_fee_lamports = registration_fee_lamports;
        board_account.lamports_per_score = lamports_per_score;
        board_account.players.clear();
        board_account.players_count = 0;
        board_account.is_active = false;
        board_account.last_move_timestamp = 0;
        board_account.game_end_timestamp = 0;
        board_account.powerup_current_position = 0;
        board_account.bomb_current_position = 0;
        board_account.board = [EMPTY; BOARD_SIZE];

        let king_position = king_starting_position(board_side_len);
        board_account.king_current_position = king_position as u8;
        board_account.board[king_position] = KING_MARK;
        Ok(())
    }

    /// Delegate the board PDA for ephemeral execution (optionally pinning a validator).
    pub fn delegate_board(ctx: Context<DelegateBoard>, game_id: u64) -> Result<()> {
        msg!("Delegating board for game_id: {}", game_id);
        ctx.accounts.delegate_pda(
            &ctx.accounts.treasury_signer,
            &[
                b"board",
                ctx.accounts.treasury_signer.key().as_ref(),
                &game_id.to_le_bytes(),
            ],
            DelegateConfig {
                // Optionally set a specific validator from the first remaining account
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        emit!(DelegateBoardEvent {
            game_id: ctx.accounts.board_account.game_id,
        });
        Ok(())
    }

    /// Register a player for a game and collect the registration fee into the treasury.
    pub fn register_player(ctx: Context<RegisterPlayer>, game_id: u64) -> Result<()> {
        msg!("Registering player for game_id: {}", game_id);
        let board_account = &mut ctx.accounts.board_account;
        require!(
            board_account.players_count < board_account.max_players,
            KingTilesError::MaxPlayersReached
        );
        require!(!board_account.is_active, KingTilesError::GameAlreadyStarted);
        // Registration fee is paid into the fixed treasury address.
        let transfer_ix = anchor_lang::system_program::Transfer {
            from: ctx.accounts.payer.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
        };
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(), transfer_ix),
            board_account.registration_fee_lamports,
        )?;

        let players_count = board_account.players_count;

        let player = Player {
            player: ctx.accounts.payer.key(),
            score: 0,
            current_position: board_account.players_count as i16, // Spawn position is deterministic by registration order.
            id: players_count.checked_add(1).unwrap() as u8, // Player ids are 1-based for board encoding.
            powerup_score: 0,
        };
        board_account.players.push(player);
        board_account.board[player.current_position as usize] = player.id;
        board_account.players_count = players_count.checked_add(1).unwrap();

        if board_account.players_count == board_account.max_players {
            board_account.is_active = true;
            let clock = Clock::get()?;
            board_account.game_end_timestamp = clock.unix_timestamp.checked_add(60).unwrap();
            emit!(GameStartedEvent {
                game_id: board_account.game_id,
            });
        }
        emit!(PlayerRegisteredEvent {
            player: ctx.accounts.payer.key(),
            game_id: ctx.accounts.board_account.game_id
        });
        Ok(())
    }

    /// Apply a player move on the board.
    ///
    /// The board is stored as a flat array. Allowed deltas are:
    /// - `±1` for left/right
    /// - `±12` for up/down
    /// Movement wraps around the board edges via `rem_euclid`.
    pub fn make_move(
        ctx: Context<MakeMove>,
        game_id: u64,
        player_id: u8,
        direction: Direction,
    ) -> Result<()> {
        let _ = game_id;
        let board = &mut ctx.accounts.board_account;

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < board.game_end_timestamp,
            KingTilesError::GameEnded
        );
        require!(board.is_active, KingTilesError::GameNotStarted);
        require!(
            board.players_count == board.max_players,
            KingTilesError::GameNotFull
        );
        let player_index = player_id_to_index(player_id);
        require!(
            player_index < board.players_count as usize,
            KingTilesError::NotPlayer
        );
        require!(
            board.players[player_index].id == player_id,
            KingTilesError::NotPlayer
        );
        require!(
            board.players[player_index].player == ctx.accounts.payer.key(),
            KingTilesError::NotPlayer
        );
        // Only allow orthogonal moves by one cell (±1) or one row (±12).
        let move_position = direction.offset(board.board_side_len);
        let active_cells = board.active_board_cells();
        let payer_key = ctx.accounts.payer.key();
        let current_position = board.players[player_index].current_position;
        let new_position = current_position
            .checked_add(move_position)
            .unwrap()
            .rem_euclid(active_cells as i16) as usize;

        check_board_for_new_position(payer_key, board, player_index, new_position, move_position);

        emit!(MoveMadeEvent {
            player: payer_key,
            game_id: board.game_id,
        });

        Ok(())
    }

    /// Request VRF randomness to move the king tile. The callback moves the king and emits an event.
    pub fn request_randomness_for_king_move(
        ctx: Context<RequestRandomnessForKingMove>,
        client_seed: u8,
        game_id: u64,
    ) -> Result<()> {
        msg!(
            "Requesting VRF randomness for king move, game_id: {}",
            game_id
        );
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.treasury_signer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackKingMove::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![
                // treasury (non-signer) so callback can derive the board PDA
                SerializableAccountMeta {
                    pubkey: ctx.accounts.treasury_signer.key(),
                    is_signer: false,
                    is_writable: false,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.board_account.key(),
                    is_signer: false,
                    is_writable: true,
                },
            ]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.treasury_signer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn request_randomness_for_powerup_move(
        ctx: Context<RequestRandomnessForPowerupMove>,
        client_seed: u8,
        game_id: u64,
    ) -> Result<()> {
        msg!(
            "Requesting VRF randomness for powerup move, game_id: {}",
            game_id
        );
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.treasury_signer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackSpawnPowerup::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![
                // treasury (non-signer) so callback can derive the board PDA
                SerializableAccountMeta {
                    pubkey: ctx.accounts.treasury_signer.key(),
                    is_signer: false,
                    is_writable: false,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.board_account.key(),
                    is_signer: false,
                    is_writable: true,
                },
            ]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.treasury_signer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn request_randomness_for_bomb_drop(
        ctx: Context<RequestRandomnessForBombDrop>,
        client_seed: u8,
        game_id: u64,
    ) -> Result<()> {
        msg!(
            "Requesting VRF randomness for bomb drop, game_id: {}",
            game_id
        );
        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.treasury_signer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackBombDrop::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![
                // treasury (non-signer) so callback can derive the board PDA
                SerializableAccountMeta {
                    pubkey: ctx.accounts.treasury_signer.key(),
                    is_signer: false,
                    is_writable: false,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.board_account.key(),
                    is_signer: false,
                    is_writable: true,
                },
            ]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.treasury_signer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback which moves the king tile to a random empty cell.
    ///
    /// This instruction cannot be called directly by users; the `CallbackKingMove` context enforces
    /// the caller is the VRF program identity.
    pub fn callback_bomb_drop(ctx: Context<CallbackBombDrop>, randomness: [u8; 32]) -> Result<()> {
        let board = &mut ctx.accounts.board_account;
        let active_cells = board.active_board_cells();
        let bomb_current_position = board.bomb_current_position;
        let mut cell_index = ephemeral_vrf_sdk::rnd::random_u8_with_range(
            &randomness,
            0,
            (active_cells.checked_sub(1).unwrap()) as u8,
        ) as usize;
        // Only clear the bomb mark if no player has landed on the tile
        if board.board[bomb_current_position as usize] == BOMB_MARK {
            board.board[bomb_current_position as usize] = EMPTY;
        }
        // Ensure the bomb lands on an empty cell by linearly probing from the sampled index.
        while board.board[cell_index] != EMPTY {
            cell_index = (cell_index.checked_add(1).unwrap()) % active_cells;
        }
        board.board[cell_index] = BOMB_MARK;
        board.bomb_current_position = cell_index as u8;
        emit!(BombDropEvent {
            game_id: board.game_id,
            bomb_drop: board.bomb_current_position as u8,
        });
        Ok(())
    }
    pub fn callback_king_move(ctx: Context<CallbackKingMove>, randomness: [u8; 32]) -> Result<()> {
        let board = &mut ctx.accounts.board_account;
        let active_cells = board.active_board_cells();
        let king_current_position = board.king_current_position;
        let mut cell_index = ephemeral_vrf_sdk::rnd::random_u8_with_range(
            &randomness,
            0,
            (active_cells.checked_sub(1).unwrap()) as u8,
        ) as usize;
        // Only clear the king mark if no player has landed on the tile
        if board.board[king_current_position as usize] == KING_MARK {
            board.board[king_current_position as usize] = EMPTY;
        }
        // Ensure the king lands on an empty cell by linearly probing from the sampled index.
        while board.board[cell_index] != EMPTY {
            cell_index = (cell_index.checked_add(1).unwrap()) % active_cells;
        }
        board.board[cell_index] = KING_MARK;
        board.king_current_position = cell_index as u8;
        emit!(KingMoveEvent {
            game_id: board.game_id,
            king_move: board.king_current_position as u8,
        });
        Ok(())
    }

    pub fn callback_spawn_powerup(
        ctx: Context<CallbackPowerupMove>,
        randomness: [u8; 32],
    ) -> Result<()> {
        let board = &mut ctx.accounts.board_account;
        let active_cells = board.active_board_cells();
        let powerup_current_position = board.powerup_current_position;
        let mut cell_index = ephemeral_vrf_sdk::rnd::random_u8_with_range(
            &randomness,
            0,
            (active_cells.checked_sub(1).unwrap()) as u8,
        ) as usize;
        // Only clear the previous generated random powerupmark if no player has landed on the tile
        if board.board[powerup_current_position as usize] == POWERUP_MARK {
            board.board[powerup_current_position as usize] = EMPTY;
        }
        // Ensure the king lands on an empty cell by linearly probing from the sampled index.
        while board.board[cell_index] != EMPTY {
            cell_index = (cell_index.checked_add(1).unwrap()) % active_cells;
        }
        board.board[cell_index] = POWERUP_MARK;
        board.powerup_current_position = cell_index as u8;
        emit!(PowerupMoveEvent {
            game_id: board.game_id,
            powerup_move: board.powerup_current_position as u8,
        });
        Ok(())
    }

    /// Admin/testing hook to set the king position (treasury gated). Only for the purpose of testing.
    pub fn set_king_position(
        ctx: Context<SetKingPosition>,
        game_id: u64,
        position: u8,
    ) -> Result<()> {
        msg!(
            "Setting king position to {} for game_id: {}",
            position,
            game_id
        );
        let board = &mut ctx.accounts.board_account;
        require!(board.is_active, KingTilesError::GameNotStarted);
        require!(
            (position as usize) < board.active_board_cells(),
            KingTilesError::InvalidMove
        );

        require!(
            board.board[position as usize] == EMPTY,
            KingTilesError::InvalidMove
        );

        let old_pos = board.king_current_position as usize;
        if board.board[old_pos] == KING_MARK {
            board.board[old_pos] = EMPTY;
        }
        board.board[position as usize] = KING_MARK;
        board.king_current_position = position;

        emit!(KingMoveEvent {
            game_id: board.game_id,
            king_move: position,
        });
        Ok(())
    }

    /// End a delegated session: exit the board account and commit state back to L1.
    pub fn end_game_session<'info>(
        ctx: Context<'_, '_, '_, 'info, EndGameSession<'info>>,
        game_id: u64,
    ) -> Result<()> {
        msg!("Ending game session for game_id: {}", game_id);
        let board = &ctx.accounts.board_account;
        board.exit(&crate::ID)?;
        commit_and_undelegate_accounts(
            &ctx.accounts.treasury.to_account_info(),
            vec![&board.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        emit!(UndelegateAndCommitEvent {
            player: ctx.accounts.treasury.key().clone(),
            game_id: board.game_id,
        });
        Ok(())
    }

    /// Distribute treasury-funded rewards to each registered player based on `score`.
    ///
    /// Remaining accounts must provide the player account infos in the same order as `board.players`.
    pub fn distribute_rewards<'info>(
        ctx: Context<'_, '_, '_, 'info, DistributeRewards<'info>>,
        game_id: u64,
    ) -> Result<()> {
        msg!("Distributing rewards for game_id: {}", game_id);
        let board = &mut ctx.accounts.board_account;
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= board.game_end_timestamp,
            KingTilesError::GameNotOver
        );
        board.is_active = false;

        for i in 0..(board.players_count as usize) {
            let player = &board.players[i];
            let player_account_info = ctx.remaining_accounts[i].clone();
            require_keys_eq!(player_account_info.key(), player.player);

            let reward = player.score.checked_mul(board.lamports_per_score).unwrap();
            if reward == 0 {
                continue;
            }
            let transfer_ix = anchor_lang::system_program::Transfer {
                from: ctx.accounts.treasury.to_account_info(),
                to: player_account_info,
            };
            anchor_lang::system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(), transfer_ix),
                reward,
            )?;
        }
        Ok(())
    }

    /// Relayer hook to increment score for the player currently occupying the king tile.
    ///
    /// This is intentionally treasury-gated to avoid arbitrary third parties mutating score.
    pub fn update_player_score(ctx: Context<UpdatePlayerScore>, game_id: u64) -> Result<()> {
        let _ = game_id;
        let board = &mut ctx.accounts.board_account;
        let king_current_position = board.king_current_position;
        let player_id_on_king_position = board.board[king_current_position as usize] as u8;
        if (1..=board.players_count).contains(&player_id_on_king_position) {
            let player_index = player_id_to_index(player_id_on_king_position);
            board.players[player_index].score =
                board.players[player_index].score.checked_add(1).unwrap();
        }
        Ok(())
    }

    /// Close the board PDA and reclaim rent back to the treasury.
    pub fn close_board(ctx: Context<CloseBoard>, game_id: u64) -> Result<()> {
        let _ = ctx;
        msg!("Closing board for game_id: {}", game_id);
        Ok(())
    }

    pub fn use_power(
        ctx: Context<UsePower>,
        game_id: u64,
        player_id: u8,
        direction: Direction,
    ) -> Result<()> {
        let _ = game_id;
        let board = &mut ctx.accounts.board_account;
        let player_index = player_id_to_index(player_id);
        require!(
            player_index < board.players_count as usize,
            KingTilesError::NotPlayer
        );
        require!(
            board.players[player_index].powerup_score > 0,
            KingTilesError::NoPowerup
        );
        let power_use_direction = direction.offset(board.board_side_len);

        use_power_with_direction(board, player_index, power_use_direction);

        emit!(PowerUsedEvent {
            player: player_id,
            game_id: board.game_id,
        });
        Ok(())
    }
}

fn valid_mode(board_side_len: u8, max_players: u8) -> bool {
    (board_side_len == 8 && max_players == 2)
        || (board_side_len == 10 && max_players == 4)
        || (board_side_len == 12 && max_players == 6)
}

#[vrf]
#[derive(Accounts)]
#[instruction(client_seed: u8, game_id: u64)]
/// Accounts for requesting VRF randomness.
pub struct RequestRandomnessForBombDrop<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury_signer: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury_signer.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,

    /// CHECK: The oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for using a powerup.
pub struct UsePower<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}
#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for closing the board PDA.
pub struct CloseBoard<'info> {
    #[account(
        mut,
        close = treasury, // rent goes back to treasury
        seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()],
        bump
    )]
    pub board_account: Account<'info, Board>,

    #[account(mut)]
    pub treasury: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for relayer-driven score updates.
pub struct UpdatePlayerScore<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for treasury-controlled king placement (admin/testing).
pub struct SetKingPosition<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[vrf]
#[derive(Accounts)]
#[instruction(client_seed: u8, game_id: u64)]
/// Accounts for requesting VRF randomness.
pub struct RequestRandomnessForKingMove<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury_signer: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury_signer.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,

    /// CHECK: The oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[vrf]
#[derive(Accounts)]
#[instruction(client_seed: u8, game_id: u64)]
/// Accounts for requesting VRF randomness.
pub struct RequestRandomnessForPowerupMove<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury_signer: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury_signer.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,

    /// CHECK: The oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

#[derive(Accounts)]
/// Accounts for VRF callback that mutates the board.
pub struct CallbackBombDrop<'info> {
    /// Enforces the callback is executed by the VRF program via CPI — not callable by anyone else
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,

    /// CHECK: Treasury key passed as non-signer; used only to derive the board PDA
    #[account(address = TREASURY)]
    pub treasury: AccountInfo<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &board_account.game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[derive(Accounts)]
/// Accounts for VRF callback that mutates the board.
pub struct CallbackKingMove<'info> {
    /// Enforces the callback is executed by the VRF program via CPI — not callable by anyone else
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,

    /// CHECK: Treasury key passed as non-signer; used only to derive the board PDA
    #[account(address = TREASURY)]
    pub treasury: AccountInfo<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &board_account.game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[derive(Accounts)]
/// Accounts for VRF callback that mutates the board.
pub struct CallbackPowerupMove<'info> {
    /// Enforces the callback is executed by the VRF program via CPI — not callable by anyone else
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,

    /// CHECK: Treasury key passed as non-signer; used only to derive the board PDA
    #[account(address = TREASURY)]
    pub treasury: AccountInfo<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &board_account.game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for registering a player (payer signs and pays the fee).
pub struct RegisterPlayer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut,seeds=[b"board",treasury.key().as_ref(),&game_id.to_le_bytes()],bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,

    /// CHECK: Treasury validated by address - receives registration fees
    #[account(mut, address = TREASURY)]
    pub treasury: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for moving a player token on the board.
pub struct MakeMove<'info> {
    /// CHECK: Treasury pubkey validated by address constraint, used only for PDA derivation
    #[account(address = TREASURY)]
    pub treasury: AccountInfo<'info>,

    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for initializing a new game board.
pub struct StartGameSession<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury_signer: Signer<'info>,

    #[account(init,payer=treasury_signer,space=8 + Board::INIT_SPACE,seeds=[b"board",treasury_signer.key().as_ref(),&game_id.to_le_bytes()],bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for delegating the board PDA to an ephemeral validator.
pub struct DelegateBoard<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury_signer: Signer<'info>,

    #[account(mut, seeds=[b"board",treasury_signer.key().as_ref(),&game_id.to_le_bytes()],bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,

    /// CHECK: Delegated PDA account; constrained to match `board_account`.
    #[account(mut, del, constraint = pda.key() == board_account.key())]
    pub pda: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for committing and undelegating the board PDA.
pub struct EndGameSession<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
/// Accounts for distributing rewards after the game ends.
pub struct DistributeRewards<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,
}
