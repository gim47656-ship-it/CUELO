import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runResolve, runReview, spawnExec } from "../../extensions/lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords } from "../../extensions/lib/routing-ledger";
import { integrateTool } from "./integrate";

// 검증 범위: 실제 git(bare 원격 + main clone + linked worktree + 다른 세션 clone)과 실제 pwsh 잠금 보유자로 git_integrate의
// 게시·충돌·되돌림·검사·대상 이동·manifest 재생성·거절과 git_finalize와 같은 잠금을 본다. 가짜 경계: 도구 API(pi)와 교차검증 reviewer 응답.
const lockScript = fileURLToPath(new URL("./integrate-lock.ps1", import.meta.url));
const finalizerScript = fileURLToPath(new URL("./finalizer.ps1", import.meta.url));
const powerShell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const TIMEOUT = 120_000;
const tempRoots: string[] = [];
const saved = { cross: process.env.OMP_CROSS_REVIEW_LEDGER, slop: process.env.OMP_SLOP_GATE_LEDGER };
let ledgers = "";

beforeAll(async () => {
  ledgers = await mkdtemp(join(tmpdir(), "omp-integrate-ledgers-"));
  process.env.OMP_CROSS_REVIEW_LEDGER = join(ledgers, "cross.jsonl");
  process.env.OMP_SLOP_GATE_LEDGER = join(ledgers, "slop.jsonl");
});
afterAll(async () => {
  for (const [key, value] of [["OMP_CROSS_REVIEW_LEDGER", saved.cross], ["OMP_SLOP_GATE_LEDGER", saved.slop]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(ledgers, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, args: string[], expectedCode = 0): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = result.stderr.toString().trim();
  expect(result.exitCode, stderr || result.stdout.toString()).toBe(expectedCode);
  return result.stdout.toString().trim();
}

interface Fixture { root: string; remote: string; work: string; tree: string; other: string }

async function commitIn(cwd: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  }
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** bare 원격, 원격 main을 쓰는 main clone(work), 그 linked worktree(wt/x), main에 먼저 올리는 다른 세션 clone(other). */
async function fixture(base: Record<string, string> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "omp-integrate-test-"));
  tempRoots.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const tree = join(root, "work-worktrees", "wt-x");
  const other = join(root, "other");
  git(root, ["init", "-q", "--bare", "--initial-branch=main", remote]);
  await mkdir(work);
  git(work, ["init", "-q", "--initial-branch=main"]);
  git(work, ["config", "user.name", "Integrate Test"]);
  git(work, ["config", "user.email", "integrate@example.invalid"]);
  await commitIn(work, { "a.txt": "base-a\n", "b.txt": "base-b\n", ...base }, "base");
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  git(work, ["worktree", "add", "-q", "-b", "wt/x", tree]);
  git(root, ["clone", "-q", remote, other]);
  git(other, ["config", "user.name", "Other Session"]);
  git(other, ["config", "user.email", "other@example.invalid"]);
  return { root, remote, work, tree, other };
}

async function pushOther(f: Fixture, files: Record<string, string>, message: string): Promise<string> {
  git(f.other, ["pull", "-q", "--ff-only"]);
  const sha = await commitIn(f.other, files, message);
  git(f.other, ["push", "-q", "origin", "main"]);
  return sha;
}

const remoteRef = (f: Fixture, ref = "refs/heads/main") => git(f.root, ["--git-dir", f.remote, "rev-parse", ref]);
const remoteFile = (f: Fixture, path: string) => git(f.root, ["--git-dir", f.remote, "show", `refs/heads/main:${path}`]);
const isAncestor = (f: Fixture, older: string, newer: string) => Bun.spawnSync({ cmd: ["git", "--git-dir", f.remote, "merge-base", "--is-ancestor", older, newer] }).exitCode === 0;
const rebasing = (f: Fixture) => existsSync(join(git(f.tree, ["rev-parse", "--absolute-git-dir"]), "rebase-merge"));
const stateFile = (f: Fixture) => join(f.tree, git(f.tree, ["rev-parse", "--git-path", "git-integrate.json"]));

const schemaNode: object = new Proxy(function node() {}, { get: () => schemaNode, apply: () => schemaNode });
interface Outcome { error?: Error; output?: { content: { text: string }[]; details: Record<string, any> } }

async function integrate(cwd: string, params: Record<string, unknown> = {}): Promise<Outcome> {
  const pi = { cwd, zod: { object: () => ({}), array: () => schemaNode, string: () => schemaNode, enum: () => schemaNode } };
  const tool = integrateTool(pi as never);
  try {
    return { output: await tool.execute("fixture", params, undefined, {} as never, new AbortController().signal) };
  } catch (error) {
    return { error: error as Error };
  }
}

/** integrate-lock.ps1을 직접 띄워 잠금을 쥔다. 첫 줄(잡았는지)과 놓기 함수를 돌려준다. */
async function holdLock(repository: string, options: { wait?: number; maxHold?: number } = {}) {
  const child = Bun.spawn({
    cmd: [powerShell, "-NoProfile", "-File", lockScript, "-Repository", repository, "-Remote", "origin", "-UpstreamRef", "refs/heads/main",
      "-WaitSeconds", String(options.wait ?? 30), "-MaxHoldSeconds", String(options.maxHold ?? 100)],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  return { reply: JSON.parse(new TextDecoder().decode(value).split("\n")[0]), child, release: async () => { child.stdin.end(); return child.exited; } };
}

// 다른 프로세스가 OS named mutex에 막혀 "아직 끝나지 않았다"는 것은 기다릴 사건이 없어 실제 시간으로만 보인다(가짜 타이머로 대신할 수 없다).
const settledWithin = async (promise: Promise<unknown>, ms: number) => Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);

describe("git_integrate", () => {
  test("rebases a clean session branch onto the moved target and fast-forwards it without force", async () => {
    const f = await fixture();
    await commitIn(f.tree, { "b.txt": "session-b\n" }, "feat: session b");
    git(f.tree, ["push", "-q", "-u", "origin", "wt/x"]);
    const targetSha = await pushOther(f, { "a.txt": "target-a\n" }, "fix: target a");

    const { output, error } = await integrate(f.tree, { checks: ["test \"$(cat a.txt)\" = target-a", "test \"$(cat b.txt)\" = session-b"] });
    expect(error).toBeUndefined();
    const pushed = remoteRef(f);
    expect(output?.details).toMatchObject({ ok: true, stage: "complete", commitSha: pushed, upstreamRef: "refs/heads/main", branch: "wt/x", previousTarget: targetSha, moves: 0 });
    expect(output?.content[0].text).toContain(`Integrated wt/x and pushed ${pushed} to origin refs/heads/main.`);
    expect(output?.content[0].text).toContain("--branch main");
    expect(isAncestor(f, targetSha, pushed)).toBe(true);
    expect(git(f.tree, ["rev-parse", "HEAD"])).toBe(pushed);
    expect(git(f.tree, ["log", "-1", "--format=%s"])).toBe("feat: session b");
    // 세션 브랜치의 원격 사본도 rebase된 tip으로 맞춘다(다음 git_finalize의 ancestry 확인).
    expect(remoteRef(f, "refs/heads/wt/x")).toBe(pushed);
    expect(existsSync(stateFile(f))).toBe(false);
    // 다시 부르면 올릴 것이 없다.
    const again = await integrate(f.tree, { checks: [] });
    expect(again.output?.details).toMatchObject({ ok: true, stage: "up-to-date" });
    expect(remoteRef(f)).toBe(pushed);
  }, TIMEOUT);

  test("stops on a conflict with both intents, refuses leftover markers, then publishes the resolution", async () => {
    const f = await fixture();
    const origHead = await commitIn(f.tree, { "a.txt": "session-a\n" }, "feat: session change\n\nwhy the session needs it");
    const targetSha = await pushOther(f, { "a.txt": "target-a\n" }, "fix: target change");

    const stopped = await integrate(f.tree, { checks: ["grep -q session-a a.txt"] });
    expect(stopped.error).toBeUndefined();
    expect(stopped.output?.details).toMatchObject({
      ok: false, stage: "conflict", conflicts: [{ path: "a.txt", kind: "both-modified" }],
      replaying: { sha: origHead, subject: "feat: session change", body: "why the session needs it" },
      targetCommits: [{ sha: targetSha, subject: "fix: target change" }],
    });
    expect(stopped.output?.details.commitSha).toBeUndefined();
    expect(rebasing(f)).toBe(true);
    expect(remoteRef(f)).toBe(targetSha);

    const marked = await integrate(f.tree, { action: "continue" });
    expect(marked.error?.message).toContain("conflict markers remain in: a.txt");
    expect(rebasing(f)).toBe(true);

    await writeFile(join(f.tree, "a.txt"), "target-a\nsession-a\n");
    // 충돌 밖 파일도 함께 고치면 같은 단계의 해결로 들어간다.
    await writeFile(join(f.tree, "b.txt"), "base-b\ncaller-update\n");
    const done = await integrate(f.tree, { action: "continue" });
    expect(done.error).toBeUndefined();
    expect(done.output?.details).toMatchObject({ ok: true, stage: "complete", commitSha: remoteRef(f) });
    expect(remoteFile(f, "b.txt")).toBe("base-b\ncaller-update");
    expect(git(f.tree, ["status", "--porcelain"])).toBe("");
    expect(remoteFile(f, "a.txt")).toBe("target-a\nsession-a");
    expect(git(f.tree, ["log", "-1", "--format=%s%n%b"])).toBe("feat: session change\nwhy the session needs it");
    expect(isAncestor(f, targetSha, remoteRef(f))).toBe(true);
    expect(rebasing(f)).toBe(false);
  }, TIMEOUT);

  test("abort restores the session branch and pushes nothing", async () => {
    const f = await fixture();
    const origHead = await commitIn(f.tree, { "a.txt": "session-a\n" }, "feat: session");
    const targetSha = await pushOther(f, { "a.txt": "target-a\n" }, "fix: target");
    expect((await integrate(f.tree, { checks: [] })).output?.details.stage).toBe("conflict");

    const aborted = await integrate(f.tree, { action: "abort" });
    expect(aborted.output?.details).toMatchObject({ ok: true, stage: "aborted", branch: "refs/heads/wt/x", head: origHead });
    expect(git(f.tree, ["rev-parse", "HEAD"])).toBe(origHead);
    expect(git(f.tree, ["symbolic-ref", "--short", "HEAD"])).toBe("wt/x");
    expect(git(f.tree, ["status", "--porcelain"])).toBe("");
    expect(rebasing(f)).toBe(false);
    expect(existsSync(stateFile(f))).toBe(false);
    expect(remoteRef(f)).toBe(targetSha);
    expect((await integrate(f.tree, { action: "continue" })).error?.message).toContain("no git_integrate run is paused");
  }, TIMEOUT);

  test("a conflict resolved by deleting the file with git rm continues and publishes the deletion", async () => {
    const f = await fixture();
    await commitIn(f.tree, { "a.txt": "session-a\n", "b.txt": "session-b\n" }, "feat: session");
    await pushOther(f, { "a.txt": "target-a\n" }, "fix: target");
    expect((await integrate(f.tree, { checks: [] })).output?.details.stage).toBe("conflict");
    git(f.tree, ["rm", "-q", "--", "a.txt"]);
    const done = await integrate(f.tree, { action: "continue" });
    expect(done.error).toBeUndefined();
    expect(done.output?.details.stage).toBe("complete");
    expect(git(f.root, ["--git-dir", f.remote, "ls-tree", "--name-only", "refs/heads/main"]).split("\n")).toEqual(["b.txt"]);
  }, TIMEOUT);

  test("failing checks or checks that change tracked files stop before the push", async () => {
    const f = await fixture();
    await commitIn(f.tree, { "b.txt": "session-b\n" }, "feat: session b");
    const targetSha = await pushOther(f, { "a.txt": "target-a\n" }, "fix: target a");

    const failed = await integrate(f.tree, { checks: ["echo checking; exit 3"] });
    expect(failed.error?.message).toContain("git_integrate failed at checks");
    expect(failed.error?.message).toContain("exited 3");
    expect(failed.error?.message).toContain("checking");
    expect(remoteRef(f)).toBe(targetSha);
    // 브랜치는 대상 위로 rebase된 채 남고 진행 상태는 없다.
    expect(git(f.tree, ["rev-parse", "HEAD~1"])).toBe(targetSha);
    expect(existsSync(stateFile(f))).toBe(false);

    const dirtied = await integrate(f.tree, { checks: ["echo extra >> b.txt"] });
    expect(dirtied.error?.message).toContain("git_integrate failed at checks: tracked changes are present");
    expect(remoteRef(f)).toBe(targetSha);
  }, TIMEOUT);

  test("a target that moves between the checks and the push is fetched again, rebased and checked again", async () => {
    const f = await fixture();
    await commitIn(f.tree, { "b.txt": "session-b\n" }, "feat: session b");
    const first = await pushOther(f, { "a.txt": "target-a\n" }, "fix: target a");
    const script = join(f.root, "move-target.sh");
    const runs = join(f.root, "runs.log");
    // 첫 검사 도중 다른 세션이 main에 커밋을 올린다.
    await writeFile(script, [
      "set -e",
      `echo run >> ${JSON.stringify(runs)}`,
      `if [ ! -f ${JSON.stringify(`${runs}.moved`)} ]; then`,
      `  touch ${JSON.stringify(`${runs}.moved`)}`,
      `  cd ${JSON.stringify(f.other)} && git pull -q --ff-only && echo c > c.txt && git add c.txt && git commit -q -m 'fix: concurrent' && git push -q origin main`,
      "fi",
    ].join("\n"));

    const { output, error } = await integrate(f.tree, { checks: [`bash ${script}`] });
    expect(error).toBeUndefined();
    const concurrent = git(f.other, ["rev-parse", "HEAD"]);
    expect(concurrent).not.toBe(first);
    expect(output?.details).toMatchObject({ ok: true, stage: "complete", moves: 1, commitSha: remoteRef(f) });
    expect(git(f.tree, ["rev-parse", "HEAD~1"])).toBe(concurrent);
    expect(isAncestor(f, concurrent, remoteRef(f))).toBe(true);
    expect((await readFile(runs, "utf8")).trim().split("\n")).toHaveLength(2);
  }, TIMEOUT);

  test("a source manifest conflict is regenerated from the merged tracked content", async () => {
    const helper = [
      "const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');",
      "const [command, dir, runtime, flag, output] = process.argv.slice(2);",
      "if (command !== 'create-manifest' || flag !== '--output') process.exit(2);",
      "const files = {};",
      "const walk = (abs, rel) => { for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {",
      "  const name = rel ? rel + '/' + entry.name : entry.name;",
      "  if (entry.name === '.git' || name === 'Tools/CUELO_Setup/files/source-integrity.json') continue;",
      "  const full = path.join(abs, entry.name);",
      "  if (entry.isDirectory()) walk(full, name); else files[name] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');",
      "} };",
      "walk(path.resolve(dir), '');",
      "fs.writeFileSync(output, JSON.stringify({ runtime: JSON.parse(fs.readFileSync(runtime, 'utf8')).version, files }) + '\\n');",
    ].join("\n");
    const manifest = "Tools/CUELO_Setup/files/source-integrity.json";
    const f = await fixture({
      "Tools/CUELO_Setup/files/source-build-helper.js": `${helper}\n`,
      "Tools/CUELO_Setup/files/runtime-integrity.json": "{\"version\":\"1.0.0\"}\n",
      [manifest]: "{\"by\":\"base\"}\n",
    });
    await commitIn(f.tree, { "x.txt": "session-x\n", [manifest]: "{\"by\":\"session\"}\n" }, "feat: session x");
    await pushOther(f, { "y.txt": "target-y\n", [manifest]: "{\"by\":\"target\"}\n" }, "fix: target y");
    await writeFile(join(f.tree, "scratch.txt"), "untracked\n");

    const { output, error } = await integrate(f.tree, { checks: [] });
    expect(error).toBeUndefined();
    expect(output?.details).toMatchObject({ ok: true, stage: "complete" });
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const published = JSON.parse(remoteFile(f, manifest));
    expect(published.runtime).toBe("1.0.0");
    expect(published.files).toMatchObject({ "x.txt": sha("session-x\n"), "y.txt": sha("target-y\n"), "a.txt": sha("base-a\n") });
    expect(published.files["scratch.txt"]).toBeUndefined();
    expect(published.files[manifest]).toBeUndefined();
    expect(git(f.tree, ["status", "--porcelain"])).toBe("?? scratch.txt");
  }, TIMEOUT);

  test("a resolved code conflict must pass the git_finalize review gate before the rebase continues", async () => {
    // 푼 내용이 주석만 다르면 게이트가 검토를 요구하지 않으므로 세 판의 코드 자체를 다르게 둔다.
    const wipe = (retries: number) => `import { rmSync } from "node:fs";\nexport const wipe = (path: string) => rmSync(path, { recursive: true, maxRetries: ${retries} });\n`;
    const f = await fixture({ "wipe.ts": "export const wipe = (_path: string) => undefined;\n" });
    await commitIn(f.tree, { "wipe.ts": wipe(1) }, "feat: session wipe");
    const targetSha = await pushOther(f, { "wipe.ts": wipe(2) }, "fix: target wipe");
    expect((await integrate(f.tree, { checks: [] })).output?.details.stage).toBe("conflict");
    await writeFile(join(f.tree, "wipe.ts"), wipe(3));
    // 세션(편집기)이 먼저 stage해 충돌 목록과 작업 트리 변경에서 사라져도 게이트를 지나지 못한다.
    git(f.tree, ["add", "wipe.ts"]);

    const refused = await integrate(f.tree, { action: "continue" });
    expect(refused.error?.message).toContain("git_integrate failed at cross-review");
    expect(rebasing(f)).toBe(true);
    expect(remoteRef(f)).toBe(targetSha);

    const ledger = process.env.OMP_CROSS_REVIEW_LEDGER!;
    const store = createRoutingLedger(ledger);
    const deps = {
      cwd: f.tree, sessionId: "integrate-test", mainModel: "anthropic/claude-opus-5-5", exec: spawnExec(),
      readAll: () => readCrossReviewRecords(ledger), append: (record: Parameters<typeof store.append>[0]) => store.append(record),
      snapshotRoot: join(ledgers, "snapshots"),
      complete: async () => ({ model: "openai-codex/gpt-6-astra", text: "{\"findings\":[]}" }),
    };
    const review = await runReview({ files: ["wipe.ts"], acceptance: "keeps both wipes", authors: ["main"] }, deps, new AbortController().signal);
    expect((await runResolve({ reviewId: review.reviewId, resolutions: [] }, deps)).pass).toBe(true);

    const passed = await integrate(f.tree, { action: "continue" });
    expect(passed.error).toBeUndefined();
    expect(passed.output?.details.stage).toBe("complete");
    expect(remoteFile(f, "wipe.ts")).toBe(wipe(3).trim());
  }, TIMEOUT);

  test("continue refuses staged markers of the repository's marker size, also with the apply rebase backend configured", async () => {
    const f = await fixture({ ".gitattributes": "a.txt conflict-marker-size=10\n" });
    git(f.work, ["config", "rebase.backend", "apply"]);
    await commitIn(f.tree, { "a.txt": "session-a\n" }, "feat: session");
    await pushOther(f, { "a.txt": "target-a\n" }, "fix: target");
    expect((await integrate(f.tree, { checks: [] })).output?.details.stage).toBe("conflict");
    expect(await readFile(join(f.tree, "a.txt"), "utf8")).toContain("<<<<<<<<<< ");
    git(f.tree, ["add", "a.txt"]);
    expect((await integrate(f.tree, { action: "continue" })).error?.message).toContain("conflict markers remain in: a.txt");
    await writeFile(join(f.tree, "a.txt"), "target-a\nsession-a\n");
    const done = await integrate(f.tree, { action: "continue" });
    expect(done.error).toBeUndefined();
    expect(done.output?.details.stage).toBe("complete");
    expect(remoteFile(f, "a.txt")).toBe("target-a\nsession-a");
  }, TIMEOUT);

  test("the session branch's remote copy follows only its own upstream and only when HEAD is the rebased tip", async () => {
    const f = await fixture();
    const base = git(f.tree, ["rev-parse", "HEAD"]);
    await commitIn(f.tree, { "b.txt": "session-b\n" }, "feat: session b");
    git(f.tree, ["push", "-q", "-u", "origin", "wt/x"]);
    const published = remoteRef(f, "refs/heads/wt/x");
    await pushOther(f, { "a.txt": "target-a\n" }, "fix: target a");
    // 실패한 검사가 HEAD를 옮겼으면 원격 사본을 그 HEAD로 바꾸지 않는다.
    const script = join(f.root, "detach.sh");
    await writeFile(script, `git checkout -q --detach ${base}\nexit 1\n`);
    const failed = await integrate(f.tree, { checks: [`bash ${script}`] });
    expect(failed.error?.message).toContain("git_integrate failed at checks");
    expect(failed.error?.message).toContain("the remote copy was left unchanged");
    expect(remoteRef(f, "refs/heads/wt/x")).toBe(published);
    git(f.tree, ["checkout", "-q", "wt/x"]);
    // 다른(공용) 브랜치를 따라가는 세션 브랜치는 그 브랜치를 움직이지 않는다.
    git(f.other, ["push", "-q", "origin", `${base}:refs/heads/develop`]);
    git(f.tree, ["config", "branch.wt/x.merge", "refs/heads/develop"]);
    const done = await integrate(f.tree, { checks: [] });
    expect(done.output?.details).toMatchObject({ ok: true, stage: "complete" });
    expect(done.output?.details.branchSync).toContain("not its own refs/heads/wt/x");
    expect(remoteRef(f, "refs/heads/develop")).toBe(base);
  }, TIMEOUT);

  test("abort after a conflict in a re-rebase returns to the head from before start", async () => {
    const f = await fixture();
    const origHead = await commitIn(f.tree, { "a.txt": "session-a\n" }, "feat: session a");
    await pushOther(f, { "b.txt": "target-b\n" }, "fix: target b");
    const script = join(f.root, "conflicting-move.sh");
    const marker = JSON.stringify(`${script}.done`);
    // 첫 rebase는 깨끗하고, 첫 검사 도중 다른 세션이 같은 줄을 고쳐 두 번째 rebase가 충돌한다.
    await writeFile(script, [
      `if [ ! -f ${marker} ]; then`,
      `  touch ${marker}`,
      `  cd ${JSON.stringify(f.other)} && git pull -q --ff-only && echo target-a > a.txt && git commit -q -am 'fix: target a' && git push -q origin main`,
      "fi",
    ].join("\n"));
    const stopped = await integrate(f.tree, { checks: [`bash ${script}`] });
    expect(stopped.output?.details).toMatchObject({ ok: false, stage: "conflict" });
    expect(git(f.tree, ["rev-parse", "ORIG_HEAD"])).not.toBe(origHead);
    const aborted = await integrate(f.tree, { action: "abort" });
    expect(aborted.error).toBeUndefined();
    expect(aborted.output?.details).toMatchObject({ stage: "aborted", head: origHead });
    expect(git(f.tree, ["rev-parse", "HEAD"])).toBe(origHead);
    expect(git(f.tree, ["status", "--porcelain"])).toBe("");
    expect(existsSync(stateFile(f))).toBe(false);
  }, TIMEOUT);

  test("refuses the main checkout, detached HEAD, the target branch, tracked changes, missing checks and guarded check commands", async () => {
    const f = await fixture();
    expect((await integrate(f.work, { checks: [] })).error?.message).toContain("main checkout");
    expect((await integrate(f.tree, {})).error?.message).toContain("checks is required");
    expect((await integrate(f.tree, { checks: ["git push origin main"] })).error?.message).toContain("refused by the command guard");
    await writeFile(join(f.tree, "a.txt"), "dirty\n");
    expect((await integrate(f.tree, { checks: [] })).error?.message).toContain("tracked changes are present");
    git(f.tree, ["checkout", "-q", "--", "a.txt"]);
    expect((await integrate(f.tree, { checks: [], target: "wt/x" })).error?.message).toContain("is on the target branch wt/x");
    git(f.tree, ["checkout", "-q", "--detach"]);
    expect((await integrate(f.tree, { checks: [] })).error?.message).toContain("HEAD is detached");
    expect(remoteRef(f)).toBe(git(f.work, ["rev-parse", "HEAD"]));
  }, TIMEOUT);
});

describe("integrate lock", () => {
  test("is the git_finalize mutex: a held lock makes finalizer.ps1 and git_integrate wait until it is released", async () => {
    const f = await fixture();
    await commitIn(f.tree, { "b.txt": "session-b\n" }, "feat: session b");
    // worktree에서 잡은 잠금과 main checkout의 finalizer.ps1이 같은 이름을 쓴다(공용 git dir + remote + ref).
    const held = await holdLock(f.tree);
    expect(held.reply.locked).toBe(true);
    await writeFile(join(f.work, "f.txt"), "finalized\n");
    const request = join(f.root, "request.json");
    await writeFile(request, JSON.stringify({ cwd: f.work, files: ["f.txt"], message: "docs: finalized" }));
    const finalizer = Bun.spawn({ cmd: [powerShell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", finalizerScript, "-Request", request], cwd: f.work, stdout: "pipe", stderr: "pipe" });
    expect(await settledWithin(finalizer.exited, 4000)).toBe(false);
    expect(await held.release()).toBe(0);
    expect(await finalizer.exited).toBe(0);
    const finalized = remoteRef(f);

    const again = await holdLock(f.work);
    expect(again.reply.locked).toBe(true);
    const integrating = integrate(f.tree, { checks: [] });
    expect(await settledWithin(integrating, 4000)).toBe(false);
    await again.release();
    const { output, error } = await integrating;
    expect(error).toBeUndefined();
    expect(output?.details).toMatchObject({ ok: true, stage: "complete" });
    expect(isAncestor(f, finalized, remoteRef(f))).toBe(true);
  }, TIMEOUT);

  test("releases when its parent dies or the hold limit passes", async () => {
    const f = await fixture();
    // 부모(도구 프로세스 역할)가 SIGKILL로 죽으면 보유자의 표준 입력이 닫혀 잠금이 풀린다.
    const parent = join(f.root, "parent.mjs");
    await writeFile(parent, [
      "import { spawn } from 'node:child_process';",
      `spawn(${JSON.stringify(powerShell)}, ['-NoProfile', '-File', ${JSON.stringify(lockScript)}, '-Repository', ${JSON.stringify(f.tree)}, '-Remote', 'origin', '-UpstreamRef', 'refs/heads/main', '-MaxHoldSeconds', '100'], { stdio: ['pipe', 'inherit', 'inherit'] });`,
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const host = Bun.spawn({ cmd: ["bun", parent], stdout: "pipe", stderr: "pipe" });
    const { value } = await host.stdout.getReader().read();
    expect(JSON.parse(new TextDecoder().decode(value).split("\n")[0]).locked).toBe(true);
    host.kill("SIGKILL");
    await host.exited;
    const started = performance.now();
    const next = await holdLock(f.tree, { wait: 20 });
    expect(next.reply.locked).toBe(true);
    expect(performance.now() - started).toBeLessThan(15_000);
    await next.release();

    // 입력이 닫히지 않아도 상한이 지나면 놓고 종료 코드 3으로 끝난다.
    const stuck = await holdLock(f.tree, { maxHold: 2 });
    expect(stuck.reply.locked).toBe(true);
    expect(await stuck.child.exited).toBe(3);
    const after = await holdLock(f.tree, { wait: 5 });
    expect(after.reply.locked).toBe(true);
    await after.release();
  }, TIMEOUT);
});
