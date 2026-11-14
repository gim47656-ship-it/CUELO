import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "scan.mjs");

function withTempProject(run) {
  const project = mkdtempSync(join(tmpdir(), "kill-ai-slop-"));
  try {
    return run(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function scan(root, ...args) {
  return spawnSync(process.execPath, [scriptPath, root, ...args], {
    encoding: "utf8",
  });
}

function reportFor(root) {
  const result = scan(root, "--json");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function finding(report, id) {
  return report.findings.find((entry) => entry.id === id);
}

test("rejects a missing scan root instead of reporting a clean scan", () => {
  withTempProject((project) => {
    const control = "\u001b]52;c;not-a-clipboard\u0007";
    const result = scan(join(project, `missing-${control}`), "--json");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Scan root must be an existing directory/);
    assert.equal(result.stderr.includes(control), false);
    assert.ok(result.stderr.includes("\\x1b]52;c;not-a-clipboard\\x07"));
    assert.equal(result.stdout, "");

    const file = join(project, "source.css");
    writeFileSync(file, "");
    const fileResult = scan(file, "--json");
    assert.notEqual(fileResult.status, 0);
    assert.match(fileResult.stderr, /Scan root must be an existing directory/);
  });
});

test("finds multiline patterns and documented runtime signals", () => {
  withTempProject((project) => {
    writeFileSync(
      join(project, "signals.tsx"),
      `<div className="from-indigo-500\n  to-violet-600" />\n<p>not just fast — it’s reliable</p>\n`,
    );
    writeFileSync(join(project, "Page.mdx"), `<div className="bg-clip-text text-transparent" />\n`);
    writeFileSync(
      join(project, "signals.css"),
      `.wash { background: bg-gradient-to-br from-emerald-500/10; }\n` +
        `.glow { box-shadow: 0 0 1rem #6366f1; }\n` +
        `.kicker { text-transform: uppercase; letter-spacing: 0.1em; }\n` +
        `.panel { transition: width 200ms ease; }\n` +
        `.steps::before { content: "step one"; }\n` +
        `.body { font-family: Geist, sans-serif; }\n` +
        `.load { top: 50%; left: 50%; transform: translate(-50%, -50%); animation: spin 1s linear infinite; }\n` +
        `@keyframes spin { to { transform: rotate(360deg); } }\n`,
    );

    const report = reportFor(project);
    assert.equal(finding(report, "01")?.hits[0].line, 1);
    for (const id of ["02", "06", "10", "14", "26", "27", "30", "33"]) {
      assert.ok(finding(report, id), `expected tell ${id} to be detected`);
    }
  });
});

test("skips the installed skill's own files", () => {
  withTempProject((project) => {
    const installedScript = join(
      project,
      ".claude",
      "skills",
      "kill-ai-slop",
      "scripts",
      "scan.mjs",
    );
    mkdirSync(dirname(installedScript), { recursive: true });
    copyFileSync(scriptPath, installedScript);

    const result = spawnSync(process.execPath, [installedScript, project, "--json"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).filesScanned, 0);
  });
});

test("scans PHP and Twig templates", () => {
  withTempProject((project) => {
    writeFileSync(
      join(project, "header.php"),
      `<h1 class="bg-clip-text text-transparent"><?php echo esc_html($title); ?></h1>\n`,
    );
    writeFileSync(
      join(project, "card.twig"),
      `<div class="rounded-full backdrop-blur">{{ title }}</div>\n`,
    );

    const report = reportFor(project);
    assert.equal(report.filesScanned, 2);
    assert.ok(finding(report, "02"), "expected tell 02 in the PHP template");
    assert.ok(finding(report, "19"), "expected tell 19 in the Twig template");
  });
});

test("deslop-ignore directives suppress hits", () => {
  withTempProject((project) => {
    writeFileSync(
      join(project, "styles.css"),
      `.a { background: radial-gradient(circle, red, blue); } /* deslop-ignore */\n` +
        `/* deslop-ignore-next-line 06 */\n` +
        `.b { background: radial-gradient(circle, red, blue); }\n` +
        `/* deslop-ignore-next-line 01 */\n` +
        `.c { background: radial-gradient(circle, red, blue); }\n`,
    );
    writeFileSync(
      join(project, "ignored.css"),
      `/* deslop-ignore-file */\n.x { backdrop-filter: blur(10px); }\n`,
    );

    const report = reportFor(project);
    const atmosphere = finding(report, "06");
    assert.equal(atmosphere?.hits.length, 1); // only .c: its directive names another tell
    assert.equal(atmosphere.hits[0].line, 5);
    assert.equal(finding(report, "19"), undefined);
  });
});

test("--only, --skip and --exclude narrow the scan", () => {
  withTempProject((project) => {
    writeFileSync(
      join(project, "a.css"),
      `.x { background: radial-gradient(red, blue); backdrop-filter: blur(4px); }\n`,
    );
    mkdirSync(join(project, "legacy"));
    writeFileSync(join(project, "legacy", "b.css"), `.y { background: radial-gradient(red, blue); }\n`);

    const only = scan(project, "--json", "--only=6");
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(JSON.parse(only.stdout).findings.map((f) => f.id), ["06"]);

    const skip = scan(project, "--json", "--skip=06");
    assert.equal(skip.status, 0, skip.stderr);
    const skipReport = JSON.parse(skip.stdout);
    assert.equal(skipReport.findings.some((f) => f.id === "06"), false);
    assert.ok(skipReport.findings.some((f) => f.id === "19"));

    const excluded = scan(project, "--json", "--exclude=legacy");
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.equal(JSON.parse(excluded.stdout).filesScanned, 1);
  });
});

test("--rules loads extra tells (Russian example rules)", () => {
  withTempProject((project) => {
    writeFileSync(join(project, "copy.md"), `Это не просто сканер — это ваш новый помощник.\n`);

    const rulesPath = join(dirname(scriptPath), "rules.ru.mjs");
    const result = scan(project, "--json", `--rules=${rulesPath}`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(finding(JSON.parse(result.stdout), "ru-14"));

    const badRules = join(project, "bad-rules.mjs");
    writeFileSync(badRules, `export default {};\n`);
    const bad = scan(project, "--json", `--rules=${badRules}`);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /must export an array/);
  });
});

test("rules.lines.mjs flags tab underlines, click focus lines and bordered boxes, not their replacements", () => {
  withTempProject((project) => {
    writeFileSync(
      join(project, "bad.css"),
      [
        `.tab.active { border-bottom: 2px solid var(--accent); }`,
        `.btn:focus { outline: 2px solid blue; }`,
        `.card { border: 1.5px solid #e5e7eb; }`,
        `.row { border-bottom: 1px solid #eee; }`,
        `.note { border-left: 2.5px solid teal; }`,
        `.tabs .item::after { content: ""; height: 2px; }`,
        `.chip:focus { box-shadow: 0 0 0 2px blue; }`,
        `.tab.selected`,
        `{ border-bottom: 2px solid blue; }`,
        `/* use :focus-visible */`,
        `.panel { border: 1px solid #ddd; }`,
        `.tab /* selection */ {border-bottom:2px solid blue;}`,
        `.btn:focus /* mouse */ {outline:2px solid blue;}`,
        `.inp:focus { border: 2px solid blue; }`,
        `${".scope ".repeat(25)}.tab {border-bottom:2px solid blue}`,
      ].join("\n"),
    );
    writeFileSync(
      join(project, "Bad.tsx"),
      [
        `export const A = () => <div className="data-[state=active]:border-b-2 focus:ring-2" />;`,
        `export const B = () => <div className="rounded-lg border p-4 divide-y" />;`,
        `export const C = () => <div className="border-t border-l-4" />;`,
        `export const D = () => <hr />;`,
        `export const E = () => <div className="focus:outline-2" />;`,
        `export const F = () => <div className="focus:border-2" />;`,
        `export const R = () => <div className="rounded-lg md:border md:divide-y md:border-b md:border-l-4" />;`,
      ].join("\n"),
    );
    writeFileSync(
      join(project, "slides.js"),
      [
        `slide.addShape("rect", { x: 1, line: { color: "CCCCCC" } });`,
        `slide.addTable(rows, { border: { type: "solid", pt: 1 } });`,
      ].join("\n"),
    );
    writeFileSync(
      join(project, "page.html"),
      [
        `<html><head><meta charset="utf-8"/><style>`,
        `.btn:focus {outline:2px solid blue}`,
        `.tab.active{border-bottom:2px solid blue;}`,
        `</style></head></html>`,
      ].join("\n"),
    );
    writeFileSync(join(project, "styles.scss"), `// note\n.tab.active { border-bottom: 2px solid blue; }\n`);
    writeFileSync(
      join(project, "good.css"),
      [
        `.tab[aria-selected="true"] { background: var(--surface-2); font-weight: 600; }`,
        `.btn:focus:not(:focus-visible) { outline: none; }`,
        `.btn:focus-visible { border: 2px solid blue; }`,
        `.card { background: var(--surface-1); border: none; }`,
        `.tabs .active { border-bottom: 0px; }`,
        `.tab::after { border-bottom: 0; }`,
        `.btn:focus { outline: 0; }`,
        `.tab:focus-visible { border-bottom: 2px solid blue; }`,
        `.tab.active:focus-visible { text-decoration: underline; }`,
        `.tab:focus-visible.active { border-bottom: 2px solid blue; }`,
        `[role="tab"]:focus-visible[aria-selected="true"] { border-bottom: 2px solid blue; }`,
        `.tab:focus-visible.active { text-decoration: underline; }`,
        `.btn:focus-visible /* kb */ { border: 2px solid blue; }`,
        `.form:focus-within { outline: 2px solid blue; }`,
      ].join("\n"),
    );
    writeFileSync(
      join(project, "Good.tsx"),
      [
        `export const G = () => <button className="rounded-md bg-neutral-100 focus-visible:bg-neutral-200 focus-visible:border-b-2 border-gray-200">탭</button>;`,
        `export const H = () => <div className="rounded-lg focus-visible:md:border focus-visible:md:border-b focus-visible:md:border-l-4 md:focus-visible:divide-y" />;`,
        `export const I = () => <div className="focus-visible:data-[state=active]:border-b-2 focus-visible:focus:ring-2" />;`,
      ].join("\n"),
    );

    const rulesPath = join(dirname(scriptPath), "rules.lines.mjs");
    const result = scan(project, "--json", `--rules=${rulesPath}`, "--only=ln-01,ln-02,ln-03,ln-04,ln-05");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const files = (id) => (finding(report, id)?.hits ?? []).map((hit) => `${hit.file}:${hit.line}`).sort();

    assert.deepEqual(files("ln-01"), [
      "Bad.tsx:1", "bad.css:1", "bad.css:12", "bad.css:15", "bad.css:6", "bad.css:8", "page.html:3", "styles.scss:2",
    ]);
    assert.deepEqual(files("ln-02"), [
      "Bad.tsx:1", "Bad.tsx:5", "Bad.tsx:6", "bad.css:13", "bad.css:14", "bad.css:2", "bad.css:7", "page.html:2",
    ]);
    assert.deepEqual(files("ln-03"), [
      "Bad.tsx:2", "Bad.tsx:7", "bad.css:11", "bad.css:14", "bad.css:3", "slides.js:1", "slides.js:2",
    ]);
    assert.deepEqual(files("ln-04"), [
      "Bad.tsx:1", "Bad.tsx:2", "Bad.tsx:3", "Bad.tsx:4", "Bad.tsx:7",
      "bad.css:1", "bad.css:12", "bad.css:15", "bad.css:4", "bad.css:9", "page.html:3", "styles.scss:2",
    ]);
    assert.deepEqual(files("ln-05"), ["Bad.tsx:3", "Bad.tsx:7", "bad.css:5"]);
  });
});

test("rules.defaults.mjs flags unchosen default values and shapes, not chosen ones", () => {
  withTempProject((project) => {
    writeFileSync(
      join(project, "bad.css"),
      [
        `.muted { color: #6B7280; }`,
        `.tag { background: var(--primary, #4f46e5); }`,
        `.bar { background: #d97757; }`,
        `body { background: #faf8f5; }`,
        `:root { --paper: hsl(38, 40%, 96%); }`,
        `h1 { font-family: "Instrument Serif", serif; }`,
        `h2 em { font-style: italic; }`,
        `.card:hover { transform: translateY(-2px); }`,
        `.hero { background: linear-gradient(135deg, #123456, #654321); }`,
        `:root { --primary: #8b5cf6; }`,
        `ol { list-style: decimal-leading-zero; }`,
        `.warn { color: #facc15; border: 1px solid #0284c7; background: #f8fafc; }`,
        `:root { --primary: var(--chosen, #7e22ce); }`,
      ].join("\n"),
    );
    writeFileSync(
      join(project, "Bad.tsx"),
      [
        `export const A = () => <h1>Build <em>faster</em></h1>;`,
        `export const B = () => <span>01 · 시작하기</span>;`,
        `export const C = () => <button className="bg-indigo-600 text-white">Go</button>;`,
        `export const D = () => <div onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; }} />;`,
        `export const E = () => <motion.div whileHover={{ scale: 1.05 }} />;`,
        `export const F = () => <h1><span>Build <em>faster</em></span></h1>;`,
      ].join("\n"),
    );
    writeFileSync(
      join(project, "good.css"),
      [
        `:root { --accent: #2f6f5e; --bg: #f7f7f5; --brand: #635bff; }`,
        `.tab:hover { background: var(--surface-2); }`,
        `.btn:active { transform: scale(0.98); }`,
        `.page { background: linear-gradient(to bottom, #fff, #f6f6f6); }`,
        `.heat i { background: hsl(28, 80%, 95%); }`,
        `/* id #6b7280a in a comment-like token */ .x { content: "#6b7280a"; }`,
        `.v { background: linear-gradient(180deg, #fff, #eee); background: linear-gradient(0deg, #fff, #eee); background: linear-gradient(720deg, #fff, #eee); }`,
        `.plain { color: #f5f5f5; background: #e5e5e5; }`,
      ].join("\n"),
    );
    writeFileSync(
      join(project, "Good.tsx"),
      [
        `export const P = () => <p className="pg">02 / 21</p>;`,
        `export const Q = () => <h1>제품 이름</h1>;`,
        `export const R = () => <button className="bg-[var(--accent)]">저장</button>;`,
        `export const S = () => <motion.div whileHover={{ scale: 0.98, y: 2 }} />;`,
        `export const T = () => <h2>목록</h2>;`,
        `export const U = () => <p><em>참고</em></p>;`,
      ].join("\n"),
    );

    const rulesPath = join(dirname(scriptPath), "rules.defaults.mjs");
    const ids = ["df-01", "df-02", "df-03", "df-04", "df-05", "df-06", "df-07", "df-08", "df-09"];
    const result = scan(project, "--json", `--rules=${rulesPath}`, `--only=${ids.join(",")}`);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const files = (id) => (finding(report, id)?.hits ?? []).map((hit) => `${hit.file}:${hit.line}`).sort();

    assert.deepEqual(files("df-01"), ["Bad.tsx:4", "bad.css:1", "bad.css:10", "bad.css:12", "bad.css:13", "bad.css:2"]);
    assert.deepEqual(files("df-02"), ["bad.css:3"]);
    assert.deepEqual(files("df-03"), ["bad.css:4", "bad.css:5"]);
    assert.deepEqual(files("df-04"), ["bad.css:6"]);
    assert.deepEqual(files("df-05"), ["Bad.tsx:1", "Bad.tsx:6", "bad.css:7"]);
    assert.deepEqual(files("df-06"), ["Bad.tsx:2", "bad.css:11"]);
    assert.deepEqual(files("df-07"), ["Bad.tsx:5", "bad.css:8"]);
    assert.deepEqual(files("df-08"), ["bad.css:9"]);
    assert.deepEqual(files("df-09"), ["Bad.tsx:3", "bad.css:10", "bad.css:13", "bad.css:2"]);
  });
});

test("rules.defaults.mjs stays linear on a long run of word characters", () => {
  withTempProject((project) => {
    writeFileSync(join(project, "long.css"), `${"a".repeat(512_000)}\n`);
    const rulesPath = join(dirname(scriptPath), "rules.defaults.mjs");
    const result = spawnSync(process.execPath, [scriptPath, project, "--json", `--rules=${rulesPath}`], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, "scan timed out");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("escapes control characters in human output", () => {
  withTempProject((project) => {
    const control = "\u001b]52;c;not-a-clipboard\u0007";
    writeFileSync(
      join(project, "unsafe.css"),
      `.x { background: linear-gradient(to bottom, red, blue); ${control} }`,
    );

    const result = scan(project, "--no-color");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(control), false);
    assert.ok(result.stdout.includes("\\x1b]52;c;not-a-clipboard\\x07"));

    const jsonResult = scan(project, "--json");
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.doesNotThrow(() => JSON.parse(jsonResult.stdout));
  });
});
