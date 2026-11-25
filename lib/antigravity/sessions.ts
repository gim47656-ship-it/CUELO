import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AcpConnection, AntigravityError, object, resolveAgyBinary } from "./acp";
import { configOptions, contentBlock, records, sessionInfo, string, toolUpdate } from "./protocol";
import type { AcpContent, AntigravityEntry, AntigravityEvent, AntigravityProblem, AntigravitySessionInfo, AntigravityState } from "./types";

const IDLE_MS = 10 * 60_000;
const CANCEL_MS = 10_000;
type Timer = NodeJS.Timeout;
type KeepListening = (event: AntigravityEvent) => void;
type Patch = Partial<Omit<AntigravityState, "entries">>;
type Decision = { rpcId: number | string; allow?: string; deny?: string };

export function problem(error: unknown): AntigravityProblem {
  if (!(error instanceof AntigravityError)) return { code: "unavailable", error: "Could not connect to Antigravity." };
  const issue = { code: error.code, error: error.message };
  if (issue.code !== "auth_required") return issue;
  let command = "agy acp --login";
  try {
    const binary = resolveAgyBinary();
    const quoted = /^[a-zA-Z0-9/._-]+$/.test(binary) ? binary : `'${binary.replaceAll("'", "'\\''")}'`;
    command = `${quoted} acp --login`;
  } catch {
    // The executable can disappear after launch. Still return the auth problem.
  }
  return { ...issue, command };
}

class Conversation {
  readonly state: AntigravityState;
  readonly #listeners = new Set<KeepListening>();
  readonly #tools = new Map<string, number>();
  readonly #decisions = new Map<string, Decision>();
  #lastMessageId: string | undefined;
  #replaying: boolean;
  #prompts = 0;
  #latestSubmissionId: string | undefined;
  #configuring = false;
  #idle: Timer | undefined;
  #cancelTimer: Timer | undefined;
  #closing: Promise<void> | undefined;

  constructor(private readonly acp: AcpConnection, info: AntigravitySessionInfo, private readonly embeddedContext: boolean, image: boolean) {
    this.state = { serverId: registry.serverId, session: info, entries: [], options: [], permissions: [], plan: [], streaming: false, cancelling: false, image, problem: null };
    this.#replaying = Boolean(info.sessionId);
    acp.onNotification = (method, params) => {
      if (method === "session/update" && params.sessionId === this.state.session.sessionId) this.#update(object(params.update));
    };
    acp.onRequest = (id, method, params) => {
      if (method === "session/request_permission") this.#permission(id, params);
      else acp.unsupported(id);
    };
    acp.onDisconnect = (error) => { void this.close(error); };
  }

  setup(info: AntigravitySessionInfo, result: Record<string, unknown>) {
    this.#lastMessageId = undefined;
    this.#replaying = false;
    this.#patch({ session: { ...info, ...this.state.session, sessionId: info.sessionId }, options: configOptions(result.configOptions) });
    this.#touch();
  }

