import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { APP_JOBS, classifyChanges, decide, parseRawDiff, pickBaseline, runGit } from "./ci-scope.mjs";

const H = "Tools/OMP_Global_Config";
const mod = (...paths) => paths.map((path) => ({ status: "M", path, oldMode: "100644", newMode: "100644" }));

describe("classifyChanges", () => {
  test("skips only positively known docs and harness instruction files", () => {
    const skippable = [
      "README.md",
      "CHANGELOG.md",
      "docs/harness.md",
      "docs/maker-quality/rubric.md",
      `${H}/agent/RULES.md`,
      `${H}/agent/AGENTS.md`,
      `${H}/agent/prompt-copies/RULES.en.md`,
      `${H}/agent/rules/subagent.md`,
      `${H}/agent/sop/maker.md`,
      `${H}/agent/agents/maker.md`,
    ];
    assert.equal(classifyChanges(mod(...skippable)).app, false);
    assert.equal(classifyChanges([{ status: "A", path: "docs/new-page.md", oldMode: "000000", newMode: "100644" }]).app, false);
  });

  test("runs the app for every input the app jobs read, even when the extension looks harmless", () => {
    const unsafe = [
      "package.json",
      "bun.lock",
      "next.config.ts",
      "app/page.tsx",
      "lib/rpc-manager.ts",
      "install.mjs",
      "bin/cuelo.js",
      ".github/workflows/ci.yml",
      ".github/scripts/ci-scope.mjs",
      "Tools/CUELO_Setup/files/btw-server.js",
      `${H}/patches/apply-core-patch.mjs`,
      `${H}/patches/core-patch-test.ts`,
      `${H}/notices/workflow.md`, // prepare:source appends these into the SDK
      `${H}/agent/rules/harness-policy.json`,
      `${H}/agent/extensions/korean-reply-guard.ts`, // imported by an app test
      `${H}/agent/tools/git-finalizer/wsl-git.ts`, // imported by an app test
      `${H}/agent/tools/git-finalizer/README.md`,
      `${H}/agent/rules/nested/deep.md`,
      `${H}/agent/sop/script.sh`,
      `${H}/agent/config.yml`,
      "docs/hero.webp",
      "docs/page.md.js",
      "docs/page.mdx",
      "docs/../package.json",
      "docs//x.md",
      "docs\\x.md",
      "public/README.md",
      "app/README.md",
      "README.md/extra",
      "AGENTS.md",
      "",
    ];
    for (const path of unsafe) {
      assert.equal(classifyChanges(mod(path)).app, true, `${path} must run the app jobs`);
    }
  });

  test("one unsafe path among docs makes the whole change run the app", () => {
    assert.equal(classifyChanges(mod("docs/harness.md", `${H}/agent/RULES.md`, "lib/x.ts")).app, true);
    assert.equal(classifyChanges(mod("docs/harness.md", "package.json")).app, true);
  });

  test("deletes, renames, type changes and unknown statuses are never skipped", () => {
    for (const status of ["D", "R", "C", "T", "U", "X", "", "MM"]) {
      assert.equal(classifyChanges([{ status, path: "docs/harness.md", oldMode: "100644", newMode: "100644" }]).app, true, `status ${status}`);
    }
  });

  test("only regular files can be skipped: symlinks, submodules, executables and mode changes run the app", () => {
    const change = (status, oldMode, newMode) => [{ status, path: "docs/harness.md", oldMode, newMode }];
    assert.equal(classifyChanges(change("A", "000000", "100644")).app, false);
    assert.equal(classifyChanges(change("M", "100644", "100644")).app, false);
    for (const [status, oldMode, newMode] of [
      ["A", "000000", "120000"], ["A", "000000", "160000"], ["A", "000000", "100755"],
      ["M", "100644", "120000"], ["M", "120000", "100644"], ["M", "100644", "100755"], ["M", "160000", "160000"],
    ]) {
      assert.equal(classifyChanges(change(status, oldMode, newMode)).app, true, `${status} ${oldMode} -> ${newMode}`);
    }
    assert.equal(classifyChanges([{ status: "A", path: "docs/harness.md" }]).app, true, "missing mode is unknown");
  });

  test("an empty or missing change list is unknown, not docs-only", () => {
    assert.equal(classifyChanges([]).app, true);
    assert.equal(classifyChanges(undefined).app, true);
  });
});

