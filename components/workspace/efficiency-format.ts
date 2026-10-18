/** 효율 패널과 "모델이 본 것" 보기가 함께 쓰는 숫자 표기. 값이 없으면 `—`다. */

export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

export function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const ms = Math.max(0, value);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // 초를 먼저 정수로 확정한다. 분을 자른 뒤 나머지를 반올림하면 `49m 60s`가 나온다.
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds - totalMinutes * 60;
  if (totalMinutes < 60) return restSeconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${restSeconds}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}
