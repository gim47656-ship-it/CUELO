// OMP --rules module: values and shapes an agent reaches for when nobody chose
// a design direction (rule://frontend 「양산형 기본값을 고르지 않는다」).
//
//   node scan.mjs <root> --rules=path/to/rules.defaults.mjs
//
// Sources: Anthropic's Opus 5.5 prompting guide ("Frontend design defaults":
// cream background, italic accent words, 01/02/03 labels, mono labels, pill
// buttons), the Reddit study JCarterJohnson/vibecoded-design-tells (untouched
// Tailwind defaults, AI purple, the cream + serif "tasteful default"), and
// dannywon.dev (palette values copied verbatim, Claude brand orange leaking
// into a product palette). Measured on 377 agent-made UI files on the home PC
// (2026-11-14): the core tells missed every df-01/df-02/df-03 file and most
// plain-CSS hover lifts.
//
// Every hit is a lead. One tell alone is not a verdict; a value the project's
// design contract chose on purpose (a real brand purple, a status colour in a
// chart) stays, with `deslop-ignore-next-line df-01` and a reason.
//
// Colour patterns start at the `#hex` and look behind for the value context,
// so a long run of word characters cannot make them backtrack quadratically.
const hex = (list) => String.raw`#(?:${list.join("|")})(?![0-9a-f])`;
const re = (source, flags = "i") => new RegExp(source, flags);

// Tailwind v3.4.17 `lib/public/colors.js`: the 400-700 shades of every accent
// hue, the 100-900 shades of slate, gray, zinc and stone, and the 50 shades of
// the tinted greys (slate, gray, stone). The plain `neutral` greys (#f5f5f5,
// #e5e5e5, ...) and zinc-50 (#fafafa) are left out on purpose: people pick
// those by hand, so they are no trace of an untouched palette.
const TAILWIND = [
  "0284c7", "0369a1", "047857", "059669", "06b6d4", "0891b2", "0d9488", "0e7490", "0ea5e9", "0f172a",
  "0f766e", "10b981", "111827", "14b8a6", "15803d", "16a34a", "18181b", "1c1917", "1d4ed8",
  "1e293b", "1f2937", "22c55e", "22d3ee", "2563eb", "27272a", "292524", "2dd4bf", "334155",
  "34d399", "374151", "38bdf8", "3b82f6", "3f3f46", "4338ca", "44403c", "475569", "4ade80",
  "4b5563", "4d7c0f", "4f46e5", "52525b", "57534e", "60a5fa", "6366f1", "64748b", "65a30d",
  "6b7280", "6d28d9", "71717a", "78716c", "7c3aed", "7e22ce", "818cf8", "84cc16", "8b5cf6",
  "9333ea", "94a3b8", "9ca3af", "a16207", "a1a1aa", "a21caf", "a3e635", "a78bfa", "a855f7",
  "a8a29e", "b45309", "b91c1c", "be123c", "be185d", "c026d3", "c084fc", "c2410c", "ca8a04", "cbd5e1",
  "d1d5db", "d4d4d8", "d6d3d1", "d946ef", "d97706", "db2777", "dc2626", "e11d48", "e2e8f0",
  "e4e4e7", "e5e7eb", "e7e5e4", "e879f9", "ea580c", "eab308", "ec4899", "ef4444", "f1f5f9",
  "f3f4f6", "f43f5e", "f472b6", "f4f4f5", "f59e0b", "f5f5f4", "f87171", "f97316", "facc15",
  "fb7185", "fb923c", "fbbf24", "f8fafc", "f9fafb", "fafaf9",
];
// The 400-700 shades of indigo, violet and purple.
const PURPLE = [
  "4338ca", "4f46e5", "6366f1", "6d28d9", "7c3aed", "7e22ce", "818cf8", "8b5cf6", "9333ea", "a78bfa",
  "a855f7", "c084fc",
];
// Anthropic / Claude brand oranges.
const CLAUDE = ["d97757", "da7756", "cc785c", "c15f3c"];
// Warm off-white page colours of the cream + serif "tasteful default".
const CREAM = [
  "faf8f5", "f5f1e8", "f3eee3", "fdfbf7", "f7f3ec", "f4efe6", "fbf7f0", "f6f1e7",
  "fffaf0", "faf7f2", "f5f0e8", "f9f6f0", "fdf6ec", "faf3e8", "f5f5dc", "fefcf8",
  "f8f5f0", "f2ede4", "efe9dd", "faf9f6", "f7f4ef", "fcfaf7", "f6f3ee", "fbf8f3",
  "fffdf7", "fffbf5", "fdfaf5", "fcf9f4",
];
const FALLBACK = String.raw`var\(\s*--[\w-]+\s*,\s*`;
// A colour written as a value: after a CSS or JS/JSON `:` or a JS `=` (up to a
// few words such as `1px solid`), as a var() fallback, or as a Tailwind
// arbitrary value.
const IN_VALUE = String.raw`(?<=(?:[:=]\s*["']?(?:[\w-]+\s+){0,6}|${FALLBACK}|\[))`;
const PAGE_BG = String.raw`(?:background(?:-color)?|--(?:bg|background|paper|page|canvas|surface|base)[\w-]*)\s*:\s*(?:${FALLBACK})?`;
// hsl() is only read on page-colour custom properties: inline hsl() values are
// usually data scales (heatmaps, charts).
const PAGE_VAR = String.raw`--(?:bg|background|paper|page|canvas|surface|base)[\w-]*\s*:\s*`;

