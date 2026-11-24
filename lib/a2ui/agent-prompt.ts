/** Catalog id agents use for CUELO answer cards (the basic catalog id renders with the same components). */
export const CUELO_A2UI_CATALOG_ID = "cuelo";

/** Component names the web chat renders; kept in step with `components/a2ui/catalog.tsx`. */
export const CUELO_A2UI_COMPONENTS = [
  "Card", "Column", "Row", "List", "Tabs", "Text", "Stat", "Progress", "BarChart", "Image",
  "Button", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput",
] as const;

/**
 * The system prompt section that tells a CUELO web session how to draw answer
 * cards. It is appended after the user's `APPEND_SYSTEM.md` text; the TUI and
 * other clients never see it.
 */
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

/** `APPEND_SYSTEM.md` text for a CUELO web session: the user's own text first, then the card section. */
export function withA2uiAgentPrompt(appendPrompt: string | undefined): string {
  return appendPrompt ? `${appendPrompt}\n\n${A2UI_AGENT_PROMPT}` : A2UI_AGENT_PROMPT;
}
