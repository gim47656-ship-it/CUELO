// OMP --rules module: lines and borders the user rejects in every UI.
//
//   node scan.mjs <root> --rules=path/to/rules.lines.mjs
//
// User decision 2026-11-14 (rule://frontend 「선과 테두리를 긋지 않는다」): no
// border-boxed card grids, no underline or bar on the selected tab, no focus
// line on mouse click. Closest external reference: Impeccable craft-floor and
// its detector rules nested-cards, side-tab, border-accent-on-rounded,
// gpt-thin-border-wide-shadow. Every hit is a lead: an input field edge, a
// data-table header rule or a chart axis may keep its line, with the reason
// written in the report.
//
// Patterns run over the whole file and start at the identifying keyword (a tab
// or selected-state selector, `:focus`, a utility class), so CSS inside HTML
// <style>, template literals and SCSS works the same as in a .css file.
// Keyboard-only focus styles are the allowed replacement and never count as a
// line: a CSS selector-list item with `:focus-visible` before or after the
// keyword, or a Tailwind class chain containing `focus-visible:`. Comments
// inside a selector are skipped.
const COMMENT = String.raw`\/\*(?:(?!\*\/)[\s\S])*\*\/`;
const TOKEN = String.raw`(?:${COMMENT}|[^{};/])`;
// One selector-list item without :focus-visible.
const ITEM_TOKEN = String.raw`(?:${COMMENT}|(?!:focus-visible)[^{};/,])`;
const NO_FOCUS_VISIBLE_BEFORE = String.raw`(?<!:focus-visible(?:${COMMENT}|[^{};,/])*)`;
// A rule whose selector-list item contains `key` and no :focus-visible, up to its `{`.
const rule = (key) =>
  String.raw`${NO_FOCUS_VISIBLE_BEFORE}(?:${key})${ITEM_TOKEN}{0,1000}?(?:,${TOKEN}{0,1000}?)?\{[^}]*`;
// A declaration value that draws nothing: none, or a bare zero width.
const DRAWS = String.raw`:(?!\s*(?:none|0[a-z%]*)\s*(?:[;}!]|$))`;
const WIDTH = String.raw`(?:\d*\.\d+|[1-9]\d*(?:\.\d+)?)(?:px|rem|em)?`;
const VISIBLE = String.raw`${WIDTH}\s+(?:solid|dashed|dotted|double)`;
const NOT_FOCUS_VISIBLE_RULE = String.raw`(?<!:focus-visible${TOKEN}*\{[^}]*)`;
// A Tailwind utility, bare or behind variants, unless the chain has focus-visible:.
const NOT_FOCUS_VISIBLE_CHAIN = String.raw`(?<!focus-visible:[^\s"'\x60]*)`;
const UTILITY = String.raw`(?<![\w-])${NOT_FOCUS_VISIBLE_CHAIN}`;
const TAB = String.raw`\.tabs?\b|\[role=["']?tab(?:list)?["']?\]`;
const SELECTED = String.raw`active|selected|aria-selected|state=["']?active|aria-current`;
const re = (source, flags = "i") => new RegExp(source, flags);

export default [
  { id: "ln-01", group: "lines", name: "선택 탭 밑줄·인디케이터 선", fix: "선택은 배경 면·굵기·글자색으로, 탭 줄 아래 구분선도 없음",
    patterns: [
      re(String.raw`${rule(`${SELECTED}|${TAB}`)}border-bottom(?:-width)?\s*${DRAWS}`),
      re(String.raw`${rule(`(?:${TAB}|active|selected)${ITEM_TOKEN}{0,80}?::?after`)}(?:height\s*:\s*[1-4](?:\.\d+)?px|border-bottom(?:-width)?\s*${DRAWS})`),
      re(String.raw`${rule("active|selected|aria-current")}text-decoration(?:-line)?\s*:\s*underline`),
      re(String.raw`${NOT_FOCUS_VISIBLE_CHAIN}(?:data-\[state=active\]|aria-selected|aria-\[selected=true\]|(?<![\w-])active):(?:border-b|underline)\b`, ""),
      /\b(?:tab-?indicator|tab-?underline|ink-?bar|active-?indicator|underline-?indicator|tab-?slider)\b/i,
    ] },
  { id: "ln-02", group: "lines", name: "클릭할 때 그어지는 포커스 선", fix: ":focus-visible에만 포커스 표시, 가능하면 선 대신 배경",
    patterns: [
      re(String.raw`:focus(?![-\w])${TOKEN}{0,1000}?\{[^}]*(?:(?:outline|border)(?:-(?:width|style|color))?\s*${DRAWS}|box-shadow\s*:(?!\s*none\b))`),
      re(String.raw`${UTILITY}focus:(?:ring|outline|border)(?!-none\b|-0\b)`, ""),
    ] },
  { id: "ln-03", group: "lines", name: "테두리 두른 상자·카드", fix: "여백·정렬·배경 톤으로 구분, 테두리 없음",
    patterns: [
      re(String.raw`${UTILITY}border(?:-[1-8])?(?![\w-])[^"'\x60\n]{0,80}\brounded(?:-(?:sm|md|lg|xl|2xl|3xl))?(?![\w-])|\brounded(?:-(?:sm|md|lg|xl|2xl|3xl))?(?![\w-])[^"'\x60\n]{0,80}${UTILITY}border(?:-[1-8])?(?![\w-])`, ""),
      re(String.raw`${NOT_FOCUS_VISIBLE_RULE}(?<![\w-])border\s*:\s*${VISIBLE}`),
      /\bline\s*:\s*\{[^}]*\bcolor\s*:/,
      /(?<![\w-])border\s*:\s*[[{][^\]}]*\bpt\s*:/,
    ] },
  { id: "ln-04", group: "lines", name: "행마다 긋는 구분선", fix: "행 간격·배경 줄무늬로 구분, 표는 헤더 아래 한 줄까지만",
    patterns: [
      re(String.raw`${UTILITY}divide-[xy](?:-\d)?(?![\w-])`, ""),
      re(String.raw`${UTILITY}border-[bt](?:-\d)?(?![\w-])`, ""),
      re(String.raw`${NOT_FOCUS_VISIBLE_RULE}border-(?:bottom|top)\s*:\s*${VISIBLE}`),
      /<hr\b/i,
    ] },
  { id: "ln-05", group: "lines", name: "한쪽 면 색 띠", fix: "띠를 빼고 제목·배경으로 강조",
    patterns: [
      re(String.raw`${UTILITY}border-[lrse]-(?:[2-9]|\[\d+(?:\.\d+)?px\])(?![\w-])`, ""),
      re(String.raw`${NOT_FOCUS_VISIBLE_RULE}border-(?:left|right|inline-start|inline-end)\s*:\s*(?:[2-9]|\d{2,})(?:\.\d+)?px\s+solid`),
    ] },
];
