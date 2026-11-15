import type { RoutinePostStatus } from "./post";

export type RoutineThreadState = "none" | "waiting" | "pending" | "answered";
export interface RoutineReply {
  file: string;
  author: "user" | "agent";
  host: string;
  createdAt: string;
  status?: RoutinePostStatus;
  sessionId?: string;
  replyTo?: string[];
  body: string;
}

export const REPLY_FILE_PATTERN = /^\d{8}T\d{9}-[a-z0-9][a-z0-9_-]*-(user|agent)\.md$/;
declare global {
  var __cueloPendingReplyWrites: Map<string, number> | undefined;
}
export const pendingReplyWrites = globalThis.__cueloPendingReplyWrites ??= new Map<string, number>();

export function reserveReplyWrite(key: string): void {
  pendingReplyWrites.set(key, (pendingReplyWrites.get(key) ?? 0) + 1);
}
export function releaseReplyWrite(key: string): void {
  const remaining = (pendingReplyWrites.get(key) ?? 1) - 1;
  if (remaining) pendingReplyWrites.set(key, remaining);
  else pendingReplyWrites.delete(key);
}

export function threadState(status: RoutinePostStatus, replies: RoutineReply[]): RoutineThreadState {
  const latest = replies.findLast((reply) => reply.author === "agent");
  if (pendingReplies(replies).length) return "pending";
  if (!replies.length) return status === "waiting" ? "waiting" : "none";
  return latest?.status === "waiting" ? "waiting" : "answered";
}

export function parseReplyBody(raw: unknown): { body: string } | { error: string } {
  const body = raw && typeof raw === "object" && "body" in raw && typeof raw.body === "string" ? raw.body.trim() : "";
  return body.length > 0 && body.length <= 8000 ? { body } : { error: "body must be 1-8000 characters" };
}

export function serializeReply(reply: RoutineReply): string {
  const keys = ["author", "host", "createdAt", ...(reply.author === "agent" ? ["status", "sessionId", ...(reply.replyTo ? ["replyTo"] : [])] : [])] as (keyof RoutineReply)[];
  return `---\n${keys.map((key) => `${key}: ${JSON.stringify(key === "replyTo" ? reply.replyTo?.join(",") : reply[key] ?? "")}`).join("\n")}\n---\n\n${reply.body.trim()}\n`;
}

export function parseReply(text: string, file: string): RoutineReply | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match || !REPLY_FILE_PATTERN.test(file)) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const value = line.slice(colon + 1).trim();
    try { fields[line.slice(0, colon)] = value.startsWith('"') ? JSON.parse(value) : value; } catch { return null; }
  }
  if ((fields.author !== "user" && fields.author !== "agent") || typeof fields.host !== "string" || !fields.host || typeof fields.createdAt !== "string" || !Number.isFinite(Date.parse(fields.createdAt))) return null;
  return {
    file, author: fields.author, host: fields.host, createdAt: fields.createdAt,
    ...(fields.author === "agent" ? {
      status: ["ok", "failed", "waiting", "timeout"].includes(fields.status) ? fields.status as RoutinePostStatus : "failed",
      sessionId: fields.sessionId || undefined,
      ...(fields.replyTo !== undefined ? { replyTo: fields.replyTo.split(",").filter((name) => REPLY_FILE_PATTERN.test(name)) } : {}),
    } : {}),
    body: normalized.slice(match[0].length).replace(/^\n/, "").trimEnd(),
  };
}

export function pendingReplies(replies: RoutineReply[], handled?: readonly string[]): RoutineReply[] {
  const answered = new Set<string>();
  const users = new Set<string>();
  for (const reply of replies) {
    if (reply.author === "user") users.add(reply.file);
    else for (const file of reply.replyTo ?? users) answered.add(file);
  }
  return replies.filter((reply) => reply.author === "user" && !answered.has(reply.file) && !handled?.includes(reply.file));
}