describe("parseRawDiff", () => {
  const sha = "1".repeat(40);
  const meta = (oldMode, newMode, status) => `:${oldMode} ${newMode} ${sha} ${sha} ${status}`;
  test("reads NUL-separated raw entries with modes, including names git would quote", () => {
    assert.deepEqual(parseRawDiff(`${meta("100644", "100644", "M")}\0docs/한글 문서.md\0${meta("000000", "120000", "A")}\0a b.md\0`), [
      { oldMode: "100644", newMode: "100644", status: "M", path: "docs/한글 문서.md" },
      { oldMode: "000000", newMode: "120000", status: "A", path: "a b.md" },
    ]);
    assert.deepEqual(parseRawDiff(""), []);
  });
  test("malformed output is an error, not a guess", () => {
    assert.throws(() => parseRawDiff(`${meta("100644", "100644", "M")}\0docs/a.md\0${meta("100644", "100644", "A")}\0`));
    assert.throws(() => parseRawDiff("M\0docs/a.md\0"));
  });
});

describe("pickBaseline", () => {
  const sha = (c) => c.repeat(40);
  const ok = APP_JOBS.map((name) => ({ name, conclusion: "success" }));
  const run = (id, over = {}) => ({ id, head_sha: sha(String(id)), head_branch: "main", event: "push", conclusion: "success", ...over });
  const jobsFor = (table) => async (id) => table[id] ?? [];

  test("takes the newest run whose app jobs both succeeded", async () => {
    const jobs = { 3: ok, 2: ok };
    assert.equal(await pickBaseline({ runs: [run(3), run(2)], currentRunId: 9, jobsOf: jobsFor(jobs) }), sha("3"));
  });

  test("skips runs whose app jobs were skipped, failed or cancelled, and one-sided passes", async () => {
    const jobs = {
      5: APP_JOBS.map((name) => ({ name, conclusion: "skipped" })),
      4: [{ name: APP_JOBS[0], conclusion: "success" }, { name: APP_JOBS[1], conclusion: "cancelled" }],
      3: [{ name: APP_JOBS[0], conclusion: "failure" }, { name: APP_JOBS[1], conclusion: "success" }],
      2: [{ name: APP_JOBS[0], conclusion: "success" }],
      1: ok,
    };
    const runs = [5, 4, 3, 2, 1].map((id) => run(id));
    assert.equal(await pickBaseline({ runs, currentRunId: 9, jobsOf: jobsFor(jobs) }), sha("1"));
  });

  test("ignores the current run, unsuccessful runs and runs from other branches or events", async () => {
    const jobs = { 9: ok, 8: ok, 7: ok, 6: ok };
    const runs = [run(9), run(8, { conclusion: "failure" }), run(7, { head_branch: "x" }), run(6, { event: "pull_request" })];
    assert.equal(await pickBaseline({ runs, currentRunId: "9", jobsOf: jobsFor(jobs) }), null);
  });

  test("no runs means no baseline", async () => {
    assert.equal(await pickBaseline({ runs: [], currentRunId: 1, jobsOf: jobsFor({}) }), null);
  });
});

// Real Git: a bare origin, a shallow checkout like actions/checkout, and a stubbed API.
const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const run = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
  roots.push(root);
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  mkdirSync(seed);
  run(seed, "init", "-q", "-b", "main");
  const write = (dir, path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message) => {
    run(seed, "add", "-A");
    run(seed, "commit", "-q", "-m", message);
    return run(seed, "rev-parse", "HEAD");
  };
  write(seed, "package.json", '{"version":"1.0.0"}\n');
  write(seed, "lib/a.ts", "export const a = 1;\n");
  write(seed, "docs/harness.md", "one\n");
  write(seed, `${H}/agent/RULES.md`, "rule\n");
  const base = commit("baseline");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  run(seed, "push", "-q", origin, "main");
  const push = () => run(seed, "push", "-q", origin, "main");
  // `actions/checkout` fetches only the revision under test, depth 1.
  const checkout = (sha) => {
    const dir = mkdtempSync(join(root, "work-"));
    run(dir, "init", "-q");
    run(dir, "remote", "add", "origin", `file://${origin}`);
    run(dir, "fetch", "-q", "--no-tags", "--depth=1", "origin", sha);
    run(dir, "checkout", "-q", "--detach", sha);
    return dir;
  };
  return { seed, base, write, commit, push, checkout };
}

