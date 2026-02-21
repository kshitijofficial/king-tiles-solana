use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;
mod error;
use error::*;
mod events;
use events::*;
declare_id!("39mbUDtnBeDfF5ozhTtVgQYWudeDPoDx6HnBEVtvpgGG");

// Board cell values: 0 = empty
const EMPTY: u8 = 0;
const KING_MARK: u8 = 5;
const BOARD_SIZE: usize = 144; // 12x12 grid = 144 cells
const REGISTRATION_FEE_LAMPORTS: u64 = 1_000_000; // 0.001 SOL
const LAMPORTS_PER_SCORE:u64 = 29_000;//0.000029 SOL
const TREASURY: Pubkey = pubkey!("86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA");
const KING_STARTING_POSITION: usize = 72;

#[inline(always)]
fn player_id_to_index(player_id: u8) -> usize {
    player_id.checked_sub(1).expect("player_id must be >= 1") as usize
}

fn new_position_is_empty(board: &mut Board,player_id:u8, current_position:i16, new_position:usize){
    let player_index = player_id_to_index(player_id);
    board.board[new_position] = board.players[player_index].id;
    board.board[current_position as usize] = EMPTY;
    board.players[player_index].current_position = new_position as i16;
}

fn new_position_is_not_empty_and_not_king(board: &mut Board,player_id:u8, current_position:i16, move_position:i16,new_position:usize) {
    //updating the collided player position
    let collision_player_id = board.board[new_position];
    let collision_player_current_position = board.players[player_id_to_index(collision_player_id)].current_position;
    let collision_player_new_position = collision_player_current_position
        .checked_add(move_position).unwrap()
        .checked_add(move_position).unwrap()
        .rem_euclid(BOARD_SIZE as i16) as usize;
    //assuming for now it will be empty seeing the game scenerio
    board.board[collision_player_new_position] = collision_player_id;
    board.players[player_id_to_index(collision_player_id)].current_position = collision_player_new_position as i16;
    //updating the player who moved position
    new_position_is_empty(board, player_id, current_position,  new_position);
}

fn new_position_is_king(board: &mut Board,player_id:u8, current_position:i16,new_position:usize){
    let player_index = player_id_to_index(player_id);
    board.board[new_position] = board.players[player_index].id;
    board.board[current_position as usize] = EMPTY;
    board.players[player_index].current_position = new_position as i16;
}

#[ephemeral]
#[program]
pub mod king_tiles {
    use super::*;

