import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vmCopyHint } from "./hint";
import { RESULT_MARKER, runProcess, type Runner } from "./remote";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

async function repo(): Promise<{ root: string; first: string; second: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vm-hint-")));
  dirs.push(root);
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.name", "T"]);
  git(root, ["config", "user.email", "t@example.com"]);
  await writeFile(join(root, "a.txt"), "1\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "one"]);
  const first = git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "a.txt"), "2\n");
  git(root, ["commit", "-q", "-am", "two"]);
  return { root, first, second: git(root, ["rev-parse", "HEAD"]) };
}

const vmReply = (payload: object | "fail"): Runner => async (command, args, options) => {
  if (command !== "ssh") return runProcess(command, args, options);
  if (payload === "fail") return { code: 255, stdout: "", stderr: "ssh: connect timed out", killed: false };
  return { code: 0, stdout: `${RESULT_MARKER}${Buffer.from(JSON.stringify(payload)).toString("base64")}\n`, stderr: "", killed: false };
};

const config = (linux: string) => async () => ({ host: "winboat", repos: [{ linux, vm: "D:\\HANSE" }] });

describe("vmCopyHint", () => {
  test("VM 사본이 옛 리비전이면 경로, 사본 리비전, 게시 커밋, vm_build 명령을 적는다", async () => {
    const { root, first, second } = await repo();
    const line = await vmCopyHint([root], second, { run: vmReply({ head: first, snapshot: "" }), readConfig: config(root) });
    expect(line).toContain("D:\\HANSE");
    expect(line).toContain(first);
    expect(line).toContain(second);
    expect(line).toContain("뒤처졌다");
    expect(line).toContain(`vm_build --repo '${root}' --mode commit`);
  });

  test("임시 스냅샷이 남은 사본은 스냅샷이라고 밝힌다", async () => {
    const { root, first, second } = await repo();
    const line = await vmCopyHint([root], second, { run: vmReply({ head: first, snapshot: first }), readConfig: config(root) });
    expect(line).toContain("임시 스냅샷");
  });

  test("VM 사본이 게시 커밋과 같으면 이미 같다고만 적는다", async () => {
    const { root, second } = await repo();
    const line = await vmCopyHint([root], second, { run: vmReply({ head: second }), readConfig: config(root) });
    expect(line).toContain("이미");
    expect(line).not.toContain("vm_build");
  });

  test("VM에 닿지 못하면 알 수 없음과 명령을 적고 던지지 않는다", async () => {
    const { root, second } = await repo();
    const line = await vmCopyHint([root], second, { run: vmReply("fail"), readConfig: config(root) });
    expect(line).toContain("알 수 없음");
    expect(line).toContain("--mode commit");
  });

  test("셸이 풀어 쓰는 문자가 든 경로는 작은따옴표로 감싼다", async () => {
    const { root, first, second } = await repo();
    const odd = join(await mkdtemp(join(tmpdir(), "vm-hint-odd-")), "$HOME it's");
    dirs.push(join(odd, ".."));
    git(root, ["worktree", "add", "-q", odd, "-b", "odd"]);
    const line = await vmCopyHint([odd], second, { run: vmReply({ head: first }), readConfig: config(odd) });
    expect(line).toContain(`--repo '${(await realpath(odd)).replace(/'/g, "'\\''")}'`);
  });

  test("매핑된 체크아웃 HEAD가 게시한 커밋이 아니면 그 사실을 같이 적는다", async () => {
    const { root, first, second } = await repo();
    const line = await vmCopyHint([root], first, { run: vmReply({ head: first.replace(/./, "0") }), readConfig: config(root) });
    expect(line).toContain(`${root}의 HEAD가 ${second}`);
  });

  test("40자 리비전이 아닌 응답은 알 수 없음으로 센다", async () => {
    const { root, second } = await repo();
    for (const head of ["fatal: bad", 42]) {
      expect(await vmCopyHint([root], second, { run: vmReply({ head }), readConfig: config(root) })).toContain("알 수 없음");
    }
  });

  test("커밋을 모르는 사본 리비전은 관계를 판정하지 못했다고 적는다", async () => {
    const { root, second } = await repo();
    const line = await vmCopyHint([root], second, { run: vmReply({ head: "0".repeat(40) }), readConfig: config(root) });
    expect(line).toContain("판정하지 못했다");
  });

  test("매핑이 없는 저장소와 설정이 없는 PC는 줄을 만들지 않는다", async () => {
    const { root, second } = await repo();
    const other = await repo();
    expect(await vmCopyHint([root], second, { run: vmReply({ head: second }), readConfig: config(other.root) })).toBeUndefined();
    expect(await vmCopyHint([root], second, { readConfig: async () => { throw new Error("no file"); } })).toBeUndefined();
  });

  test("worktree 루트 뒤의 메인 체크아웃 후보도 매핑과 맞춘다", async () => {
    const { root, first, second } = await repo();
    const wt = await realpath(await mkdtemp(join(tmpdir(), "vm-hint-wt-")));
    dirs.push(wt);
    const line = await vmCopyHint([wt, root], second, { run: vmReply({ head: first }), readConfig: config(root) });
    expect(line).toContain(`--repo '${root}'`);
  });
});