const OK_JOBS = APP_JOBS.map((name) => ({ name, conclusion: "success" }));
function stubApi(baselineSha) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.includes("/runs?")) {
      return { workflow_runs: baselineSha ? [{ id: 11, head_sha: baselineSha, head_branch: "main", event: "push", conclusion: "success" }] : [] };
    }
    return { jobs: OK_JOBS };
  };
  return { api, calls };
}
const decideIn = (dir, event, api) => decide({ event, api, currentRunId: 99, git: (args) => run(dir, ...args) });

describe("decide against real Git history", () => {
  test("docs and harness-instruction commits since the verified baseline skip the app jobs", async () => {
    const f = fixture();
    f.write(f.seed, "docs/harness.md", "two\n");
    f.write(f.seed, `${H}/agent/RULES.md`, "rule 2\n");
    f.write(f.seed, `${H}/agent/prompt-copies/RULES.en.md`, "copy\n");
    const head = f.commit("docs only");
    f.push();
    const result = await decideIn(f.checkout(head), "push", stubApi(f.base).api);
    assert.equal(result.app, false, result.reason);
    assert.equal(result.baseline, f.base);
  });

  test("a code commit between the baseline and head still runs the app, even when the head commit is docs-only", async () => {
    const f = fixture();
    f.write(f.seed, "lib/a.ts", "export const a = 2;\n");
    f.commit("code (its CI was cancelled)");
    f.write(f.seed, "docs/harness.md", "two\n");
    const head = f.commit("docs only");
    f.push();
    const result = await decideIn(f.checkout(head), "push", stubApi(f.base).api);
    assert.equal(result.app, true);
    assert.match(result.reason, /lib\/a\.ts/);
  });

  test("a version bump in a mixed commit runs the app", async () => {
    const f = fixture();
    f.write(f.seed, "package.json", '{"version":"1.0.1"}\n');
    f.write(f.seed, "CHANGELOG.md", "notes\n");
    const head = f.commit("release");
    f.push();
    assert.equal((await decideIn(f.checkout(head), "push", stubApi(f.base).api)).app, true);
  });

  test("a deleted or renamed docs file is not skipped", async () => {
    const f = fixture();
    renameSync(join(f.seed, "docs/harness.md"), join(f.seed, "docs/renamed.md"));
    const head = f.commit("rename");
    f.push();
    const result = await decideIn(f.checkout(head), "push", stubApi(f.base).api);
    assert.equal(result.app, true);
    assert.match(result.reason, /^D docs\/harness\.md/);
  });

  test("an unchanged tree has no diff and is not treated as docs-only", async () => {
    const f = fixture();
    const empty = (run(f.seed, "commit", "-q", "--allow-empty", "-m", "empty"), run(f.seed, "rev-parse", "HEAD"));
    f.push();
    assert.equal((await decideIn(f.checkout(empty), "push", stubApi(f.base).api)).app, true);
    assert.equal((await decideIn(f.checkout(f.base), "push", stubApi(f.base).api)).app, true);
  });

  test("pull requests are never skipped, even when the diff is docs-only", async () => {
    const f = fixture();
    f.write(f.seed, "docs/harness.md", "pr edit\n");
    const head = f.commit("pr docs");
    f.push();
    const { api, calls } = stubApi(f.base);
    assert.equal((await decideIn(f.checkout(head), "pull_request", api)).app, true);
    assert.deepEqual(calls, []);
  });

  test("manual runs and other events run everything without asking the API", async () => {
    const f = fixture();
    const { api, calls } = stubApi(f.base);
    const dir = f.checkout(f.base);
    for (const event of ["workflow_dispatch", "schedule", "", undefined]) {
      assert.equal((await decideIn(dir, event, api)).app, true);
    }
    assert.deepEqual(calls, []);
  });

  test("a missing baseline, an unfetchable baseline or an API failure runs everything", async () => {
    const f = fixture();
    f.write(f.seed, "docs/harness.md", "two\n");
    const head = f.commit("docs only");
    f.push();
    const dir = f.checkout(head);
    assert.equal((await decideIn(dir, "push", stubApi(null).api)).app, true);
    assert.equal((await decideIn(dir, "push", stubApi("a".repeat(40)).api)).app, true);
    const gitCalls = [];
    const refused = await decide({ event: "push", api: stubApi("--upload-pack=x").api, currentRunId: 99, git: (args) => gitCalls.push(args) });
    assert.equal(refused.app, true);
    assert.deepEqual(gitCalls, [], "a baseline that is not a full SHA must never reach git");
    const failing = await decideIn(dir, "push", async () => { throw new Error("GitHub API /runs answered 403"); });
    assert.equal(failing.app, true);
    assert.match(failing.reason, /403/);
  });
});

