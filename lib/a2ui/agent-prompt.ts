import type { ExtensionAPI, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { A2UI_ACTION_LANG, extractFencedBlocks, parseActionBlock } from "./blocks";

/** Catalog id agents use for CUELO answer cards (the basic catalog id renders with the same components). */
export const CUELO_A2UI_CATALOG_ID = "cuelo";

/** Component names the web chat renders; kept in step with `components/a2ui/catalog.tsx`. */
export const CUELO_A2UI_COMPONENTS = [
  "Card", "Column", "Row", "List", "Tabs", "Text", "Stat", "Progress", "BarChart", "Image",
  "Button", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput",
] as const;

/** Full answer-card instructions, delivered as hidden context on relevant web requests. */
export const A2UI_AGENT_PROMPT = `# Answer cards (A2UI)
This web chat renders A2UI v1.0 cards. Use one when a visual summary, a set of choices, or progress/status reads better than prose. Keep a short plain-text explanation next to every card; skip cards for plain answers.

Write a fenced code block with language \`a2ui\` holding a JSON array of A2UI v1.0 messages (one message per line also works). The card appears where the block is. Write the block complete in one message.
- createSurface: {"version":"1.0","createSurface":{"surfaceId":"weekly-tasks","catalogId":"${CUELO_A2UI_CATALOG_ID}","sendDataModel":true}}
- updateComponents: flat list, tree root has id "root", children by id: {"version":"1.0","updateComponents":{"surfaceId":"weekly-tasks","components":[{"id":"root","component":"Card","child":"col"},{"id":"col","component":"Column","children":["t","p"]},{"id":"t","component":"Text","text":"This week"},{"id":"p","component":"Progress","label":"Report","value":{"@path":"/report"},"max":100}]}}
- updateDataModel: {"version":"1.0","updateDataModel":{"surfaceId":"weekly-tasks","path":"/report","value":60}}
- deleteSurface: {"version":"1.0","deleteSurface":{"surfaceId":"weekly-tasks"}}

Components: ${CUELO_A2UI_COMPONENTS.join(", ")}.
Stat {label, value, delta?, trend?: "up"|"down"|"flat"}; Progress {label, value, max?, caption?}; BarChart {title?, labels: [..], values: [numbers], unit?}; Image shows only data:image URIs. Text takes markdown ("### Title" for a heading). Use one Card at the root and do not nest Cards. Component ids are identifiers (letters, digits, _; no hyphens). Values may be literals or {"@path":"/json/pointer"} bindings. Use only real numbers from the conversation.

surfaceId must be unique in this session; use descriptive ids (e.g. "plan-choice"). To change a card later, send updateDataModel (narrowest path, so text the user typed elsewhere stays) or updateComponents with the same surfaceId; do not create it again.

Buttons: {"component":"Button","child":"choose_a_label","variant":"primary","action":{"event":{"name":"choose","context":{"option":"A"}}}}. Inputs bind their value with {"@path":...}. When the user clicks, you receive a user message with an \`a2ui-action\` block: {"version":"1.0","action":{"name","surfaceId","sourceComponentId","timestamp","context"},"metadata":{"a2uiClientDataModel":{"surfaces":{...}}}} (data model only when sendDataModel is true). Answer it like a normal user request.`;

// A small usable example lets the model choose a simple card even when the
// user's initial text gave no cue (e.g. a visual summary of later tool results).
const A2UI_HINT = `For a useful visual summary, choice or progress, use the on-demand A2UI guide or adapt this \`a2ui\` fenced JSON example (unique surfaceId; add short prose): [{"version":"1.0","createSurface":{"surfaceId":"summary","catalogId":"${CUELO_A2UI_CATALOG_ID}"}},{"version":"1.0","updateComponents":{"surfaceId":"summary","components":[{"id":"root","component":"Card","child":"t"},{"id":"t","component":"Text","text":"Summary"}]}}]`;

const CARD_REQUEST_EN = /\b(?:a2ui(?!-action)|(?:answer|summary|status|progress|comparison|visual|interactive) cards?|card format|cards? please|(?:make|create|show|render|use|as) (?:me )?(?:a |the )?cards?|compar(?:e|ing|ison)|trade-?offs?|(?:progress|status) (?:report|update|summary|overview)|visual (?:summary|report)|infographic|(?:make|draw|plot|show) (?:a )?(?:(?:bar|line|pie) )?chart)\b/i;
const CARD_REQUEST_KO = /답변\s*카드|(?:요약|비교)\s*카드|카드(?:로|(?:를|\s*하나)?\s*(?:만들|보여|그려))|비교|선택지|대안|장단점|진행\s*상황|상태\s*요약|현황\s*(?:요약|보고)|시각화/;
const GUIDE_TYPE = "cuelo-a2ui-guide";

/**
 * True when this exact guide is still in the model context: on the branch after the latest
 * compaction or `/clear` boundary. Re-sending it there adds the same 2.5k characters again
 * (2026-11-28 nightly: 6 of 11 home and 6 of 15 office guides were such repeats).
 */
function guideInContext(branch: readonly SessionEntry[]): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "compaction" || entry.type === "reset_boundary") return false;
    if (entry.type === "custom_message" && entry.customType === GUIDE_TYPE && entry.content === A2UI_AGENT_PROMPT) return true;
  }
  return false;
}

/** When the SDK cannot load inline extensions, keep the existing static card spec. */
export function withA2uiAgentPrompt(appendPrompt: string | undefined, onDemand = true): string {
  const cardPrompt = onDemand ? A2UI_HINT : A2UI_AGENT_PROMPT;
  return appendPrompt ? `${appendPrompt}\n\n${cardPrompt}` : cardPrompt;
}

export function registerA2uiAgentPrompt(pi: ExtensionAPI): void {
  // SDK preparation also runs on delivery of steering and queued follow-ups.
  pi.on("before_agent_start", ({ reason, prompt }, ctx) => {
    if (reason !== "prompt") return;
    if (!CARD_REQUEST_EN.test(prompt) && !CARD_REQUEST_KO.test(prompt)
      && !extractFencedBlocks(prompt, A2UI_ACTION_LANG).some(parseActionBlock)) return;
    if (guideInContext(ctx.sessionManager.getBranch())) return;
    return { message: { customType: GUIDE_TYPE, content: A2UI_AGENT_PROMPT, display: false, attribution: "agent" } };
  });
}
