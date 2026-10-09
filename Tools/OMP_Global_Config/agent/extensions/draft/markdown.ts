// draft의 docx·pdf 변환이 함께 쓰는 Markdown 부분집합 파서.
// 지원: 제목(#~######), 문단, **굵게**·*기울임*·`코드`·[링크](url), 글머리·번호 목록(들여쓰기 중첩),
// GFM 표, 펜스 코드 블록, 인용(>), 가로줄. 그 밖의 문법은 글자 그대로 문단에 남는다.

export interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }
export interface ListItem { level: number; ordered: boolean; runs: Run[] }
export type Block =
  | { kind: "heading"; level: number; runs: Run[] }
  | { kind: "paragraph"; runs: Run[] }
  | { kind: "list"; items: ListItem[] }
  | { kind: "table"; header: Run[][]; rows: Run[][][] }
  | { kind: "code"; lines: string[] }
  | { kind: "quote"; runs: Run[] }
  | { kind: "rule" };

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ESCAPABLE = /[\\`*_[\]#|()~>+\-.!{}]/;

function startsBlock(line: string, next: string | undefined): boolean {
  return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line)
    || (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("-"));
}

/** 인라인 서식을 run 목록으로 바꾼다. 닫는 표시가 없는 `*`·`**`는 글자로 남긴다. */
export function parseInline(source: string): Run[] {
  const runs: Run[] = [];
  let bold = false;
  let italic = false;
  let buffer = "";
  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
    buffer = "";
  };
  const src = source.replace(/<br\s*\/?>/gi, "\n");
  for (let i = 0; i < src.length;) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) { buffer += src[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const ticks = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        runs.push({ text: src.slice(i + ticks.length, end).replace(/^ (.+) $/, "$1"), code: true, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
        i = end + ticks.length;
        continue;
      }
      buffer += ticks; i += ticks.length; continue;
    }
    if (ch === "[") {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (link) {
        flush();
        for (const run of parseInline(link[1]!)) runs.push({ ...run, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}), href: link[2]! });
        i += link[0].length;
        continue;
      }
    }
    if (src.startsWith("***", i) && ((bold && italic) || src.indexOf("***", i + 3) > 0)) { flush(); bold = !bold; italic = !italic; i += 3; continue; }
    const pair = src.slice(i, i + 2);
    if ((pair === "**" || pair === "__") && (bold || src.indexOf(pair, i + 2) > 0)) { flush(); bold = !bold; i += 2; continue; }
    if (ch === "*" && (italic ? true : src[i + 1] !== " " && src.indexOf("*", i + 1) > 0)) { flush(); italic = !italic; i += 1; continue; }
    buffer += ch;
    i += 1;
  }
  flush();
  return runs;
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") { current += "|"; i++; continue; }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) { cells.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(marker); i++) body.push(lines[i]!);
      i++; // 닫는 펜스(없으면 문서 끝)
      blocks.push({ kind: "code", lines: body });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1]!.length, runs: parseInline(heading[2]!) }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ kind: "rule" }); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const header = splitRow(line);
      const rows: Run[][][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) {
        const cells = splitRow(lines[i]!);
        rows.push(header.map((_, index) => parseInline(cells[index] ?? "")));
      }
      blocks.push({ kind: "table", header: header.map(parseInline), rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) body.push(QUOTE.exec(lines[i]!)![1]!);
      blocks.push({ kind: "quote", runs: parseInline(body.join("\n").trim()) });
      continue;
    }
    if (ITEM.test(line)) {
      const items: ListItem[] = [];
      const indents: number[] = [];
      for (; i < lines.length;) {
        const current = lines[i]!;
        const item = ITEM.exec(current);
        if (item) {
          const indent = item[1]!.replace(/\t/g, "    ").length;
          while (indents.length && indents[indents.length - 1]! > indent) indents.pop();
          if (!indents.length || indents[indents.length - 1]! < indent) indents.push(indent);
          items.push({ level: Math.min(indents.length - 1, 2), ordered: /\d/.test(item[2]!), runs: parseInline(item[3]!.replace(/^\[[ xX]\]\s+/, (box) => (/[xX]/.test(box) ? "☑ " : "☐ "))) });
          i++;
          continue;
        }
        // 들여 쓴 이어지는 줄은 직전 항목에 붙인다. 빈 줄 뒤에 항목이 오면 같은 목록이 이어진다.
        if (current.trim() && /^\s+/.test(current) && items.length && !startsBlock(current.trim(), lines[i + 1])) {
          const last = items[items.length - 1]!;
          last.runs = [...last.runs, { text: " " }, ...parseInline(current.trim())];
          i++;
          continue;
        }
        if (!current.trim() && i + 1 < lines.length && ITEM.test(lines[i + 1]!)) { i++; continue; }
        break;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    const body: string[] = [line.trim()];
    for (i++; i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1]); i++) body.push(lines[i]!.trim());
    blocks.push({ kind: "paragraph", runs: parseInline(body.join(" ")) });
  }
  return blocks;
}

export function plainText(runs: readonly Run[]): string { return runs.map((run) => run.text).join(""); }

/** 결과 보고용 개요: 제목 목록, 제목이 없으면 앞 문단 몇 개. */
export function outline(blocks: readonly Block[], limit = 12): string[] {
  const headings = blocks.filter((block): block is Extract<Block, { kind: "heading" }> => block.kind === "heading")
    .map((block) => `${"#".repeat(block.level)} ${plainText(block.runs)}`);
  if (headings.length) return headings.length > limit ? [...headings.slice(0, limit), `… 제목 ${headings.length - limit}개 더`] : headings;
  return blocks.filter((block): block is Extract<Block, { kind: "paragraph" }> => block.kind === "paragraph")
    .slice(0, 3).map((block) => plainText(block.runs).slice(0, 120));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlRuns(runs: readonly Run[]): string {
  return runs.map((run) => {
    let html = escapeHtml(run.text).replace(/\n/g, "<br>");
    if (run.code) html = `<code>${html}</code>`;
    if (run.italic) html = `<em>${html}</em>`;
    if (run.bold) html = `<strong>${html}</strong>`;
    if (run.href) html = `<a href="${escapeHtml(run.href)}">${html}</a>`;
    return html;
  }).join("");
}

function htmlList(items: readonly ListItem[]): string {
  let html = "";
  const open: string[] = [];
  let depth = -1;
  for (const item of items) {
    const tag = item.ordered ? "ol" : "ul";
    while (depth > item.level) { html += `</li></${open.pop()}>`; depth--; }
    if (depth === item.level && open[open.length - 1] !== tag) { html += `</li></${open.pop()}>`; depth--; }
    if (depth === item.level) html += "</li>";
    while (depth < item.level) { html += `<${tag}>`; open.push(tag); depth++; if (depth < item.level) html += "<li>"; }
    html += `<li>${htmlRuns(item.runs)}`;
  }
  while (open.length) html += `</li></${open.pop()}>`;
  return html;
}

const CSS = `@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; font-size: 10.5pt; line-height: 1.6; color: #111; }
h1 { font-size: 20pt; border-bottom: 1px solid #999; padding-bottom: 4px; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; } h4, h5, h6 { font-size: 11pt; }
h1, h2, h3, h4, h5, h6 { margin: 1.1em 0 0.4em; page-break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 0.6em 0; page-break-inside: auto; } tr { page-break-inside: avoid; }
th, td { border: 1px solid #888; padding: 4px 6px; text-align: left; vertical-align: top; } th { background: #eee; }
pre { background: #f4f4f4; padding: 8px; white-space: pre-wrap; word-break: break-all; font-size: 9pt; }
code { font-family: Consolas, "D2Coding", monospace; } blockquote { margin: 0.6em 0; padding-left: 10px; border-left: 3px solid #bbb; color: #444; }
hr { border: 0; border-top: 1px solid #aaa; }`;

export function toHtml(blocks: readonly Block[], title: string): string {
  const body = blocks.map((block) => {
    switch (block.kind) {
      case "heading": return `<h${block.level}>${htmlRuns(block.runs)}</h${block.level}>`;
      case "paragraph": return `<p>${htmlRuns(block.runs)}</p>`;
      case "list": return htmlList(block.items);
      case "table": return `<table><thead><tr>${block.header.map((cell) => `<th>${htmlRuns(cell)}</th>`).join("")}</tr></thead><tbody>${
        block.rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlRuns(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "code": return `<pre><code>${escapeHtml(block.lines.join("\n"))}</code></pre>`;
      case "quote": return `<blockquote>${htmlRuns(block.runs)}</blockquote>`;
      case "rule": return "<hr>";
    }
  }).join("\n");
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>\n${body}\n</body></html>\n`;
}