// Git reports a symlink or a submodule as a plain added path with --name-status; the
// selector must look at the file mode.
describe("non-regular files are never skipped", () => {
  const baseAndHead = async (arrange) => {
    const f = fixture();
    arrange(f);
    const head = f.commit("docs path that is not a regular file");
    f.push();
    return decideIn(f.checkout(head), "push", stubApi(f.base).api);
  };

  test("a symlink named like a docs file runs the app", async () => {
    const result = await baseAndHead((f) => symlinkSync("../package.json", join(f.seed, "docs/new.md")));
    assert.equal(result.app, true);
    assert.match(result.reason, /docs\/new\.md is not a regular file \(mode 000000 -> 120000\)/);
  });

  test("a submodule (gitlink) named like a docs file runs the app", async () => {
    const result = await baseAndHead((f) => {
      const nested = join(f.seed, "docs/submodule.md");
      mkdirSync(nested);
      run(nested, "init", "-q");
      run(nested, "commit", "-q", "--allow-empty", "-m", "inner");
    });
    assert.equal(result.app, true);
    assert.match(result.reason, /docs\/submodule\.md is not a regular file \(mode 000000 -> 160000\)/);
  });

  test("an executable docs file and a docs file replaced by a symlink run the app", async () => {
    const exec = await baseAndHead((f) => {
      f.write(f.seed, "docs/run.md", "x\n");
      chmodSync(join(f.seed, "docs/run.md"), 0o755);
    });
    assert.equal(exec.app, true);
    const swapped = await baseAndHead((f) => {
      rmSync(join(f.seed, "docs/harness.md"));
      symlinkSync("../package.json", join(f.seed, "docs/harness.md"));
    });
    assert.equal(swapped.app, true);
    assert.match(swapped.reason, /^T docs\/harness\.md/);
  });
});

describe("decide stays inside its time budget", () => {
  const never = () => new Promise(() => {});

  test("a stalled API request returns app=true when the budget runs out", async () => {
    const started = Date.now();
    const result = await decide({ event: "push", api: never, git: () => "", currentRunId: 1, budgetMs: 100 });
    assert.equal(result.app, true);
    assert.match(result.reason, /budget of 100 ms exhausted/);
    assert.ok(Date.now() - started < 1000, "must not wait for the stalled request");
  });

  test("the budget is shared by every call, not granted per call", async () => {
    const started = Date.now();
    let calls = 0;
    const api = async (path) => {
      calls += 1;
      if (path.includes("/runs?")) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { workflow_runs: [{ id: 11, head_sha: "b".repeat(40), head_branch: "main", event: "push", conclusion: "success" }] };
      }
      return never();
    };
    const result = await decide({ event: "push", api, git: () => "", currentRunId: 1, budgetMs: 200 });
    assert.equal(calls, 2);
    assert.equal(result.app, true);
    assert.ok(Date.now() - started < 290, `took ${Date.now() - started} ms; a per-call budget would take about 320 ms`);
  });

  test("each call is told how much time is left", async () => {
    const seen = [];
    const api = async (path, { timeoutMs }) => {
      seen.push(timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return path.includes("/runs?") ? { workflow_runs: [{ id: 11, head_sha: "b".repeat(40), head_branch: "main", event: "push", conclusion: "success" }] } : { jobs: OK_JOBS };
    };
    await decide({ event: "push", api, git: (args, { timeoutMs }) => { seen.push(timeoutMs); return ""; }, currentRunId: 1, budgetMs: 5000 });
    assert.equal(seen.length, 5, "two API calls, then cat-file, rev-parse and diff");
    assert.ok(seen[0] <= 5000 && seen.every((ms, i) => i === 0 || ms <= seen[i - 1]), `remaining time must never grow: ${seen}`);
    assert.ok(seen.at(-1) <= seen[0] - 110, `two 60 ms API calls must be deducted: ${seen}`);
  });

  test("a git command that stalls is killed at its deadline", () => {
    const started = Date.now();
    assert.throws(() => runGit(["-c", "alias.stall=!exec sleep 3", "stall"], tmpdir(), 200));
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  });
});