  subscribe(listener: KeepListening) {
    listener({ snapshot: this.state });
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  sendUserPrompt(prompt: AcpContent[], submissionId: string) {
    if (this.#closing || this.state.cancelling || this.#configuring) throw new AntigravityError("bad_request", "Antigravity is not ready to send.");
    if (!this.state.options.some((option) => option.kind === "model" && option.current)) {
      throw new AntigravityError("model_required", "Select a Gemini model before sending.");
    }
    if (!this.state.image && prompt.some((block) => block.type === "image")) throw new AntigravityError("bad_request", "This Antigravity version does not accept images.");
    const supported = this.embeddedContext ? prompt : prompt.map((block) => block.type === "resource" ? { type: "text" as const, text: block.resource.text } : block);
    clearTimeout(this.#idle);
    this.#lastMessageId = undefined;
    this.#entry({ type: "user", key: this.state.entries.length, content: prompt });
    this.#prompts++;
    this.#latestSubmissionId = submissionId;
    this.#patch({ streaming: true, problem: null });
    void this.acp.request("session/prompt", { sessionId: this.state.session.sessionId, prompt: supported }, 0).then(
      () => this.#finish(),
      (error: unknown) => this.#finish(error),
    );
  }

  async setOption(configId: string, value: string) {
    if (this.#closing || this.#configuring || this.#prompts) throw new AntigravityError("bad_request", "Wait for Antigravity to finish before changing options.");
    const option = this.state.options.find((item) => item.id === configId);
    if (!option?.choices.some((choice) => choice.value === value)) throw new AntigravityError("bad_request", "Unknown Antigravity option.");
    this.#configuring = true;
    clearTimeout(this.#idle);
    try {
      const result = await this.acp.request("session/set_config_option", { sessionId: this.state.session.sessionId, configId, value });
      this.#patch({ options: configOptions(result.configOptions) });
    } catch (error) {
      if (error instanceof AntigravityError && error.code === "auth_required") await this.close(error);
      throw error;
    } finally {
      this.#configuring = false;
      if (!this.#closing) this.#touch();
    }
  }

  cancel() {
    if (!this.#prompts || this.state.cancelling || this.#closing) return;
    this.#patch({ cancelling: true });
    this.acp.notify("session/cancel", { sessionId: this.state.session.sessionId });
    this.#cancelPermissions();
    this.#cancelTimer = setTimeout(() => { void this.close(new AntigravityError("disconnected", "Antigravity did not finish cancelling.")); }, CANCEL_MS);
    this.#cancelTimer.unref();
  }

  decide(id: string, allow: boolean) {
    const decision = this.#decisions.get(id);
    if (!decision || (allow && !decision.allow)) throw new AntigravityError("bad_request", "This permission choice is no longer available.");
    const optionId = allow ? decision.allow : decision.deny;
    this.acp.reply(decision.rpcId, { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    this.#decisions.delete(id);
    this.#patch({ permissions: this.state.permissions.filter((item) => item.id !== id) });
  }

  close(error = new AntigravityError("disconnected", "Antigravity connection closed.")): Promise<void> {
    if (this.#closing) return this.#closing;
    clearTimeout(this.#idle);
    clearTimeout(this.#cancelTimer);
    this.cancel();
    clearTimeout(this.#cancelTimer);
    this.#cancelPermissions();
    this.#patch({ streaming: false, cancelling: false, closed: true, problem: problem(error) });
    this.#listeners.clear();
    const closing = closeConnection(this.acp).finally(() => {
      const id = this.state.session.sessionId;
      if (registry.open.get(id) === this) registry.open.delete(id);
    });
    this.#closing = closing;
    return closing;
  }

  #emit(event: AntigravityEvent) { for (const listener of this.#listeners) listener(event); }

  #patch(state: Patch) {
    Object.assign(this.state, state);
    this.#emit({ state });
  }

  #entry(entry: AntigravityEntry, append = false) {
    const previous = this.state.entries[entry.key];
    if (append && previous && "content" in previous && "content" in entry) {
      const tail = previous.content.at(-1);
      const head = entry.content[0];
      if (tail?.type === "text" && head?.type === "text") tail.text += head.text;
      else previous.content.push(...entry.content);
    } else {
      this.state.entries[entry.key] = entry;
    }
    this.#emit({ entry, append });
  }

  #touch() {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => { void this.close(); }, IDLE_MS);
    this.#idle.unref();
  }

  #finish(error?: unknown) {
    this.#prompts--;
    if (this.#closing) return;
    if (error instanceof AntigravityError && error.code === "auth_required") {
      void this.close(error);
      return;
    }
    if (error) this.#patch({ problem: problem(error) });
    if (this.#prompts > 0) return;
    clearTimeout(this.#cancelTimer);
    this.#cancelPermissions();
    this.#patch({ streaming: false, cancelling: false, settledSubmissionId: this.#latestSubmissionId });
    this.#touch();
  }

  #cancelPermissions() {
    if (!this.#decisions.size) return;
    for (const { rpcId } of this.#decisions.values()) this.acp.reply(rpcId, { outcome: { outcome: "cancelled" } });
    this.#decisions.clear();
    this.#patch({ permissions: [] });
  }

  #permission(rpcId: number | string, params: Record<string, unknown>) {
    const update = object(params.toolCall);
    const key = this.#tools.get(string(update.toolCallId) ?? "");
    const entry = key === undefined ? undefined : this.state.entries[key];
    const tool = toolUpdate(update, entry?.type === "tool" ? entry.tool : undefined);
    if (params.sessionId !== this.state.session.sessionId || !this.#prompts || this.state.cancelling || this.#closing || !tool) {
      this.acp.reply(rpcId, { outcome: { outcome: "cancelled" } });
      return;
    }
    const options = records(params.options);
    const allow = string(options.find((item) => item.kind === "allow_once")?.optionId);
    const deny = string(options.find((item) => item.kind === "reject_once")?.optionId);
    const id = randomUUID();
    this.#decisions.set(id, { rpcId, allow, deny });
    this.#patch({ permissions: [...this.state.permissions, { id, tool, canAllow: Boolean(allow) }] });
  }

  #update(update: Record<string, unknown>) {
    const variant = update.sessionUpdate;
    if (variant === "agent_message_chunk" || variant === "agent_thought_chunk" || (variant === "user_message_chunk" && this.#replaying)) {
      const content = contentBlock(update.content);
      if (!content) return;
      const type = variant === "agent_message_chunk" ? "assistant" : variant === "agent_thought_chunk" ? "thought" : "user";
      const id = string(update.messageId);
      const last = this.state.entries.at(-1);
      const append = last?.type === type && id === this.#lastMessageId;
      this.#lastMessageId = id;
      this.#entry({ type, key: append ? last.key : this.state.entries.length, content: [content] }, append);
    } else if (variant === "tool_call" || variant === "tool_call_update") {
      const id = string(update.toolCallId);
      if (!id) return;
      const key = this.#tools.get(id) ?? this.state.entries.length;
      const previous = this.state.entries[key];
      const tool = toolUpdate(update, previous?.type === "tool" ? previous.tool : undefined);
      if (!tool) return;
      this.#tools.set(id, key);
      this.#entry({ key, type: "tool", tool });
    } else if (variant === "plan") {
      this.#patch({ plan: records(update.entries).flatMap(({ content, status }) => typeof content === "string" && typeof status === "string" ? [{ content, status }] : []) });
    } else if (variant === "config_option_update") {
      this.#patch({ options: configOptions(update.configOptions) });
    } else if (variant === "session_info_update") {
      const session = this.state.session;
      this.#patch({ session: { ...session, title: "title" in update ? string(update.title) : session.title, updatedAt: "updatedAt" in update ? string(update.updatedAt) : session.updatedAt } });
    }
  }
}

interface Registry {
  serverId: string;
  open: Map<string, Conversation>;
  connecting: Map<string, Promise<Conversation>>;
  children: Map<AcpConnection, Promise<void> | null>;
}
const scope = globalThis as typeof globalThis & { __cueloAntigravity?: Registry };
const registry = scope.__cueloAntigravity ??= { serverId: randomUUID(), open: new Map(), connecting: new Map(), children: new Map() };

function trackConnection(cwd: string) {
  const acp = new AcpConnection(cwd);
  if (registry.children.size === 0) {
    process.once("exit", terminateOnExit);
    process.prependListener("SIGTERM", onSigterm);
    process.prependListener("SIGINT", onSigint);
  }
  registry.children.set(acp, null);
  return acp;
}

function terminateOnExit() {
  for (const child of registry.children.keys()) child.terminate("SIGKILL");
}

function onSigterm() {
  terminateOnExit();
  if (process.listenerCount("SIGTERM") === 1) process.exit(143);
}

function onSigint() {
  terminateOnExit();
  if (process.listenerCount("SIGINT") === 1) process.exit(130);
}

function closeConnection(acp: AcpConnection): Promise<void> {
  const closing = registry.children.get(acp);
  if (closing) return closing;
  const done = acp.close().finally(() => {
    registry.children.delete(acp);
    if (registry.children.size === 0) {
      process.removeListener("exit", terminateOnExit);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
    }
  });
  registry.children.set(acp, done);
  return done;
}

export async function drainAntigravity(): Promise<void> {
  const reason = new AntigravityError("update_draining", "CUELO is updating.");
  await Promise.all([...registry.open.values()].map((session) => session.close(reason)).concat(
    [...registry.children.keys()].map(closeConnection),
  ));
}

async function listPage(acp: AcpConnection, cwd: string, cursor?: string) {
  const result = await acp.request("session/list", cursor ? { cwd, cursor } : { cwd });
  const matches = await Promise.all(records(result.sessions).map(async (value) => {
    const info = sessionInfo(value);
    if (!info || !isAbsolute(info.cwd)) return null;
    if (info.cwd === cwd) return info;
    try { return await realpath(info.cwd) === cwd ? { ...info, cwd } : null; }
    catch { return null; }
  }));
  return { sessions: matches.filter((info) => info !== null), nextCursor: string(result.nextCursor) };
}

export async function listAntigravity(cwd: string, cursor?: string) {
  const acp = trackConnection(cwd);
  try {
    const capabilities = await acp.initialize();
    if (!object(capabilities.sessionCapabilities).list) throw new AntigravityError("unavailable", "Antigravity did not advertise session history.");
    const page = await listPage(acp, cwd, cursor);
    if (!cursor) {
      for (const live of registry.open.values()) {
        const info = live.state.session;
        if (info.cwd === cwd && !page.sessions.some((item) => item.sessionId === info.sessionId)) page.sessions.unshift(info);
      }
    }
    return page;
  } finally {
    await closeConnection(acp);
  }
}

async function listedSession(acp: AcpConnection, cwd: string, id: string): Promise<AntigravitySessionInfo> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await listPage(acp, cwd, cursor);
    const info = page.sessions.find((item) => item.sessionId === id);
    if (info) return info;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) break;
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw new AntigravityError("bad_request", "No Antigravity conversation with that ID in this project.");
}

async function connect(cwd: string, id?: string): Promise<Conversation> {
  const acp = trackConnection(cwd);
  try {
    const capabilities = await acp.initialize();
    const prompt = object(capabilities.promptCapabilities);
    if (id && (!capabilities.loadSession || !object(capabilities.sessionCapabilities).list)) {
      throw new AntigravityError("unavailable", "Antigravity did not advertise history replay.");
    }
    const info = id ? await listedSession(acp, cwd, id) : { cwd, sessionId: "" };
    const session = new Conversation(acp, info, prompt.embeddedContext === true, prompt.image === true);
    const workspace = { cwd, mcpServers: [] };
    const result = id ? await acp.request("session/load", { ...workspace, sessionId: id }, 60_000) : await acp.request("session/new", workspace);
    const sessionId = id ?? string(result.sessionId);
    if (!sessionId || registry.open.has(sessionId)) throw new AntigravityError("unavailable", "Antigravity returned an invalid or duplicate session ID.");
    session.setup({ ...info, sessionId }, result);
    registry.open.set(sessionId, session);
    return session;
  } catch (error) {
    acp.onDisconnect = undefined;
    await closeConnection(acp);
    throw error;
  }
}

export async function openAntigravity(cwd: string, id?: string) {
  if (!id) return connect(cwd);
  const live = activeAntigravity(cwd, id);
  if (live) return live;
  const key = `${cwd}\0${id}`;
  let pending = registry.connecting.get(key);
  if (!pending) {
    const previous = registry.open.get(id);
    pending = (async () => {
      if (previous?.state.session.cwd === cwd && previous.state.closed) await previous.close();
      return connect(cwd, id);
    })().finally(() => registry.connecting.delete(key));
    registry.connecting.set(key, pending);
  }
  return pending;
}

export function activeAntigravity(cwd: string, id: string) {
  const session = registry.open.get(id);
  return session?.state.session.cwd === cwd && !session.state.closed ? session : undefined;
}
