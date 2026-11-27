export type ToolNonSuccess = "failed" | "refused" | "scriptError";

export function toolNonSuccess(result: { isError?: unknown; details?: unknown } | undefined): ToolNonSuccess | null {
  if (result?.isError === true) return "failed";
  const details = result?.details as { refused?: { by?: unknown }; scriptError?: unknown } | undefined;
  if (typeof details?.refused?.by === "string") return "refused";
  if (details?.scriptError === true) return "scriptError";
  return null;
}
