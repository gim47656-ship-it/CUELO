import type { AgentMessage } from "@/lib/types";

/**
 * 실행 중에 보낸 입력(지금 지시 = steer, 완료 후 요청 = follow-up)이 어디까지 갔는지의 관측 기록.
 *
 * 단계는 관측한 사건으로만 넘어간다.
 * - `sending`: 명령을 보냈고 서버 응답을 기다린다.
 * - `accepted`: 서버가 명령을 받았거나(응답) 서버 큐에 그 글이 보였다.
 * - `delivered`: 같은 글의 user `message_end`가 왔다 — 대화 기록(모델 문맥)에 들어갔다.
 * - `unconfirmed`: 서버 큐에서 빠졌는데 같은 글의 user `message_end`를 찾지 못했다. 전달됐다고
 *   추정하지 않는다. 그 뒤 같은 글이 기록되면 `delivered`로 올라간다.
 * - `failed`: 명령이 실패해 글이 입력창으로 돌아갔다.
 *
 * 모델이 그 지시를 실제로 따랐는지(반영)는 관측할 수단이 없어 단계로 두지 않는다.
 */
export type DeliveryKind = "steer" | "followUp";
export type DeliveryStage = "sending" | "accepted" | "delivered" | "unconfirmed" | "failed";

export interface DeliveryEntry {
  id: number;
  kind: DeliveryKind;
  text: string;
  stage: DeliveryStage;
  /** 마지막 큐 관측에서 서버 큐에 이 글이 있었는가. */
  inQueue: boolean;
}

export type DeliveryAction =
  | { type: "submit"; id: number; kind: DeliveryKind; text: string }
  | { type: "ack"; id: number }
  | { type: "fail"; id: number }
  | { type: "queue"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "user-message"; text: string }
  /** 사용자가 큐에서 거둔 글. text가 없으면 큐 전체를 거둔 것(recall)이다. */
  | { type: "withdraw"; kind?: DeliveryKind; text?: string }
  /** 실행이 끝나 세션이 idle이 됐다. 아직 서버 큐에 남은 글만 남긴다. */
  | { type: "idle" }
  | { type: "reset" };

/** 끝난 행은 이만큼만 남긴다. 대화 기록에 이미 있는 글을 입력창 위에 쌓아 두지 않는다. */
const MAX_SETTLED_ENTRIES = 4;

const PENDING_STAGES: Record<DeliveryStage, boolean> = {
  sending: true,
  accepted: true,
  delivered: false,
  unconfirmed: false,
  failed: false,
};

function normalize(text: string): string {
  return text.trim();
}

function trimSettled(entries: DeliveryEntry[]): DeliveryEntry[] {
  const settled = entries.filter((entry) => !PENDING_STAGES[entry.stage]);
  if (settled.length <= MAX_SETTLED_ENTRIES) return entries;
  const drop = new Set(settled.slice(0, settled.length - MAX_SETTLED_ENTRIES).map((entry) => entry.id));
  return entries.filter((entry) => !drop.has(entry.id));
}

