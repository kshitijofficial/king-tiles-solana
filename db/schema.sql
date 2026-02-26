create table if not exists public.leaderboard (
  wallet text primary key,
  best_score bigint not null default 0,
  last_game_score bigint not null default 0,
  last_game_id bigint not null default 0,
  games_played integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists leaderboard_best_score_idx
  on public.leaderboard (best_score desc);

create or replace function public.set_leaderboard_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_leaderboard_updated_at on public.leaderboard;
create trigger trg_set_leaderboard_updated_at
before update on public.leaderboard
for each row
execute function public.set_leaderboard_updated_at();
