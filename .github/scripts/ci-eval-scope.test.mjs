import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decide, pickBaseline, PRIVATE_JOB, touchesEvalInputs } from "./ci-eval-scope.mjs";

const H = "Tools/OMP_Global_Config";
const BASE = "a".repeat(40);
const OTHER = "b".repeat(40);
const HEAD = "c".repeat(40);
const run = (id, overrides = {}) => ({ id, conclusion: "success", head_branch: "main", event: "push", head_sha: BASE, ...overrides });
const okJobs = [{ name: PRIVATE_JOB, conclusion: "success" }];

/** Fake GitHub API and git for one decision. `diff` is the NUL-separated `git diff --name-only -z` output. */
function harness({ runs, jobs = {}, diff = "", local = [BASE], head = HEAD, fail } = {}) {
  const calls = [];
  const api = async (path) => {
    calls.push(["api", path]);
    if (fail === "api") throw new Error("GitHub API answered 500");
    if (path.includes("/runs?")) return { workflow_runs: runs };
    const id = Number(/runs\/(\d+)\/jobs/.exec(path)?.[1]);
    return { jobs: jobs[id] ?? okJobs };
  };
  const git = async (args) => {
    calls.push(["git", ...args]);
    if (fail === "git") throw new Error("fatal: unable to access");
    if (args[0] === "cat-file") {
      const sha = args[2].replace("^{commit}", "");
      if (!local.includes(sha)) throw new Error("not a valid object");
      return "";
    }
    if (args[0] === "fetch") {
      local.push(args.at(-1));
      return "";
    }
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "diff") return diff;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { api, git, calls };
}

describe("touchesEvalInputs", () => {
  test("only the three trees the analyzers read count", () => {
    assert.equal(touchesEvalInputs([`${H}/evals/analyze-evals.test.mjs`]), true);
    assert.equal(touchesEvalInputs([`${H}/agent/rules/subagent.md`]), true);
    assert.equal(touchesEvalInputs([`${H}/patches/validate-harness-policy.mjs`]), true);
    assert.equal(touchesEvalInputs(["lib/rpc-manager.ts", "Tools/CUELO_Setup/files/btw-server.js", `${H}/skill-cost/index.ts`, `${H}/README.md`]), false);
    assert.equal(touchesEvalInputs([`${H}/evals-notes.md`, `Other/${H}/evals/x.mjs`]), false);
  });
});

describe("pickBaseline", () => {
  test("takes the newest successful push or dispatch run whose private job succeeded, never the current run", async () => {
    const runs = [
      run(1, { head_sha: "1".repeat(40) }),
      run(2, { head_sha: "2".repeat(40), event: "pull_request" }),
      run(3, { head_sha: "3".repeat(40), head_branch: "feature" }),
      run(4, { head_sha: "4".repeat(40) }),
      run(5, { head_sha: "5".repeat(40), event: "workflow_dispatch" }),
    ];
    const jobsOf = async (id) => (id === 4 ? [{ name: PRIVATE_JOB, conclusion: "skipped" }] : okJobs);
    assert.equal(await pickBaseline({ runs, currentRunId: "1", jobsOf }), "5".repeat(40));
    assert.equal(await pickBaseline({ runs: runs.slice(0, 4), currentRunId: "1", jobsOf }), null);
  });
});

describe("decide", () => {
  test("skips the step when nothing under evals/, agent/ or patches/ changed since the baseline", async () => {
    const h = harness({ runs: [run(9)], diff: `lib/a.ts\0Tools/CUELO_Setup/files/btw-server.js\0` });
    const result = await decide({ event: "push", ...h, currentRunId: "10" });
    assert.equal(result.run, false);
    assert.equal(result.baseline, BASE);
  });

  test("runs the step when one changed path is under any of the three trees", async () => {
    for (const path of [`${H}/evals/x.mjs`, `${H}/agent/config.yml`, `${H}/patches/y.mjs`]) {
      const h = harness({ runs: [run(9)], diff: `lib/a.ts\0${path}\0` });
      assert.equal((await decide({ event: "push", ...h, currentRunId: "10" })).run, true, path);
    }
  });

  test("diffs against the last verified commit, so an evals change in a cancelled run is still seen by the next push", async () => {
    // Run 8 (head OTHER) was cancelled and is not in the success list; the last success is BASE.
    const h = harness({ runs: [run(7)], diff: `${H}/evals/analyze-evals.test.mjs\0lib/a.ts\0`, head: HEAD });
    const result = await decide({ event: "push", ...h, currentRunId: "9" });
    assert.equal(result.run, true);
    assert.deepEqual(h.calls.find((c) => c[1] === "diff")?.slice(-2), [BASE, "HEAD"]);
    assert.ok(!h.calls.some((c) => c.join(" ").includes(OTHER)));
  });

  test("fetches the baseline commit when the shallow checkout lacks it", async () => {
    const h = harness({ runs: [run(9)], diff: "lib/a.ts\0", local: [] });
    const result = await decide({ event: "push", ...h, currentRunId: "10" });
    assert.equal(result.run, false);
    assert.ok(h.calls.some((c) => c[1] === "fetch" && c.at(-1) === BASE));
  });

  test("runs the step whenever the answer is not certain", async () => {
    const cases = {
      "manual run": { event: "workflow_dispatch", h: harness({ runs: [run(9)], diff: "lib/a.ts\0" }) },
      "no baseline": { event: "push", h: harness({ runs: [] }) },
      "empty diff": { event: "push", h: harness({ runs: [run(9)], diff: "" }) },
      "same revision": { event: "push", h: harness({ runs: [run(9)], diff: "lib/a.ts\0", head: BASE }) },
      "api failure": { event: "push", h: harness({ runs: [run(9)], fail: "api" }) },
      "git failure": { event: "push", h: harness({ runs: [run(9)], fail: "git" }) },
    };
    for (const [name, { event, h }] of Object.entries(cases)) {
      const result = await decide({ event, ...h, currentRunId: "10" });
      assert.equal(result.run, true, name);
    }
  });

  test("an exhausted budget runs the step", async () => {
    const h = harness({ runs: [run(9)], diff: "lib/a.ts\0" });
    const result = await decide({ event: "push", ...h, currentRunId: "10", budgetMs: -1 });
    assert.equal(result.run, true);
    assert.match(result.reason, /budget/);
  });
});
