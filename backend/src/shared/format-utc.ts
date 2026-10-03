/** "YYYY-MM-DD HH:MM UTC" — minute precision, always UTC. */
export function formatUtcMinute(d: Date): string {
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
