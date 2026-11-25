import { object } from "./acp";
import type { AcpContent, AntigravityOption, AntigravitySessionInfo, AntigravityTool } from "./types";

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

export function sessionInfo(value: unknown): AntigravitySessionInfo | undefined {
  const { sessionId, cwd, title, updatedAt } = object(value);
  return typeof sessionId === "string" && sessionId && typeof cwd === "string" && cwd
    ? { sessionId, cwd, title: string(title), updatedAt: string(updatedAt) }
    : undefined;
}

// Require a Gemini model identifier, not a display label or substring match.
export function isGemini(value: string): boolean {
  return /^(?:google\/|models\/)?gemini-[a-z0-9][a-z0-9._-]*$/i.test(value);
}

export function configOptions(value: unknown): AntigravityOption[] {
  return records(value).flatMap(({ type, id, category, currentValue, options }) => {
    if (type !== "select" || typeof id !== "string" || typeof currentValue !== "string") return [];
    const kind = category === "model" || (!category && id === "model") ? "model"
      : category === "thought_level" || (!category && ["thinking", "thinking_level", "thought_level"].includes(id)) ? "thinking" : null;
    if (!kind) return [];
    const choices = records(options).flatMap((option) => Array.isArray(option.options) ? records(option.options) : [option])
      .flatMap(({ value, name }) => typeof value === "string" && typeof name === "string" && (kind !== "model" || isGemini(value))
        ? [{ value, name }]
        : []);
    return [{ id, kind, current: choices.some((choice) => choice.value === currentValue) ? currentValue : "", choices }];
  });
}

const safeImageMime = /^image\/(?:png|jpeg|webp|gif|avif)$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function contentBlock(value: unknown): AcpContent | undefined {
  const { type, text, mimeType, data, resource, name, uri, size } = object(value);
  if (type === "text" && typeof text === "string") return { type, text };
  if (type === "image" && typeof mimeType === "string" && safeImageMime.test(mimeType) && typeof data === "string" && base64.test(data)) {
    return { type, mimeType, data };
  }
  if (type === "resource") {
    const { uri, mimeType, text } = object(resource);
    if (typeof uri === "string" && typeof text === "string") return { type, resource: { uri, mimeType: string(mimeType) ?? "text/plain", text } };
  }
  if (type === "resource_link" && typeof uri === "string" && typeof name === "string") {
    return { type, uri, name, mimeType: string(mimeType), size: typeof size === "number" ? size : undefined };
  }
  return undefined;
}

function displayJson(value: unknown): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function toolUpdate(update: Record<string, unknown>, previous?: AntigravityTool): AntigravityTool | undefined {
  const id = string(update.toolCallId);
  if (!id) return undefined;
  const content = Array.isArray(update.content) ? records(update.content) : null;
  const diffs = content?.flatMap(({ type, path, oldText, newText }) => type === "diff" && typeof path === "string" && typeof newText === "string"
    ? [{ path, oldText: string(oldText) ?? null, newText }]
    : []);
  const text = content?.flatMap((item) => {
    const block = item.type === "content" ? contentBlock(item.content) : undefined;
    return block?.type === "text" ? [block.text] : [];
  });
  const status = update.status;
  return {
    id,
    title: string(update.title) ?? previous?.title ?? id,
    status: status === "pending" || status === "in_progress" || status === "completed" || status === "failed" ? status : previous?.status ?? "pending",
    kind: string(update.kind) ?? previous?.kind,
    paths: Array.isArray(update.locations) ? records(update.locations).flatMap(({ path }) => typeof path === "string" ? [path] : []) : previous?.paths,
    input: displayJson(update.rawInput) ?? previous?.input,
    output: text?.length ? text.join("\n") : displayJson(update.rawOutput) ?? previous?.output,
    diffs: diffs?.length ? diffs : previous?.diffs,
  };
}
