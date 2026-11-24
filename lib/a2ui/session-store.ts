import type { ActionPayload, MessageProcessor, SurfaceModel } from "@a2ui/web_core";
import {
  blockTargets,
  buildActionEnvelope,
  collectA2uiBlocks,
  formatActionMessage,
  parseA2uiBlock,
  parseActionBlock,
  sharedPrefixLength,
  type A2uiSourceBlock,
} from "./blocks";

/** What one agent `a2ui` block did, as its fence renders it. */
export interface A2uiBlockView {
  /** The block could not be read (`json`/`shape`/`empty`) or the processor rejected part of it. */
  error: null | { reason: "json" | "shape" | "empty" | "processor"; detail?: string };
  /** Surfaces this block created; a fence shows the ones still live in the processor. */
  surfaces: SurfaceModel<never>[];
  created: string[];
  updated: string[];
  deleted: string[];
  /** Updated or deleted surfaces that were not loaded when the block ran. */
  missing: string[];
}

/** Where a card's last action stands until its user message shows up in the transcript. */
export type A2uiActionState = "sending" | "queued" | "failed";

/** How the chat delivered an action message: a new prompt, a queued follow-up, or not at all. */
export type A2uiSendOutcome = "prompt" | "followUp" | "failed";

// The store only reads ids and data models, so the catalog's component type does not matter here.
type Processor = MessageProcessor<never>;
interface AppliedBlock { kind: A2uiSourceBlock["kind"]; code: string; view: A2uiBlockView | null }

const SURFACE_NOT_FOUND = /surface not found/i;

/**
 * One A2UI message processor for one chat session view.
 *
 * Blocks apply in transcript order once their message is in the finished
 * transcript. A sync whose block sequence still starts with everything already
 * applied applies only the new blocks, so live cards keep their state and their
 * DOM; any other change rebuilds the processor from the whole transcript.
 * Rendering reads results by position: the chat may render an assistant
 * message through a copy holding only some of its parts, so a fence names its
 * text part, which each sync maps to (message index, part index).
 */
export class A2uiSessionStore {
  private processor: Processor;
  private applied: AppliedBlock[] = [];
  private byPosition = new Map<string, AppliedBlock[]>();
  private partPosition = new Map<object, string>();
  private lastMessages: readonly object[] | null = null;
  /** Action blocks this page sent; their data model is already in the processor. */
  private readonly sentCodes = new Set<string>();
  private readonly pending = new Map<string, A2uiActionState>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private dirty = false;

  constructor(
    private readonly createProcessor: (onAction: (action: ActionPayload) => void) => Processor,
    private readonly send: (text: string) => Promise<A2uiSendOutcome>,
  ) {
    this.processor = createProcessor(this.handleAction);
  }

