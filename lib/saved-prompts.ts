export interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedPromptToken {
  start: number;
  end: number;
  query: string;
}

export function findSavedPromptToken(value: string, cursor: number): SavedPromptToken | null {
  const pos = Math.max(0, Math.min(value.length, cursor));
  const match = /(?:^|\s)(\/\/[^\s]*)$/.exec(value.slice(0, pos));
  if (!match) return null;
  const start = pos - match[1].length;
  const suffix = /^\S*/.exec(value.slice(pos))![0];
  return { start, end: pos + suffix.length, query: value.slice(start + 2, pos) };
}

export function fillPromptTemplate(body: string, vars: Readonly<Record<string, string | null | undefined>>): string {
  return body.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (literal, name: string) => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    return value ? value : literal;
  });
}

export function derivePromptTitle(body: string): string {
  return Array.from(body.trim().split(/\r?\n/, 1)[0].trim()).slice(0, 60).join("");
}
