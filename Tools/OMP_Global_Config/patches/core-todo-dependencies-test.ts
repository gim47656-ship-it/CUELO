// Run the real TodoTool and TodoTracker with patched source loaded from an isolated fixture.
// No installed SDK file or user session is modified.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TodoPhase } from "../../../lib/todo-state";

const core = process.env.OMP_CORE_PATCH_TARGET ?? resolve(import.meta.dirname, "../../../node_modules/@oh-my-pi/pi-coding-agent");
const script = resolve(import.meta.dirname, "apply-core-patch.mjs");
const root = mkdtempSync(join(tmpdir(), "cuelo-todo-dependencies-"));
const fixture = join(root, "target");
const home = join(root, "home");
const baseline = process.env.TODO_DEPENDENCIES_BASELINE === "1";
const originalHome = homedir();
try {
  mkdirSync(home);
  const source = readFileSync(script, "utf8");
  for (const file of new Set([...source.matchAll(/^\s*file: "([^"]+)",\s*$/gm)].map(match => match[1]!))) {
    const original = join(core, file);
    if (!existsSync(original)) continue;
    const dest = join(fixture, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(original, dest);
  }
  for (const args of [[], ["--check"], []]) {
    const result = spawnSync("node", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, OMP_CORE_PATCH_TARGET: fixture, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0, `isolated patch ${args.join(" ")}:\n${result.stdout}\n${result.stderr}`);
    console.log(`patch ${args.length ? args.join(" ") : "apply/reapply"}: exit ${result.status}`);
  }
  // Resolve every import through the installed dependency graph, substituting only isolated patched source.
  Bun.plugin({
    name: "todo-dependencies-fixture",
    setup(build) {
      build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.ts$/ }, args => {
        const [pkg, ...rest] = args.path.replaceAll("\\", "/").split("/@oh-my-pi/").at(-1)!.split("/");
        const patched = pkg === "pi-coding-agent" ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
        const contents = readFileSync(baseline || !existsSync(patched) ? args.path : patched, "utf8");
        return args.path.endsWith(".d.ts") ? { exports: { default: contents }, loader: "object" } : { contents, loader: "ts" };
      });
    },
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".omp", "agent");
  // Imports are runtime-selected by OMP_CORE_PATCH_TARGET and intercepted only after the fixture is ready.
  const { setAgentDir } = await import(join(dirname(core), "pi-utils/src/dirs.ts"));
  setAgentDir(join(home, ".omp", "agent"));
  const { TodoTool, getLatestTodoPhasesFromEntries, phasesToMarkdown, markdownToPhases, nextActionableTask, unmetTodoDependencies } = await import(join(core, "src/tools/todo.ts"));
  const { TodoTracker } = await import(join(core, "src/session/todo-tracker.ts"));
  const events: { type: string; phases: TodoPhase[] }[] = [];
  const entries: unknown[] = [];
  const disk = join(root, "session.jsonl");
  const host = {
    emitSessionEvent: async (event: { type: string; phases: TodoPhase[] }) => { events.push(event); },
    sessionManager: { getBranch: () => entries },
  };
  const tracker = new TodoTracker(host as never);
  const tool = new TodoTool({
    getTodoPhases: () => tracker.phases,
    setTodoPhases: (phases: TodoPhase[]) => tracker.setPhases(phases),
    getSessionFile: () => disk,
  } as never);
  let call = 0;
  async function op(params: Record<string, unknown>, fails = false) {
    const result = await tool.execute(`todo-${++call}`, params as never);
    assert.equal(!!result.isError, fails, JSON.stringify(result));
    if (!result.isError && params.op !== "view") {
      entries.push({ type: "message", id: String(call), message: { role: "toolResult", toolName: "todo", ...result } });
      writeFileSync(disk, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    }
    return result;
  }
  const task = (content: string) => (tracker.phases as TodoPhase[]).flatMap(phase => phase.tasks).find(item => item.content === content)!;
  const waits = (content: string) => unmetTodoDependencies(task(content), tracker.phases);

  await op({ op: "init", items: ["A", "B", "C"] });
  assert.equal(task("A").status, "in_progress");
  const legacy = tracker.phases;
  assert.equal(nextActionableTask(legacy)?.content, "A");
  await op({ op: "depend", task: "B", after: ["A"] });
  assert.deepEqual(waits("B"), ["A"]);
  assert.deepEqual(waits("C"), []);
  assert.deepEqual(events.at(-1)!.phases[0].tasks[1].dependsOn, ["A"]);
  const escaped = tracker.phases;
  escaped[0].tasks[1].dependsOn!.push("C");
  assert.deepEqual(task("B").dependsOn, ["A"], "read clones must not mutate canonical dependencies");
  console.log("A unfinished: B waits for A; independent C ready; event and defensive clone preserve dependencies");

  await op({ op: "block", task: "A", reason: "waiting for acceptance" });
  assert.equal(nextActionableTask(tracker.phases)?.content, "C", "auto-start skips waiting B");
  assert.deepEqual(waits("B"), ["A"]);
  await op({ op: "unblock", task: "A" });
  await op({ op: "done", task: "A" });
  assert.deepEqual(waits("B"), []);
  await op({ op: "start", task: "B" });
  await op({ op: "start", task: "A" });
  assert.deepEqual(waits("B"), ["A"], "rework A blocks B again");
  assert.equal(task("B").status, "pending");
  console.log("explicit done A releases B; explicit start A for rework makes B wait again");

  const reloadedEntries = readFileSync(disk, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const reloaded = getLatestTodoPhasesFromEntries(reloadedEntries);
  assert.deepEqual(reloaded, tracker.phases);
  const reloadTracker = new TodoTracker({ ...host, sessionManager: { getBranch: () => reloadedEntries } } as never);
  reloadTracker.syncFromBranch();
  assert.deepEqual(reloadTracker.phases, tracker.phases);
  assert.deepEqual(unmetTodoDependencies(reloadTracker.phases[0].tasks[1], reloadTracker.phases), ["A"]);
  console.log("JSONL persisted tool result -> canonical reader -> tracker rehydration preserves waiting state");

  await op({ op: "block", task: "B", reason: "manual note" });
  const markdown = phasesToMarkdown(tracker.phases);
  const roundTrip = markdownToPhases(markdown);
  assert.deepEqual(roundTrip.errors, []);
  assert.deepEqual(roundTrip.phases, tracker.phases, "markdown user edits must preserve blocker and prerequisites");
  const reordered = markdownToPhases(markdown.replace('<!-- blocker: manual note --> <!-- after: ["A"] -->', '<!-- after: ["A"] --> <!-- blocker: manual note -->'));
  assert.deepEqual(reordered.errors, []);
  assert.deepEqual(reordered.phases, tracker.phases, "user-reordered metadata comments must not rename B or lose its dependencies");
  const malformed = markdownToPhases('# Plan\n- [ ] B <!-- after: not-json -->\n');
  assert.deepEqual(malformed.errors, ["Line 2: unreadable after list (use a JSON array of task texts)"]);
  assert.deepEqual(malformed.phases[0].tasks, []);
  console.log("R1-ANT-2: malformed after list returns line-specific error without throwing");
  const unblockedEdit = markdownToPhases('# Plan\n- [/] A\n- [ ] B <!-- after: ["A"] --> <!-- blocker: x -->\n');
  assert.equal(unblockedEdit.phases[0].tasks[1].content, "B", "R1-ANT-1: changing status in markdown must not rename B");
  assert.deepEqual(unmetTodoDependencies(unblockedEdit.phases[0].tasks[1], unblockedEdit.phases), ["A"]);
  console.log("R1-ANT-1: markdown status edit preserves prerequisites with reordered comments");
  const renamed = markdownToPhases(markdown.replace("] A\n", "] A renamed\n"));
  assert.deepEqual(unmetTodoDependencies(renamed.phases[0].tasks[1], renamed.phases), ["A"]);
  const custom = getLatestTodoPhasesFromEntries([{ type: "custom", customType: "user_todo_edit", data: { phases: roundTrip.phases } }]);
  assert.deepEqual(custom, tracker.phases);
  console.log("markdown and user_todo_edit round-trip preserve dependencies and manual blocker; renamed prerequisite stays unmet");

  for (const after of [["B"], ["missing"]]) {
    const before = tracker.phases;
    await op({ op: "depend", task: "B", after }, true);
    assert.deepEqual(tracker.phases, before);
  }
  await op({ op: "depend", task: "A", after: ["B"] }, true);
  await op({ op: "depend", task: "B" }, true);
  await op({ op: "drop", task: "A" });
  assert.deepEqual(waits("B"), ["A"], "abandoned is not accepted completion");
  await op({ op: "rm", task: "A" });
  assert.deepEqual(waits("B"), ["A"], "removal must not implicitly accept a prerequisite");
  await op({ op: "depend", task: "B", after: [] });
  assert.deepEqual(waits("B"), []);
  assert.equal(task("B").status, "blocked", "clearing dependencies must not clear the manual blocker");
  await op({ op: "done", task: "C" });
  await op({ op: "unblock", task: "B" });
  assert.equal(task("B").status, "in_progress");
  console.log("self/missing/cyclic dependencies rejected atomically; abandon/remove do not release; explicit clear preserves manual blocker");

  await op({ op: "init", items: ["old one", "old two"] });
  await op({ op: "done", task: "old one" });
  assert.equal(task("old two").status, "in_progress");
  assert.deepEqual(markdownToPhases(phasesToMarkdown(tracker.phases)).phases, tracker.phases);
  console.log("legacy init/done auto-start and markdown behavior unchanged; all focused checks complete");
} finally {
  process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
}
