import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnExec } from "../../extensions/lib/cross-review";
import { publicationNote } from "./index";

// 실제 git 저장소에 커밋을 만들고, 그 커밋이 공개 미러에 닿는지에 따른 git_finalize 결과 안내를 본다.
const roots: string[] = [];
const exec = spawnExec();

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

async function commit(root: string, message: string): Promise<string> {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function mirroredRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-publication-note-"));
  roots.push(root);
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  await put(root, ".publicignore", "doc/\nHANDOFF.md\nprivate-manifest.json\n");
  await put(root, ".github/workflows/publish-public.yml", "on: push\n");
  await put(root, "src/app.ts", "export {};\n");
  await put(root, "doc/record.md", "# record\n");
  await put(root, "HANDOFF.md", "# handoff\n");
  await put(root, "private-manifest.json", "{}\n");
  await commit(root, "initial");
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("publicationNote", () => {
  test("비공개 파일만 바꾼 커밋은 게시·공개 CI를 기다리지 말라고 알린다", async () => {
    const root = await mirroredRepository();
    await put(root, "private-manifest.json", '{"v":2}\n');
    await put(root, "HANDOFF.md", "# handoff 2\n");
    const sha = await commit(root, "private only");
    expect(await publicationNote(root, sha, false, exec)).toContain("비공개 파일만 바꿨다");
  });

  test("공개 파일이 바뀐 커밋은 공개 미러 CI 하나만 기다리라고 알린다", async () => {
    const root = await mirroredRepository();
    await put(root, "src/app.ts", "export const x = 1;\n");
    await put(root, "doc/record.md", "# record 2\n");
    const sha = await commit(root, "public change");
    const note = await publicationNote(root, sha, false, exec);
    expect(note).toContain("공개 파일 1개");
    expect(note).toContain("공개 미러 CI");
  });

  test("비공개 파일을 지운 커밋은 비공개로, 게시 기준 파일을 바꾼 커밋은 공개로 본다", async () => {
    const root = await mirroredRepository();
    git(root, ["rm", "-q", "doc/record.md"]);
    const removed = await commit(root, "remove private");
    expect(await publicationNote(root, removed, false, exec)).toContain("비공개 파일만 바꿨다");

    await put(root, ".publicignore", "doc/\nHANDOFF.md\nprivate-manifest.json\n.publicignore\n");
    const rules = await commit(root, "change publication rules");
    expect(await publicationNote(root, rules, false, exec)).toContain("공개 파일 1개");
  });

  test("판정은 작업 폴더가 아니라 push한 커밋의 규칙을 따른다", async () => {
    const root = await mirroredRepository();
    await put(root, "HANDOFF.md", "# handoff 2\n");
    const sha = await commit(root, "private");
    await put(root, ".publicignore", "");
    expect(await publicationNote(root, sha, false, exec)).toContain("비공개 파일만 바꿨다");
  });

  test("부모 커밋 조회가 실패하면 판정 안내를 붙이지 않는다", async () => {
    const root = await mirroredRepository();
    git(root, ["rm", "-q", "doc/record.md"]);
    const sha = await commit(root, "remove private");
    const failingLineage: typeof exec = (command, args, options) =>
      args.includes("rev-list") ? Promise.resolve({ code: 128, stdout: "", stderr: "lookup failed" }) : exec(command, args, options);
    expect(await publicationNote(root, sha, false, failingLineage)).toBeUndefined();
  });

  test("미전송 커밋을 함께 보낸 경우는 이 커밋만으로 판정하지 않는다", async () => {
    const root = await mirroredRepository();
    await put(root, "HANDOFF.md", "# handoff 3\n");
    const sha = await commit(root, "private");
    expect(await publicationNote(root, sha, true, exec)).toContain("판정하지 않았다");
  });

  test("공개 미러가 없는 저장소에는 안내를 붙이지 않는다", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-publication-note-"));
    roots.push(root);
    git(root, ["init", "-q", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    await put(root, "a.txt", "a\n");
    const sha = await commit(root, "plain");
    expect(await publicationNote(root, sha, false, exec)).toBeUndefined();
  });
});