  /** Brings the processor up to `messages`. Idempotent per array; listeners hear about it on `flush`. */
  sync(messages: readonly { role: string; content?: unknown }[]): void {
    if (messages === this.lastMessages) return;
    this.lastMessages = messages;
    this.partPosition = new Map();
    messages.forEach((message, messageIndex) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) return;
      message.content.forEach((part: unknown, partIndex) => {
        if (typeof part === "object" && part !== null) this.partPosition.set(part, positionKey(messageIndex, partIndex));
      });
    });
    const blocks = collectA2uiBlocks(messages);
    const shared = sharedPrefixLength(this.applied, blocks);
    if (shared < this.applied.length) {
      this.processor.dispose();
      this.processor = this.createProcessor(this.handleAction);
      this.applied = [];
      this.pending.clear();
      // The new processor has none of this page's sent edits; their transcript copies replay below.
      this.sentCodes.clear();
      for (const block of blocks) this.applied.push(this.apply(block, false));
    } else {
      for (const block of blocks.slice(shared)) this.applied.push(this.apply(block, true));
    }
    this.byPosition = new Map();
    blocks.forEach((block, index) => {
      const key = positionKey(block.messageIndex, block.partIndex);
      const list = this.byPosition.get(key) ?? [];
      list.push(this.applied[index]);
      this.byPosition.set(key, list);
    });
    this.dirty = true;
  }

  /** Notifies subscribers after a sync; call from a layout effect. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.bump();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /**
   * The result of the agent block in assistant text part `part`: the block at
   * `ordinal` among that part's fences when its text matches, else the first
   * block with the same text.
   */
  lookup(part: object, ordinal: number | undefined, code: string): A2uiBlockView | undefined {
    const key = this.partPosition.get(part);
    if (key === undefined) return undefined;
    const list = this.byPosition.get(key) ?? [];
    const atOrdinal = ordinal === undefined ? undefined : list[ordinal];
    const entry = atOrdinal?.code === code ? atOrdinal : list.find((block) => block.code === code);
    return entry?.view ?? undefined;
  }

  /** The surface as the processor holds it now, or undefined once deleted or rebuilt away. */
  liveSurface(surface: SurfaceModel<never>): boolean {
    return this.processor.getSurface(surface.id) === surface;
  }

  actionState(surfaceId: string): A2uiActionState | undefined {
    return this.pending.get(surfaceId);
  }

  dispose(): void {
    this.processor.dispose();
    this.listeners.clear();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private apply(block: A2uiSourceBlock, incremental: boolean): AppliedBlock {
    if (block.kind === "action") {
      this.applyAction(block.code, incremental);
      return { kind: block.kind, code: block.code, view: null };
    }
    return { kind: block.kind, code: block.code, view: this.applyAgent(block.code) };
  }

  private applyAgent(code: string): A2uiBlockView {
    const parsed = parseA2uiBlock(code);
    if (!parsed.ok) {
      return { error: { reason: parsed.reason }, surfaces: [], created: [], updated: [], deleted: [], missing: [] };
    }
    const targets = blockTargets(parsed.messages);
    const before = new Set(this.processor.getSurfaces().keys());
    const errors = this.processor.processMessagesWithErrors(parsed.messages).map((message) => message.error);
    // An update or delete whose surface did not exist when that message ran is a skip, not a fault.
    const isMissing = (error: (typeof errors)[number]) => Boolean(error.surfaceId) && SURFACE_NOT_FOUND.test(error.message);
    const missing = [...new Set(errors.filter(isMissing).map((error) => error.surfaceId as string))];
    const faults = errors.filter((error) => !isMissing(error));
    const faulted = new Set(faults.map((error) => error.surfaceId).filter(Boolean));
    const surfaces = targets.created
      .filter((id) => !before.has(id))
      .map((id) => this.processor.getSurface(id))
      .filter((surface): surface is SurfaceModel<never> => surface !== undefined);
    return {
      error: faults.length > 0 ? { reason: "processor", detail: faults.map((error) => error.message || error.code).filter(Boolean).join(" / ") } : null,
      surfaces,
      created: targets.created,
      updated: targets.updated.filter((id) => !faulted.has(id) && !missing.includes(id)),
      deleted: targets.deleted.filter((id) => !faulted.has(id) && !missing.includes(id)),
      missing,
    };
  }

  private applyAction(code: string, incremental: boolean): void {
    const envelope = parseActionBlock(code);
    if (!envelope) return;
    const surfaceId = envelope.action.surfaceId;
    if (this.sentCodes.has(code)) {
      this.pending.delete(surfaceId);
      if (incremental) return;
    }
    const model = envelope.metadata?.a2uiClientDataModel.surfaces[surfaceId];
    if (model === undefined || !this.processor.getSurface(surfaceId)) return;
    this.processor.processMessagesWithErrors([{ version: "1.0", updateDataModel: { surfaceId, path: "/", value: model } }]);
  }

  private handleAction = (action: ActionPayload): void => {
    const surface = this.processor.getSurface(action.surfaceId);
    if (this.pending.get(action.surfaceId) === "sending" || this.pending.get(action.surfaceId) === "queued") return;
    const envelope = buildActionEnvelope(action, surface?.sendDataModel ? surface.dataModel.get("/") : undefined);
    const text = formatActionMessage(envelope);
    this.sentCodes.add(JSON.stringify(envelope));
    this.pending.set(action.surfaceId, "sending");
    this.bump();
    const settle = (outcome: A2uiSendOutcome) => {
      if (this.pending.get(action.surfaceId) === undefined) return;
      if (outcome === "failed") this.pending.set(action.surfaceId, "failed");
      else if (outcome === "followUp") this.pending.set(action.surfaceId, "queued");
      this.bump();
    };
    void Promise.resolve().then(() => this.send(text)).then(settle, () => settle("failed"));
  };
}

function positionKey(messageIndex: number, partIndex: number): string {
  return `${messageIndex}:${partIndex}`;
}