export default [
  { id: "df-01", group: "defaults", name: "Tailwind 기본 팔레트 값 그대로", fix: "디자인 계약에서 고른 색 토큰으로, 팔레트 값을 그대로 쓰지 않음",
    patterns: [re(IN_VALUE + hex(TAILWIND))] },
  { id: "df-02", group: "defaults", name: "Claude 브랜드 오렌지", fix: "제품 자체의 강조색으로",
    patterns: [re(hex(CLAUDE))] },
  { id: "df-03", group: "defaults", name: "크림, 오프화이트 바탕", fix: "중립 바탕이나 브랜드에서 나온 바탕색",
    patterns: [
      re(PAGE_BG + hex(CREAM)),
      re(PAGE_VAR + String.raw`hsla?\(\s*(?:[2-4]\d|50)(?:deg)?[\s,]+\d{1,2}(?:\.\d+)?%[\s,]+(?:9[3-8])(?:\.\d+)?%`),
    ] },
  { id: "df-04", group: "defaults", name: "‘취향 좋은 척’ 세리프 제목", fix: "계약에서 이유를 적고 고른 글꼴",
    patterns: [/Instrument[ _+]Serif|Fraunces|Newsreader|Playfair[ _+]Display|Cormorant|DM[ _+]Serif|Spectral|Libre[ _+]Caslon|EB[ _+]Garamond/] },
  { id: "df-05", group: "defaults", name: "제목 속 이탤릭 강조 단어", fix: "강조는 크기와 굵기로",
    patterns: [
      /<h([1-3])\b[^>]{0,300}>(?:(?!<\/h\1\b)[\s\S]){0,240}?<(?:em|i)\b/i,
      /\bh[1-3]\b[^{},]{0,200}\s(?:em|i)\s*\{[^}]{0,600}font-style\s*:\s*italic/i,
    ] },
  { id: "df-06", group: "defaults", name: "장식용 01, 02 번호 라벨", fix: "실제 순서가 있는 단계에만 번호",
    patterns: [
      /[>"'`]\s*0[1-9]\s*[·.—–:|\/-]\s*[^\d\s<"'`]/,
      /decimal-leading-zero/i,
    ] },
  { id: "df-07", group: "defaults", name: "hover 때 떠오르거나 커지는 요소", fix: "hover는 배경이나 색 변화로, 움직임 없음",
    patterns: [
      /:hover[^{}]{0,300}\{[^}]{0,600}(?:transform\s*:[^;}]{0,200}(?:translateY\(\s*-|scale\(\s*1\.0*[1-9])|translate\s*:\s*0\s+-)/i,
      /whileHover=\{\{[^}]{0,200}\b(?:scale\s*:\s*1\.0*[1-9]|y\s*:\s*-)/,
    ] },
  { id: "df-08", group: "defaults", name: "대각선이나 가로 장식 그라데이션 면", fix: "단색 면, 진행 막대처럼 정보가 있을 때만",
    patterns: [/background(?:-image)?\s*["']?\s*:\s*["']?linear-gradient\(\s*(?:(?!0*(?:0|180|360|540|720|900|1080)(?:\.0+)?deg)\d+(?:\.\d+)?deg|to (?:right|left)|to (?:top|bottom) (?:right|left))/i] },
  { id: "df-09", group: "defaults", name: "AI 보라를 주색으로", fix: "제품에서 나온 주색, 보라가 브랜드면 팔레트 밖 값",
    patterns: [
      re(String.raw`--(?:primary|accent|brand|cta|main|key)[\w-]*\s*[:,]\s*(?:${FALLBACK})?${hex(PURPLE)}`),
      /(?:<button|<a\b|\bbtn|\bcta|\bprimary)[^\n]{0,160}\b(?:bg|from)-(?:indigo|violet|purple)-[5-7]00\b/i,
    ] },
];
