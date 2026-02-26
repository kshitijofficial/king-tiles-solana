type LeaderboardPlayer = {
  wallet: string;
  score: number;
};

type BoardLike = {
  playersCount: number;
  players: Array<{
    player: { toBase58(): string };
    score: { toString(): string } | string | number;
  }>;
};

type LeaderboardRow = {
  wallet: string;
  best_score: number;
  games_played: number;
};

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const LEADERBOARD_TABLE = process.env.SUPABASE_LEADERBOARD_TABLE || "leaderboard";

function isConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function leaderboardHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

function leaderboardBaseUrl(): string {
  return `${SUPABASE_URL}/rest/v1/${LEADERBOARD_TABLE}`;
}

async function getExistingRow(wallet: string): Promise<LeaderboardRow | null> {
  const url = `${leaderboardBaseUrl()}?wallet=eq.${encodeURIComponent(
    wallet
  )}&select=wallet,best_score,games_played&limit=1`;

  const response = await fetch(url, { headers: leaderboardHeaders() });
  if (!response.ok) {
    throw new Error(`failed to fetch leaderboard row (${response.status})`);
  }

  const rows = (await response.json()) as LeaderboardRow[];
  return rows.length ? rows[0] : null;
}

async function insertRow(wallet: string, score: number, gameId: number): Promise<void> {
  const payload = {
    wallet,
    best_score: score,
    last_game_score: score,
    last_game_id: gameId,
    games_played: 1,
  };

  const response = await fetch(leaderboardBaseUrl(), {
    method: "POST",
    headers: leaderboardHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`failed to insert leaderboard row (${response.status}): ${body}`);
  }
}

async function updateRow(
  wallet: string,
  existing: LeaderboardRow,
  score: number,
  gameId: number
): Promise<void> {
  const payload = {
    best_score: Math.max(existing.best_score, score),
    last_game_score: score,
    last_game_id: gameId,
    games_played: Number(existing.games_played || 0) + 1,
  };

  const response = await fetch(`${leaderboardBaseUrl()}?wallet=eq.${encodeURIComponent(wallet)}`, {
    method: "PATCH",
    headers: leaderboardHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`failed to update leaderboard row (${response.status}): ${body}`);
  }
}

export async function upsertLeaderboardFromBoard(
  gameId: number,
  board: BoardLike
): Promise<void> {
  if (!isConfigured()) {
    console.log(
      "  [Leaderboard] Skipped DB update. Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."
    );
    return;
  }

  const players: LeaderboardPlayer[] = board.players
    .slice(0, Number(board.playersCount))
    .map((p) => ({
      wallet: p.player.toBase58(),
      score: Number(typeof p.score === "object" ? p.score.toString() : p.score),
    }));

  for (const player of players) {
    const existing = await getExistingRow(player.wallet);
    if (!existing) {
      await insertRow(player.wallet, player.score, gameId);
      continue;
    }
    await updateRow(player.wallet, existing, player.score, gameId);
  }

  console.log(`  [Leaderboard] Synced ${players.length} players for gameId ${gameId}.`);
}

export async function fetchTopLeaderboard(limit = 5): Promise<LeaderboardRow[]> {
  if (!isConfigured()) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const url = `${leaderboardBaseUrl()}?select=wallet,best_score,games_played&order=best_score.desc&limit=${limit}`;
  const response = await fetch(url, { headers: leaderboardHeaders() });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`failed to fetch top leaderboard (${response.status}): ${body}`);
  }

  return (await response.json()) as LeaderboardRow[];
}

