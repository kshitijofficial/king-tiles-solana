export function moveLabel(m: number): string {
  if (m < -1) return "UP";
  if (m > 1) return "DOWN";
  if (m === -1) return "LEFT";
  if (m === 1) return "RIGHT";
  return String(m);
}

export function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
