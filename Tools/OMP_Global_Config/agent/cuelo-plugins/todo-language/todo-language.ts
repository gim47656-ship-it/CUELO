// Deliberately narrow: kana is evidence of Japanese prose, not a general language detector.
// Han-only text, Latin names and short neutral identifiers are not classified.
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|«[^»\n]*»/gu, " ")
    .replace(/(?<![\p{L}\p{N}_])(?:https?:\/\/|[A-Za-z]:[\\/]|\.{0,2}\/|~\/)[^\s<>"']+/gu, " ")
    .replace(/\b[A-Za-z_][\w.-]*[\\/][^\s<>"']+|(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_-]+\.[A-Za-z][A-Za-z0-9]*(?=\s|$|[),])/gu, " ")
    .replace(/^\s*(?:[\w.]*Error|[\w.]*Exception|error|오류)\s*[:：][^\n]*$/gim, " ");
}

export function hasJapaneseTodoProse(text: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prose(text));
}

// Undefined means no new directive; a neutral follow-up must not revoke a real user instruction.
export function requestedTodoJapanese(text: string): boolean | undefined {
  const direct = prose(text);
  const todo = "(?:할\\s*일(?:\\s*목록)?|투두|todo(?:\\s*list|s)?|task\\s*list|checklist)";
  const particle = "(?:을|를|은|는|만|도)?";
  const verb = "(?:써|쓰|작성|적어|표시|만들|바꿔|정리|부탁|해|계속)";
  const adverbs = "(?:(?:모두|전부|전체|앞으로|이제부터|항상|반드시|꼭|다시|그냥|계속|자세히|짧게|간단히)\\s*)*";
  const contrast = `(?:(?:일본어|일문|한국어|한글)(?:로|으로)\\s*${verb}[하해\\s]*지\\s*말고\\s*)?`;
  let requested: boolean | undefined;
  for (const clause of direct.split(/[.!?。\n;,]/)) {
    for (const [language, japanese] of [["일본어|일문", true], ["한국어|한글", false]] as const) {
      const lang = `(?:${language})(?:로|으로)`;
      const match = new RegExp(`${todo}${particle}\\s*${contrast}${adverbs}${lang}\\s*${adverbs}${verb}|${lang}\\s*${adverbs}${todo}${particle}\\s*${adverbs}${verb}`, "i").exec(clause);
      if (!match) continue;
      const tail = clause.slice(match.index + match[0].length);
      const required = /^[하해\s]*지\s*않으면\s*안\s*(?:돼|되|됩|된|됨)/.test(tail);
      const prohibited = !required && (/^[하해서주시어아지진는도록게기가것건걸을를은면\s]*(?:않|못|금지|안\s*(?:돼|되|됩|된|됨))/.test(tail)
        || /^[하해서주시어아는도록게기가것건걸을를은면\s]*(?:지(?:는|도)?|진)\s*(?:말|마)/.test(tail));
      if (prohibited && japanese) requested = false;
      else if (!prohibited) requested = japanese;
    }
    const english = /\b(?:write|create|show|keep|switch|change)\s+(?:(?:the|my|your|all|every|future)\s+)*(?:todos?|todo\s*(?:list|items?)|task\s*list|checklist)\s+(?:in|to)\s+(japanese|korean)\b/i.exec(clause);
    if (english) {
      const japanese = english[1]!.toLowerCase() === "japanese";
      // A bounded adverb list may sit between the negation and the verb ("do not ever write"); anything else ends its reach.
      const prohibited = /\b(?:don't|do not|not|never)(?:\s+(?:ever|again|really|actually|just|even))*\s*$/i.test(clause.slice(0, english.index));
      if (prohibited && japanese) requested = false;
      else if (!prohibited) requested = japanese;
    }
  }
  return requested;
}

type DisplayField = { location: string; text: string };

// This selects fields, not schema validity. TodoTool remains responsible for validation and op inference.
export function introducedTodoFields(input: Record<string, unknown>, phaseNames: ReadonlySet<string>): DisplayField[] {
  const fields: DisplayField[] = [];
  const add = (location: string, value: unknown) => {
    if (typeof value === "string") fields.push({ location, text: value });
  };
  const items = (location: string, value: unknown) => {
    if (Array.isArray(value)) value.forEach((item, index) => add(`${location}[${index}]`, item));
  };
  const op = input.op ?? (Array.isArray(input.list) && input.list.length ? "init"
    : Array.isArray(input.items) && input.items.length ? (input.phase ? "append" : "init") : undefined);
  if (op === "init") {
    if (Array.isArray(input.list) && input.list.length) {
      input.list.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        const phase = entry as Record<string, unknown>;
        add(`list[${index}].phase`, phase.phase);
        items(`list[${index}].items`, phase.items);
      });
    } else {
      add("phase", input.phase);
      items("items", input.items);
    }
  } else if (op === "append") {
    if (typeof input.phase === "string" && !phaseNames.has(input.phase)) add("phase", input.phase);
    items("items", input.items);
  } else if (op === "block") add("reason", input.reason);
  return fields;
}
