export function toolNonSuccess(result: { isError?: boolean; details?: unknown }): "failed" | "refused" | "scriptError" | null {
  if (result.isError === true) return "failed";
  const details = result.details as { refused?: { by?: unknown }; scriptError?: unknown } | undefined;
  if (typeof details?.refused?.by === "string") return "refused";
  return details?.scriptError === true ? "scriptError" : null;
}

export function didNotSucceed(result: { isError?: boolean; details?: unknown }): boolean {
  return toolNonSuccess(result) !== null;
}
