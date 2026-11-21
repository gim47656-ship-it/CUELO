const DATA_EXTENSIONS = ["json", "jsonl", "snap", "lock", "csv", "tsv", "txt", "md", "yaml", "yml", "xml", "html", "sql", "toml", "ini"];
export const TEST_PATHSPECS = [
  ...["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/test_*.py", "**/*_test.go", "**/*_test.py"]
    .map((glob) => `:(top,glob,icase)${glob}`),
  ...DATA_EXTENSIONS.map((extension) => `:(exclude,top,glob,icase)**/*.${extension}`),
];
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.test\.|\.spec\.)[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/i;
const DATA_PATH = new RegExp(String.raw`\.(?:${DATA_EXTENSIONS.join("|")})$`, "i");
const isTestPath = (path: string): boolean => !DATA_PATH.test(path) && TEST_PATH.test(path);
const ASSERTION = /(?:^|[^\w$.])(?:expect\s*\(|assert(?:\s*\(|\s+\S|\.[\w]+\s*\()|(?:t\.(?:Errorf?|Fatalf?)|self\.assert\w+|pytest\.raises)\s*\()|\.(?:toBe|toEqual|toThrow)\s*\(/;
const TEST_CASE = /(?:^|[^\w$.])(?:it|test|describe|xit|xtest|xdescribe|fit|fdescribe)(?:\.\w+(?:\([^()]*\))?)*\s*\(|^\s*(?:(?:async\s+)?def\s+test_\w+|func\s+Test\w+)\s*\(/;
const SKIP = /(?:^|[^\w$.])(?:it|test|describe)(?:\.\w+)*?\.(skipIf|skip|only|todo)\b(?=\s*(?:\(|`|\.))|(?:^|[^\w$.])(xit|xtest|xdescribe|fit|fdescribe|t\.Skip(?:f|Now)?|self\.skipTest|pytest\.skip)\s*\(|@(pytest\.mark\.(?:skipif|skip|xfail)|unittest\.(?:skipIf|skipUnless|skip|expectedFailure))\b/;
const STRING = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const STATIC_TEMPLATE = String.raw`\x60(?:\\.|(?!\$\{)[^\x60\\])*\x60`;
const TITLE = String.raw`\s*\(\s*(?:${STRING}|${STATIC_TEMPLATE})(?=\s*(?:,|\)))`;
const NAMED_SKIP = new RegExp(String.raw`^(?:[xf](?:it|test|describe)|(?:it|test|describe)\.(?:skip|only|todo|skipIf\s*\([^()]*\)))${TITLE}`);
const LITERAL = String.raw`(?:${STRING}|${STATIC_TEMPLATE}|-?(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|true|false|null|True|False|None)`;
const NON_CODE = new RegExp(`${STRING}|\x60(?:\\\\.|[^\x60\\\\])*\x60|//.*|/\\*.*?(?:\\*/|$)|#.*`, "g");
const EXPECTED = new RegExp(String.raw`^((?:.*\)\s*\.)?(?:(?:not|resolves|rejects)\.)?(?:toBe|toEqual|toStrictEqual|toThrow|toContain|toHaveLength)\s*\(\s*|(?:self\.assert\w+|assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual))\s*\(.*?,\s*|assert\s+.+?\s*(?:[!=]=)\s*)(${LITERAL})(\s*(?:\)\s*;?)?)$`);

interface Line {
  number: number;
  text: string;
  hunk: Hunk;
}
interface Hunk {
  before: Line[];
  after: Line[];
}
interface File {
  path: string;
  added: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

type Kind = "assertionsRemoved" | "testsRemoved" | "skipMarkersAdded" | "expectedValuesChanged";
interface Evidence {
  hunk: Hunk;
  excerpt: string;
}
export interface Finding {
  path: string;
  deleted: boolean;
  counts: Record<Kind, number>;
  excerpts: string[];
  key: string;
}

// Git C-quotes paths with tabs or unusual bytes even with core.quotePath=false.
function gitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw.replace(/\t$/, "");
  return raw.slice(1, raw.lastIndexOf('"')).replace(/(?:\\[0-7]{3})+|\\(.)/g, (match, escape: string | undefined) => {
    if (escape !== undefined) return ({ t: "\t", n: "\n", r: "\r" } as Record<string, string>)[escape] ?? escape;
    return Buffer.from(match.split("\\").slice(1).map((octal) => Number.parseInt(octal, 8))).toString("utf8");
  });
}

// Empty and binary deletions can have no ---/+++ lines. For a deletion, both header paths name the same file.
function deletedPath(header: string): string {
  const quoted = /^"(?:[^"\\]|\\.)*"/.exec(header)?.[0];
  const raw = quoted ?? header.slice(0, (header.length - 1) / 2);
  return raw ? gitPath(raw).replace(/^a\//, "") : "";
}

function readTestDiff(diff: string): File[] {
  const files: File[] = [];
  let before = "", after = "", oldLine = 0, newLine = 0, deleted = false, headerPaths = "";
  let file: File | undefined;
  let inHunks = false;
  let hunk: Hunk | undefined;
  const closeFile = () => {
    if (file) files.push(file);
    else if (deleted && isTestPath(before)) files.push({ path: before, added: false, deleted: true, hunks: [] });
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      closeFile();
      before = after = "";
      headerPaths = raw.slice("diff --git ".length);
      deleted = false;
      inHunks = false;
      file = hunk = undefined;
      continue;
    }
    if (raw.startsWith("@@ ")) {
      inHunks = true;
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      const beforeTest = isTestPath(before), afterTest = isTestPath(after);
      if (!header || (!beforeTest && !afterTest)) continue;
      file ??= { path: afterTest ? after : before, added: !beforeTest, deleted: deleted || after === "/dev/null", hunks: [] };
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { before: [], after: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!inHunks) {
      if (raw.startsWith("--- ")) before = gitPath(raw.slice(4)).replace(/^a\//, "");
      else if (raw.startsWith("+++ ")) after = gitPath(raw.slice(4)).replace(/^b\//, "");
      else if (raw.startsWith("rename from ")) before = gitPath(raw.slice(12));
      else if (raw.startsWith("rename to ")) deleted = isTestPath(before) && !isTestPath(gitPath(raw.slice(10)));
      else if (raw.startsWith("deleted file mode ")) { before = deletedPath(headerPaths); deleted = true; }
      continue;
    }
    if (!hunk) continue;
    const text = raw.slice(1).replace(/\r$/, "").trim();
    if (raw[0] === "-") hunk.before.push({ number: oldLine++, text, hunk });
    else if (raw[0] === "+" && !file?.deleted) hunk.after.push({ number: newLine++, text, hunk });
    else if (raw[0] === " ") { oldLine++; newLine++; }
  }
  closeFile();
  return files;
}

function matchLines(file: File, side: "before" | "after", pattern: RegExp): Line[] {
  return file.hunks.flatMap((hunk) => hunk[side].filter(({ text }) => pattern.test(text.replace(NON_CODE, " "))));
}

// Prefer exact moves in the same file, then cancel identical lines moved across files.
function unmatchedLines(rows: { before: Line[]; after: Line[] }[]): void {
  const moved = new Map<string, number>();
  for (const row of rows) {
    const added = new Map<string, number>();
    for (const line of row.after) added.set(line.text, (added.get(line.text) ?? 0) + 1);
    row.before = row.before.filter((line) => !take(added, line.text));
    row.after = row.after.filter((line) => take(added, line.text));
    for (const line of row.after) moved.set(line.text, (moved.get(line.text) ?? 0) + 1);
  }
  for (const row of rows) row.before = row.before.filter((line) => !take(moved, line.text));
  for (const row of rows) row.after = row.after.filter((line) => take(moved, line.text));
}

function removedLines(files: File[], pattern: RegExp): Line[][] {
  const rows = files.map((file) => ({ before: matchLines(file, "before", pattern), after: matchLines(file, "after", pattern) }));
  unmatchedLines(rows);
  return rows.map(({ before, after }) => {
    // Prefer replacing removals in the addition's own hunk so excerpts point at actual losses.
    const local = new Map<Hunk, number>();
    for (const { hunk } of after) local.set(hunk, (local.get(hunk) ?? 0) + 1);
    const remaining = before.filter(({ hunk }) => {
      const count = local.get(hunk) ?? 0;
      if (count === 0) return true;
      local.set(hunk, count - 1);
      return false;
    });
    return remaining.slice(0, Math.max(0, before.length - after.length));
  });
}

function take(counts: Map<string, number>, key: string): boolean {
  const count = counts.get(key) ?? 0;
  if (!count) return false;
  counts.set(key, count - 1);
  return true;
}

function expectedChanges(hunk: Hunk): Evidence[] {
  const group = (lines: Line[]) => {
    const calls = new Map<string, { number: number; value: string }[]>();
    for (const { number, text } of lines) {
      if (!ASSERTION.test(text.replace(NON_CODE, " "))) continue;
      const match = EXPECTED.exec(text);
      if (!match) continue;
      const key = match[1]!.trimEnd();
      const literal = match[2]!;
      const value = /^["'`]/.test(literal) ? `"${literal.slice(1, -1)}"` : literal;
      const values = calls.get(key) ?? [];
      values.push({ number, value });
      calls.set(key, values);
    }
    return calls;
  };
  const before = group(hunk.before);
  const changes: Evidence[] = [];
  for (const [key, added] of group(hunk.after)) {
    const removed = before.get(key);
    if (!removed) continue;
    const values = new Map<string, number>();
    for (const { value } of removed) values.set(value, (values.get(value) ?? 0) + 1);
    const replacements = added.filter(({ value }) => !take(values, value));
    const removedCount = [...values.values()].reduce((sum, count) => sum + count, 0);
    for (const { number } of replacements.slice(0, removedCount)) changes.push({ hunk, excerpt: `L${number}: expected literal changed` });
  }
  return changes;
}

function addedSkipMarkers(files: File[]): Evidence[][] {
  const rows = files.map((file) => {
    const before = matchLines(file, "before", SKIP).filter(({ text }) => NAMED_SKIP.test(text));
    const after = matchLines(file, "after", SKIP);
    // Only named declarations can be matched across hunks/files; standalone decorators or t.Skip can change owners.
    return { before, after: after.filter(({ text }) => NAMED_SKIP.test(text)), standalone: after.filter(({ text }) => !NAMED_SKIP.test(text)) };
  });
  unmatchedLines(rows);
  return rows.map(({ after, standalone }, index) => {
    // If any enabled declaration changed, a retitled skip could have changed targets.
    const enabledChanged = after.length > 0 && files[index]!.hunks.some(({ before }) => before.some(({ text }) => {
      const code = text.replace(NON_CODE, " ");
      return TEST_CASE.test(code) && !SKIP.test(code);
    }));
    return [...after, ...standalone].flatMap(({ number, text, hunk }) => {
      const code = text.replace(NON_CODE, " ");
      if (!enabledChanged && NAMED_SKIP.test(text) && hunk.before.length === 1 && hunk.after.length === 1
        && hunk.before[0]!.text.replace(NON_CODE, " ") === code) return [];
      const marker = SKIP.exec(code)!.slice(1).find(Boolean);
      return [{ hunk, excerpt: `L${number}: +${marker}` }];
    });
  });
}

/** Read-only diff leads, not a judgment that a test really lost coverage. Excerpts never include operands or literal values. */
export function detectTestWeakening(diff: string): Finding[] {
  const files = readTestDiff(diff);
  const assertions = removedLines(files, ASSERTION);
  const tests = removedLines(files, TEST_CASE);
  const skips = addedSkipMarkers(files);
  return files.flatMap((file, index) => {
    if (file.added) return [];
    const items = {
      assertionsRemoved: assertions[index]!.map(({ number, hunk }) => ({ hunk, excerpt: `old L${number}: assertion removed` })),
      testsRemoved: tests[index]!.map(({ number, hunk }) => ({ hunk, excerpt: `old L${number}: test declaration removed` })),
      skipMarkersAdded: skips[index]!,
      expectedValuesChanged: file.hunks.flatMap(expectedChanges),
    };
    const { assertionsRemoved, testsRemoved, skipMarkersAdded, expectedValuesChanged } = items;
    const counts = {
      assertionsRemoved: assertionsRemoved.length,
      testsRemoved: testsRemoved.length,
      skipMarkersAdded: skipMarkersAdded.length,
      expectedValuesChanged: expectedValuesChanged.length,
    };
    const evidence = Object.values(items).flat();
    if (!file.deleted && evidence.length === 0) return [];
    const hunks = [...new Set(evidence.map(({ hunk }) => hunk))];
    const key = `${file.path}:${Bun.hash(JSON.stringify([file.deleted, counts, hunks.map(({ before, after }) => [before.map(({ text }) => text), after.map(({ text }) => text)])]))}`;
    return [{ path: file.path, deleted: file.deleted, counts, excerpts: evidence.slice(0, 3).map(({ excerpt }) => excerpt), key }];
  });
}