// The CLI as the workflow runs it: env in, GITHUB_OUTPUT out, against a local API server.
describe("CLI output", () => {
  const SCRIPT = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));

  async function runCli({ env, cwd, mode }) {
    let requests = 0;
    const server = createServer((req, res) => {
      requests += 1;
      if (mode === "stall") return; // never answers
      if (mode === "403") { res.statusCode = 403; return res.end("{}"); }
      res.setHeader("content-type", "application/json");
      if (req.url.includes("/runs?")) {
        return res.end(JSON.stringify({ workflow_runs: [{ id: 11, head_sha: env.BASELINE, head_branch: "main", event: "push", conclusion: "success" }] }));
      }
      res.end(JSON.stringify({ jobs: OK_JOBS }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const output = join(mkdtempSync(join(tmpdir(), "ci-scope-out-")), "github_output");
    roots.push(dirname(output));
    writeFileSync(output, "");
    const started = Date.now();
    const child = spawn("node", [SCRIPT], {
      cwd,
      env: { ...GIT_ENV, GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "99", GITHUB_TOKEN: "t", GITHUB_OUTPUT: output, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, ...env },
      stdio: "ignore",
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    server.closeAllConnections();
    server.close();
    const lines = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    return { code, lines, requests, elapsed: Date.now() - started };
  }

  const docsOnly = () => {
    const f = fixture();
    f.write(f.seed, "docs/harness.md", "two\n");
    const head = f.commit("docs only");
    f.push();
    return { dir: f.checkout(head), baseline: f.base };
  };

  test("a docs-only push writes app=false with its baseline", async () => {
    const { dir, baseline } = docsOnly();
    const out = await runCli({ cwd: dir, env: { GITHUB_EVENT_NAME: "push", BASELINE: baseline } });
    assert.equal(out.code, 0);
    assert.equal(out.lines.app, "false");
    assert.equal(out.lines.baseline, baseline);
  });

  test("pull requests and manual runs write app=true without asking the API", async () => {
    const { dir, baseline } = docsOnly();
    for (const event of ["pull_request", "workflow_dispatch", ""]) {
      const out = await runCli({ cwd: dir, env: { GITHUB_EVENT_NAME: event, BASELINE: baseline } });
      assert.equal(out.code, 0);
      assert.equal(out.lines.app, "true", event);
      assert.equal(out.requests, 0);
    }
  });

  test("an API error writes app=true and exits 0", async () => {
    const { dir, baseline } = docsOnly();
    const out = await runCli({ cwd: dir, mode: "403", env: { GITHUB_EVENT_NAME: "push", BASELINE: baseline } });
    assert.equal(out.code, 0);
    assert.equal(out.lines.app, "true");
    assert.match(out.lines.reason, /403/);
  });

  test("a stalled API writes app=true at the budget instead of hanging", async () => {
    const { dir, baseline } = docsOnly();
    const out = await runCli({ cwd: dir, mode: "stall", env: { GITHUB_EVENT_NAME: "push", BASELINE: baseline, CI_SCOPE_BUDGET_MS: "300" } });
    assert.equal(out.code, 0);
    assert.equal(out.lines.app, "true");
    assert.match(out.lines.reason, /budget|timeout|abort/i);
    assert.ok(out.elapsed < 5000, `took ${out.elapsed} ms`);
  });
});