    pub fn start_game_session(ctx: Context<StartGameSession>, game_id: u64) -> Result<()> {
        msg!("Starting game session for game_id: {}", game_id);
        let board_account = &mut ctx.accounts.board_account;
        board_account.game_id = game_id;
        board_account.king_current_position = KING_STARTING_POSITION as u8;
        board_account.board[KING_STARTING_POSITION] = KING_MARK;
        Ok(())
    }
    pub fn delegate_board(ctx: Context<DelegateBoard>, game_id: u64) -> Result<()> {
        msg!("Delegating board for game_id: {}", game_id);
        ctx.accounts.delegate_pda(
            &ctx.accounts.treasury_signer,
            &[b"board",ctx.accounts.treasury_signer.key().as_ref(),&game_id.to_le_bytes()],
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
    pub fn register_player(ctx: Context<RegisterPlayer>, game_id: u64) -> Result<()> {
        msg!("Registering player for game_id: {}", game_id);
        let board_account = &mut ctx.accounts.board_account;
        require!(board_account.players_count < 2, KingTilesError::MaxPlayersReached);
        require!(!board_account.is_active, KingTilesError::GameAlreadyStarted);
        // Transfer 0.001 SOL registration fee to treasury
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
            current_position: board_account.players_count as i16,//current position starts by the first come first serve basis
            id: players_count.checked_add(1).unwrap() as u8,//id starts by one and so
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

    pub fn make_move(ctx: Context<MakeMove>,game_id:u64,player_id:u8,move_position:i16) -> Result<()> {
      
        let board = &mut ctx.accounts.board_account;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp < board.game_end_timestamp, KingTilesError::GameEnded);
        require!(board.is_active, KingTilesError::GameNotStarted);
        require!(board.players_count == 2, KingTilesError::GameNotFull);
        let player_index = player_id_to_index(player_id);
        require!(board.players[player_index].id == player_id, KingTilesError::NotPlayer);
        require!(board.players[player_index].player == ctx.accounts.payer.key(), KingTilesError::NotPlayer);
        require!(move_position.abs()==12 || move_position.abs()==1, KingTilesError::InvalidMove);
 
        let current_position = board.players[player_index].current_position;
        let new_position = current_position.checked_add(move_position).unwrap().rem_euclid(BOARD_SIZE as i16) as usize;
        
        //when the position the player is moving is empty
        if board.board[new_position] == EMPTY {
            new_position_is_empty(board, player_id, current_position, new_position);
        }

        else if board.board[new_position] != EMPTY && board.board[new_position] != KING_MARK {
            new_position_is_not_empty_and_not_king(board, player_id, current_position, move_position, new_position);
        }
        //else board.board[new_position] == KING_MARK 
        else {
            new_position_is_king(board, player_id, current_position,new_position);
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

    pub fn request_randomness(ctx: Context<RequestRandomness>, client_seed: u8, game_id: u64) -> Result<()> {
        msg!("Requesting VRF randomness for king move, game_id: {}", game_id);
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
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.treasury_signer.to_account_info(), &ix)?;
        Ok(())
    }

    pub fn callback_king_move(ctx: Context<CallbackKingMove>, randomness: [u8; 32]) -> Result<()> {
        let board = &mut ctx.accounts.board_account;
        let king_current_position = board.king_current_position;
        let mut cell_index = ephemeral_vrf_sdk::rnd::random_u8_with_range(&randomness, 0, (BOARD_SIZE.checked_sub(1).unwrap()) as u8) as usize;
        // Only clear the king mark if no player has landed on the tile
        if board.board[king_current_position as usize] == KING_MARK {
            board.board[king_current_position as usize] = EMPTY;
        }
        //temporary solution
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
    pub fn set_king_position(ctx: Context<SetKingPosition>, game_id: u64, position: u8) -> Result<()> {
        msg!("Setting king position to {} for game_id: {}", position, game_id);
        let board = &mut ctx.accounts.board_account;
        require!(board.is_active, KingTilesError::GameNotStarted);
        require!((position as usize) < BOARD_SIZE, KingTilesError::InvalidMove);

        require!(board.board[position as usize] == EMPTY, KingTilesError::InvalidMove);

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

    pub fn end_game_session<'info>(ctx: Context<'_, '_, '_, 'info, EndGameSession<'info>>, game_id: u64) -> Result<()> {
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

    pub fn distribute_rewards<'info>(ctx: Context<'_, '_, '_, 'info, DistributeRewards<'info>>, game_id: u64) -> Result<()> {
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
    
    //relayer will call this every second
    pub fn update_player_score(ctx: Context<UpdatePlayerScore>, game_id: u64) -> Result<()> {
        let board = &mut ctx.accounts.board_account;
        let king_current_position = board.king_current_position;
        let player_id_on_king_position = board.board[king_current_position as usize] as u8;
        if (1..=board.players_count).contains(&player_id_on_king_position) {
            let player_index = player_id_to_index(player_id_on_king_position);
            board.players[player_index].score = board.players[player_index].score.checked_add(1).unwrap();
        }
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Player{
    pub player: Pubkey,
    pub score: u64,
    pub current_position: i16,
    pub id: u8,
}
#[account]
#[derive(InitSpace)]
pub struct Board{
    pub game_id:u64,
    pub players: [Player; 4],
    pub is_active: bool,
    pub board: [u8; BOARD_SIZE],
    pub players_count: u8,
    pub king_current_position: u8,
    pub last_move_timestamp: i64,
    pub game_end_timestamp: i64,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct UpdatePlayerScore<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct SetKingPosition<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,
}

#[vrf]
#[derive(Accounts)]
#[instruction(client_seed: u8, game_id: u64)]
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
pub struct DelegateBoard<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury_signer: Signer<'info>,

    #[account(mut, seeds=[b"board",treasury_signer.key().as_ref(),&game_id.to_le_bytes()],bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,

    /// CHECK: same as now
    #[account(mut, del, constraint = pda.key() == board_account.key())]
    pub pda: AccountInfo<'info>,
}


#[commit]
#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct EndGameSession<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct DistributeRewards<'info> {
    #[account(mut, address = TREASURY)]
    pub treasury: Signer<'info>,

    #[account(mut, seeds = [b"board", treasury.key().as_ref(), &game_id.to_le_bytes()], bump)]
    pub board_account: Account<'info, Board>,

    pub system_program: Program<'info, System>,
}

