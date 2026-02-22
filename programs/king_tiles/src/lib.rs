//! King Tiles — an on-chain, turnless mini-game built on Magic Block.
//!
//! High level flow:
//! - A `Board` PDA is created per `game_id` (seeded by the treasury and `game_id`).
//! - Two players register by paying a fixed fee into the treasury.
//! - Players move on a 12x12 board; landing on the king tile triggers scoring.
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
declare_id!("DsJTFyZpypWWBHF2PouwpcUNZ9L6FZx1aPcH55zdjCTU");

#[ephemeral]
#[program]
pub mod king_tiles {
    use super::*;

    /// Initialize a new game board for `game_id` and place the king at a deterministic start cell.
    pub fn start_game_session(ctx: Context<StartGameSession>, game_id: u64) -> Result<()> {
        msg!("Starting game session for game_id: {}", game_id);
        let board_account = &mut ctx.accounts.board_account;
        board_account.game_id = game_id;
        board_account.king_current_position = KING_STARTING_POSITION as u8;
        board_account.board[KING_STARTING_POSITION] = KING_MARK;
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

    /// Register a player for a game (max 2) and collect the registration fee into the treasury.
    pub fn register_player(ctx: Context<RegisterPlayer>, game_id: u64) -> Result<()> {
        msg!("Registering player for game_id: {}", game_id);
        let board_account = &mut ctx.accounts.board_account;
        require!(
            board_account.players_count < 2,
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
            REGISTRATION_FEE_LAMPORTS,
        )?;

        let players_count = board_account.players_count;

        let player = Player {
            player: ctx.accounts.payer.key(),
            score: 0,
            current_position: board_account.players_count as i16, // Spawn position is deterministic by registration order.
            id: players_count.checked_add(1).unwrap() as u8, // Player ids are 1-based for board encoding.
        };
        board_account.players[players_count as usize] = player;
        board_account.board[player.current_position as usize] = player.id;
        board_account.players_count = players_count.checked_add(1).unwrap();

        if board_account.players_count == 2 {
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
        move_position: i16,
    ) -> Result<()> {
        let _ = game_id;
        let board = &mut ctx.accounts.board_account;
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < board.game_end_timestamp,
            KingTilesError::GameEnded
        );
        require!(board.is_active, KingTilesError::GameNotStarted);
        require!(board.players_count == 2, KingTilesError::GameNotFull);
        let player_index = player_id_to_index(player_id);
        require!(
            board.players[player_index].id == player_id,
            KingTilesError::NotPlayer
        );
        require!(
            board.players[player_index].player == ctx.accounts.payer.key(),
            KingTilesError::NotPlayer
        );
        // Only allow orthogonal moves by one cell (±1) or one row (±12).
        require!(
            move_position.abs() == 12 || move_position.abs() == 1,
            KingTilesError::InvalidMove
        );

        let current_position = board.players[player_index].current_position;
        let new_position = current_position
            .checked_add(move_position)
            .unwrap()
            .rem_euclid(BOARD_SIZE as i16) as usize;

        // Resolve movement based on what currently occupies the destination cell.
        if board.board[new_position] == EMPTY {
            new_position_is_empty(board, player_id, current_position, new_position);
        } else if board.board[new_position] != EMPTY && board.board[new_position] != KING_MARK {
            new_position_is_not_empty_and_not_king(
                board,
                player_id,
                current_position,
                move_position,
                new_position,
            );
        }
        //else board.board[new_position] == KING_MARK
        else {
            new_position_is_king(board, player_id, current_position, new_position);
            emit!(PlayerScoredEvent {
                player: ctx.accounts.payer.key(),
                game_id: board.game_id,
            });
        }

        emit!(MoveMadeEvent {
            player: ctx.accounts.payer.key(),
            game_id: board.game_id,
        });

        Ok(())
    }

    /// Request VRF randomness to move the king tile. The callback moves the king and emits an event.
    pub fn request_randomness(
        ctx: Context<RequestRandomness>,
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

    /// VRF callback which moves the king tile to a random empty cell.
    ///
    /// This instruction cannot be called directly by users; the `CallbackKingMove` context enforces
    /// the caller is the VRF program identity.
    pub fn callback_king_move(ctx: Context<CallbackKingMove>, randomness: [u8; 32]) -> Result<()> {
        let board = &mut ctx.accounts.board_account;
        let king_current_position = board.king_current_position;
        let mut cell_index = ephemeral_vrf_sdk::rnd::random_u8_with_range(
            &randomness,
            0,
            (BOARD_SIZE.checked_sub(1).unwrap()) as u8,
        ) as usize;
        // Only clear the king mark if no player has landed on the tile
        if board.board[king_current_position as usize] == KING_MARK {
            board.board[king_current_position as usize] = EMPTY;
        }
        // Ensure the king lands on an empty cell by linearly probing from the sampled index.
        while board.board[cell_index] != EMPTY {
            cell_index = (cell_index.checked_add(1).unwrap()) as usize % BOARD_SIZE;
        }
        board.board[cell_index] = KING_MARK;
        board.king_current_position = cell_index as u8;
        emit!(KingMoveEvent {
            game_id: board.game_id,
            king_move: board.king_current_position as u8,
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
            (position as usize) < BOARD_SIZE,
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

            let reward = player.score.checked_mul(LAMPORTS_PER_SCORE).unwrap();
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
pub struct RequestRandomness<'info> {
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