function applyQueue(entries: DeliveryEntry[], steering: readonly string[], followUp: readonly string[]): DeliveryEntry[] {
  // 같은 글이 여러 번 큐에 있을 수 있으니 남은 개수로 짝짓는다. 먼저 보낸 것부터 큐 자리를 차지한다.
  const remaining = new Map<string, number>();
  const bump = (kind: DeliveryKind, text: string) => {
    const key = `${kind}\u0000${normalize(text)}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  };
  for (const text of steering) bump("steer", text);
  for (const text of followUp) bump("followUp", text);

  let changed = false;
  const next = entries.map((entry) => {
    if (!PENDING_STAGES[entry.stage]) return entry;
    const key = `${entry.kind}\u0000${normalize(entry.text)}`;
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      if (entry.inQueue && entry.stage === "accepted") return entry;
      changed = true;
      return { ...entry, stage: "accepted" as const, inQueue: true };
    }
    if (entry.inQueue) {
      // 큐에 있던 글이 빠졌다. 같은 글의 user message_end가 먼저 왔다면 이미 delivered다.
      changed = true;
      return { ...entry, stage: "unconfirmed" as const, inQueue: false };
    }
    return entry;
  });
  return changed ? next : entries;
}

export function deliveryReducer(entries: DeliveryEntry[], action: DeliveryAction): DeliveryEntry[] {
  switch (action.type) {
    case "submit":
      return trimSettled([...entries, { id: action.id, kind: action.kind, text: action.text, stage: "sending", inQueue: false }]);
    case "ack":
      return entries.map((entry) => (entry.id === action.id && entry.stage === "sending" ? { ...entry, stage: "accepted" } : entry));
    case "fail":
      return trimSettled(entries.map((entry) => (
        entry.id === action.id && PENDING_STAGES[entry.stage] ? { ...entry, stage: "failed", inQueue: false } : entry
      )));
    case "queue":
      return applyQueue(entries, action.steering, action.followUp);
    case "user-message": {
      const text = normalize(action.text);
      if (!text) return entries;
      const target = entries.find((entry) => (
        (PENDING_STAGES[entry.stage] || entry.stage === "unconfirmed") && normalize(entry.text) === text
      ));
      if (!target) return entries;
      return trimSettled(entries.map((entry) => (entry === target ? { ...entry, stage: "delivered", inQueue: false } : entry)));
    }
    case "withdraw": {
      // 사용자가 거둔 글. 큐 갱신이 거둠 응답보다 먼저 와 `unconfirmed`가 됐어도 함께 지운다.
      const withdrawable = (entry: DeliveryEntry) => PENDING_STAGES[entry.stage] || entry.stage === "unconfirmed";
      if (action.text === undefined) return entries.filter((entry) => !withdrawable(entry));
      const text = normalize(action.text);
      const target = entries.find((entry) => (
        withdrawable(entry) && entry.kind === action.kind && normalize(entry.text) === text
      ));
      return target ? entries.filter((entry) => entry !== target) : entries;
    }
    case "idle": {
      const next = entries.filter((entry) => entry.inQueue);
      return next.length === entries.length ? entries : next;
    }
    case "reset":
      return entries.length === 0 ? entries : [];
  }
}

/** 입력창 위 큐 패널의 한 줄. */
export interface DeliveryRow {
  key: string;
  kind: DeliveryKind;
  text: string;
  stage: DeliveryStage;
  /** 서버 큐에 있어 지금 거둘 수 있다. */
  removable: boolean;
}

/**
 * 추적 중인 기록과 서버 큐를 한 목록으로 합친다. 이 탭이 보내지 않은 큐 항목(다른 탭·새로고침 전)은
 * 서버 큐에 보였다는 사실만으로 `accepted`다.
 */
export function buildDeliveryRows(
  entries: readonly DeliveryEntry[],
  queue: { steering: readonly string[]; followUp: readonly string[] } | null | undefined,
): DeliveryRow[] {
  const tracked = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.inQueue) continue;
    const key = `${entry.kind}\u0000${normalize(entry.text)}`;
    tracked.set(key, (tracked.get(key) ?? 0) + 1);
  }
  const rows: DeliveryRow[] = [];
  const untracked = (kind: DeliveryKind, texts: readonly string[]) => {
    texts.forEach((text, index) => {
      const key = `${kind}\u0000${normalize(text)}`;
      const covered = tracked.get(key) ?? 0;
      if (covered > 0) {
        tracked.set(key, covered - 1);
        return;
      }
      rows.push({ key: `queue-${kind}-${index}`, kind, text, stage: "accepted", removable: true });
    });
  };
  untracked("steer", queue?.steering ?? []);
  untracked("followUp", queue?.followUp ?? []);
  for (const entry of entries) {
    rows.push({ key: `sent-${entry.id}`, kind: entry.kind, text: entry.text, stage: entry.stage, removable: entry.inQueue });
  }
  return rows;
}

/** user 메시지의 글. 전달 판정은 이 글이 보낸 글과 같은지로만 한다. */
export function userMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
