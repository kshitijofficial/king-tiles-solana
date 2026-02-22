import { PlayerInfo } from "./types";

export function getWinningPlayerId(players: PlayerInfo[]): number | null {
  if (!players.length) return null;
  const topScore = Math.max(...players.map((p) => Number(p.score)));
  const leaders = players.filter((p) => Number(p.score) === topScore);
  return leaders.length === 1 ? leaders[0].id : null;
}

