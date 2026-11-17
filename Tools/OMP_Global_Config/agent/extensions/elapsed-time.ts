import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIME_MATTERS = "Time matters here: do not spend time that can be avoided, and the earlier a correct result is obtained, the better.";

type UserSide = Extract<AgentMessage, { role: "user" | "toolResult" | "custom" }>;

function isUserSide(message: AgentMessage): message is UserSide {
  return message.role === "user" || message.role === "toolResult"
    || (message.role === "custom" && message.customType === "irc:incoming");
}

function appendText(message: UserSide, text: string, separateBlock: boolean): UserSide {
  const content = typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : [...message.content];
  if (!separateBlock) {
    for (let index = content.length - 1; index >= 0; index--) {
      const block = content[index];
      if (block.type !== "text") continue;
      content[index] = { ...block, text: `${block.text}\n\n${text}` };
      return { ...message, content };
    }
  }
  content.push({ type: "text", text });
  return { ...message, content };
}

/** Context receives a fresh history copy each call; reconstruct prior placements, never refresh them. */
export default function elapsedTime(pi: ExtensionAPI): void {
  pi.on("context", (event, ctx) => {
    if (ctx.agent?.kind !== "sub" || ctx.agent.name !== "maker") return;
    // The full branch retains the task even when compaction removes it from outgoing context.
    const task = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
    // On the first call the task is still in flight and has not been persisted yet.
    const taskMessage = task?.type === "message" ? task.message : event.messages.find((message) => message.role === "user");
    if (!taskMessage) return;
    const origin = taskMessage.timestamp;
    const first = event.messages.findIndex((message) => message.role === "user" && message.timestamp === origin);
    const selected = new Set<number>();
    let newest = -1;
    for (let index = Math.max(0, first); index < event.messages.length; index++) {
      const message = event.messages[index];
      if (isUserSide(message)) newest = index;
      // A completed assistant turn proves which user-side tail the preceding request saw.
      if (message.role === "assistant" && newest >= 0) selected.add(newest);
    }
    if (newest >= 0) selected.add(newest);

    const messages = [...event.messages];
    // Add the sentence only to the original task, never to a later post-compaction steer.
    if (first >= 0) messages[first] = appendText(event.messages[first] as UserSide, TIME_MATTERS, false);
    for (const index of selected) {
      const message = messages[index] as UserSide;
      // Arrival time is deterministic across deep copies, reloads and retries without new input.
      const seconds = Math.floor(Math.max(0, message.timestamp - origin) / 1000);
      messages[index] = appendText(message, `[elapsed ${seconds}s]`, message.role !== "toolResult");
    }
    return { messages };
  });
}
