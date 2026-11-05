/** 浮動小数の時刻を整数ミリ秒へ正規化する */
export function toIntMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

export function clampMs(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, toIntMs(value)));
}

export function formatTimecode(ms: number, withMs = true): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(Math.round(ms));
  const m = Math.floor(abs / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const r = abs % 1000;
  const base = `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withMs ? `${base}.${String(r).padStart(3, '0')}` : base;
}
