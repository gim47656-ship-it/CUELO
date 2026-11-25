export type AcpContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; size?: number };

export interface AntigravitySessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface AntigravityOption {
  id: string;
  kind: "model" | "thinking";
  current: string;
  choices: { value: string; name: string }[];
}

export interface AntigravityTool {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  kind?: string;
  paths?: string[];
  input?: string;
  output?: string;
  diffs?: { path: string; oldText: string | null; newText: string }[];
}

export interface AntigravityPermission {
  id: string;
  tool: AntigravityTool;
  canAllow: boolean;
}

export type AntigravityEntry =
  | { key: number; type: "user" | "assistant" | "thought"; content: AcpContent[] }
  | { key: number; type: "tool"; tool: AntigravityTool };

export type AntigravityErrorCode = "auth_required" | "not_installed" | "unavailable" | "model_required" | "disconnected" | "update_draining" | "bad_request";
export interface AntigravityProblem { code: AntigravityErrorCode; error: string; command?: string }

export interface AntigravityState {
  serverId: string;
  settledSubmissionId?: string;
  session: AntigravitySessionInfo;
  entries: AntigravityEntry[];
  options: AntigravityOption[];
  permissions: AntigravityPermission[];
  plan: { content: string; status: string }[];
  streaming: boolean;
  cancelling: boolean;
  closed?: boolean;
  image: boolean;
  problem: AntigravityProblem | null;
}

export type AntigravityEvent =
  | { snapshot: AntigravityState }
  | { state: Partial<Omit<AntigravityState, "entries">> }
  | { entry: AntigravityEntry; append?: boolean };

export function applyAntigravityEvent(state: AntigravityState, event: Exclude<AntigravityEvent, { snapshot: AntigravityState }>): AntigravityState {
  if ("state" in event) return { ...state, ...event.state };
  const { entry, append } = event;
  // Keys are zero-based indices and entries never move during a connection.
  const entries = state.entries.slice();
  const previous = entries[entry.key];
  if (append && "content" in entry && previous && "content" in previous) {
    const content = previous.content.slice();
    const last = content.at(-1);
    const first = entry.content[0];
    if (last?.type === "text" && first?.type === "text") {
      content[content.length - 1] = { type: "text", text: last.text + first.text };
      content.push(...entry.content.slice(1));
    } else {
      content.push(...entry.content);
    }
    entries[entry.key] = { ...entry, content };
  } else {
    entries[entry.key] = entry;
  }
  return { ...state, entries };
}
