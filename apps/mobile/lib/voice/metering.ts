/** Map iOS/Android recorder dB (typically -160…0) onto a 0–1 bar height. */
export function normalizeMetering(db: number | undefined): number {
  if (db == null || Number.isNaN(db)) return 0.18;
  const clamped = Math.min(0, Math.max(-55, db));
  return (clamped + 55) / 55;
}
