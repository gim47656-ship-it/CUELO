import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, spawnExec } from "../../extensions/lib/cross-review";
import { type ReadBytes, spawnBytes, syncBehindUpstream } from "./sync-upstream";

const base = mkdtempSync(join(tmpdir(), "sync-upstream-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}
const handoff = "# HANDOFF\n\n## 연차\n- 기존 줄\n\n## 업무 화면\n- 기존 줄\n";

let counter = 0;
/** bare origin, 다른 세션 사본(other), 뒤처질 이 PC 사본(local). 둘 다 같은 첫 커밋에서 시작한다. */
function fixture(files: Record<string, string | Buffer> = {}) {
  const dir = join(base, String(counter++));
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  const other = join(dir, "other");
  const local = join(dir, "local");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, other);
  writeFileSync(join(other, "HANDOFF.md"), handoff);
  writeFileSync(join(other, "leave.ts"), "export const leave = 1;\n");
  writeFileSync(join(other, "task.ts"), "export const task = 1;\n");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(other, name), content);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "init");
  git(other, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, local);
  return { other, local };
}
function push(repo: string, changes: Record<string, string | Buffer>, message = "remote change") {
  for (const [name, content] of Object.entries(changes)) writeFileSync(join(repo, name), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  git(repo, "push", "-q", "origin", "main");
}
const sync = (root: string) => syncBehindUpstream(spawnExec(), "git", root);

describe("syncBehindUpstream", () => {
  test("뒤처지기만 했고 겹치지 않으면 원격 커밋을 받고 로컬 수정은 그대로 둔다", async () => {
    const { other, local } = fixture();
    push(other, { "leave.ts": "export const leave = 2;\n" });
    push(other, { "leave.ts": "export const leave = 3;\n" });
    writeFileSync(join(local, "task.ts"), "export const task = 2;\n");
    const result = await sync(local);
    expect(result.pulled).toBe(2);
    expect(git(local, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
    expect(readFileSync(join(local, "leave.ts"), "utf8")).toBe("export const leave = 3;\n");
    expect(readFileSync(join(local, "task.ts"), "utf8")).toBe("export const task = 2;\n");
    expect(git(local, "diff", "--cached", "--name-only")).toBe("");
  });

  test("양쪽이 다른 줄을 고친 HANDOFF는 두 쪽 줄을 모두 살려 합친다", async () => {
    const { other, local } = fixture();
    push(other, { "HANDOFF.md": handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격: 서버 설치 완료\n") });
    writeFileSync(join(local, "HANDOFF.md"), handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬: 화면 수정\n"));
    const result = await sync(local);
    expect(result.pulled).toBe(1);
    expect(result.merged).toEqual(["HANDOFF.md"]);
    const text = readFileSync(join(local, "HANDOFF.md"), "utf8");
    expect(text).toContain("- 원격: 서버 설치 완료");
    expect(text).toContain("- 로컬: 화면 수정");
    expect(git(local, "status", "--porcelain")).toBe("M HANDOFF.md");
  });

  test("같은 줄을 서로 다르게 고쳤으면 아무것도 바꾸지 않는다", async () => {
    const { other, local } = fixture();
    push(other, { "HANDOFF.md": handoff.replace("- 기존 줄\n\n## 업무", "- 원격 값\n\n## 업무") });
    const mine = handoff.replace("- 기존 줄\n\n## 업무", "- 로컬 값\n\n## 업무");
    writeFileSync(join(local, "HANDOFF.md"), mine);
    const head = git(local, "rev-parse", "HEAD");
    const result = await sync(local);
    expect(result.pulled).toBe(0);
    expect(result.note).toContain("충돌");
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "HANDOFF.md"), "utf8")).toBe(mine);
  });

  test("로컬에만 있는 커밋이 있으면(갈라짐) 받지 않는다", async () => {
    // 다른 세션 커밋과 무관하게 이 PC에서도 커밋을 하나 만든다.
    const { other, local } = fixture();
    push(other, { "leave.ts": "export const leave = 2;\n" });
    writeFileSync(join(local, "task.ts"), "export const task = 2;\n");
    git(local, "commit", "-q", "-am", "local only");
    const head = git(local, "rev-parse", "HEAD");
    const result = await sync(local);
    expect(result.pulled).toBe(0);
    expect(result.note).toContain("갈라져");
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
  });

  test("cp949·CRLF 파일을 합쳐도 바이트가 바뀌지 않는다", async () => {
    const lines = (...rows: string[]) => Buffer.from(rows.map((row) => `${row}\r\n`).join(""), "latin1");
    // 0xB0 0xA1 = cp949 '가'. latin1로 쓰면 바이트가 그대로 들어간다.
    const ga = "\xB0\xA1";
    const { other, local } = fixture({ "Form1.vb": lines(`' ${ga} top`, "a", "b", "c", "d", "e", `' ${ga} bottom`) });
    push(other, { "Form1.vb": lines(`' ${ga} top remote`, "a", "b", "c", "d", "e", `' ${ga} bottom`) });
    writeFileSync(join(local, "Form1.vb"), lines(`' ${ga} top`, "a", "b", "c", "d", "e", `' ${ga} bottom local`));
    const result = await sync(local);
    expect(result.merged).toEqual(["Form1.vb"]);
    expect(readFileSync(join(local, "Form1.vb")).equals(lines(`' ${ga} top remote`, "a", "b", "c", "d", "e", `' ${ga} bottom local`))).toBe(true);
  });

  test("이미 최신이면 아무것도 하지 않는다", async () => {
    const { local } = fixture();
    expect(await sync(local)).toEqual({ pulled: 0, merged: [] });
  });

  test("원격이 로컬의 무시 파일과 같은 이름을 더하면 덮어쓰지 않고 그대로 둔다", async () => {
    const { other, local } = fixture({ ".gitignore": "*.tmp\n" });
    git(local, "pull", "-q", "--ff-only");
    writeFileSync(join(local, "x.tmp"), "local-only");
    writeFileSync(join(other, "x.tmp"), "remote");
    git(other, "add", "-f", "x.tmp");
    git(other, "commit", "-q", "-m", "add ignored");
    git(other, "push", "-q", "origin", "main");
    const head = git(local, "rev-parse", "HEAD");
    const result = await sync(local);
    expect(result.pulled).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "x.tmp"), "utf8")).toBe("local-only");
  });

  test("받는 단계와 HEAD 조회가 모두 실패해도 겹친 파일을 원래 바이트로 되돌린다", async () => {
    const { other, local } = fixture();
    push(other, { "HANDOFF.md": handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격\n") });
    const mine = Buffer.from(handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬\n"));
    writeFileSync(join(local, "HANDOFF.md"), mine);
    const base = spawnExec();
    const throwing: Exec = async (command, args, options) => {
      if (args[0] === "merge" || args[0] === "rev-parse") throw new Error("aborted");
      return base(command, args, options);
    };
    const head = git(local, "rev-parse", "HEAD");
    const error = await syncBehindUpstream(base, "git", local, throwing).then(() => undefined, (e: Error) => e);
    expect(error?.message).toContain("원래 내용");
    rmSync(/원래 내용: (\S+)/.exec(error!.message)![1]!, { recursive: true, force: true });
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "HANDOFF.md")).equals(mine)).toBe(true);
    expect(git(local, "diff", "--cached", "--name-only")).toBe("");
  });

  test("autocrlf=input에서 줄끝을 CRLF로 바꾼 로컬 파일은 모든 줄이 달라 충돌로 보고 그대로 둔다", async () => {
    const { other, local } = fixture();
    git(local, "config", "core.autocrlf", "input");
    push(other, { "HANDOFF.md": handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격\n") });
    const mine = Buffer.from(handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬\n").replaceAll("\n", "\r\n"));
    writeFileSync(join(local, "HANDOFF.md"), mine);
    const head = git(local, "rev-parse", "HEAD");
    const result = await sync(local);
    expect(result.pulled).toBe(0);
    expect(result.note).toContain("충돌");
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "HANDOFF.md")).equals(mine)).toBe(true);
    expect(git(local, "diff", "--cached", "--name-only")).toBe("");
  });

  test("autocrlf=true에서 합친 파일은 CRLF를 그대로 유지한다", async () => {
    const { other, local } = fixture();
    git(local, "config", "core.autocrlf", "true");
    rmSync(join(local, "HANDOFF.md"));
    git(local, "checkout", "--", "HANDOFF.md");
    push(other, { "HANDOFF.md": handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격\n") });
    const crlf = (text: string) => Buffer.from(text.replaceAll("\n", "\r\n"));
    writeFileSync(join(local, "HANDOFF.md"), crlf(handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬\n")));
    const rawOid = git(local, "hash-object", "--no-filters", "--", "HANDOFF.md");
    const result = await sync(local);
    expect(result.merged).toEqual(["HANDOFF.md"]);
    const want = crlf(handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격\n").replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬\n"));
    expect(readFileSync(join(local, "HANDOFF.md")).equals(want)).toBe(true);
    // 로컬 원본(CRLF 그대로)이 객체로 남아 있다.
    expect(git(local, "cat-file", "-t", rawOid)).toBe("blob");
  });

  test("바이트를 꺼내는 동안 파일이 바뀌어도 그 수정을 덮지 않는다", async () => {
    const { other, local } = fixture();
    push(other, { "HANDOFF.md": handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격\n") });
    writeFileSync(join(local, "HANDOFF.md"), handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬\n"));
    const editing: ReadBytes = async (gitCommand, args, cwd) => {
      writeFileSync(join(local, "HANDOFF.md"), "NEW LOCAL EDIT\n");
      return spawnBytes(gitCommand, args, cwd);
    };
    const head = git(local, "rev-parse", "HEAD");
    const exec = spawnExec();
    const result = await syncBehindUpstream(exec, "git", local, exec, editing);
    expect(result.pulled).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "HANDOFF.md"), "utf8")).toBe("NEW LOCAL EDIT\n");
  });

  test("겹친 파일 둘 중 하나에 쓰기가 실패하면 먼저 쓴 파일도 원래 바이트로 되돌린다", async () => {
    const { other, local } = fixture({ "A.md": "a1\na2\na3\na4\na5\n", "B.md": "b1\nb2\nb3\nb4\nb5\n" });
    push(other, { "A.md": "a1 remote\na2\na3\na4\na5\n", "B.md": "b1 remote\nb2\nb3\nb4\nb5\n" });
    const mineA = Buffer.from("a1\na2\na3\na4\na5 local\n"), mineB = Buffer.from("b1\nb2\nb3\nb4\nb5 local\n");
    writeFileSync(join(local, "A.md"), mineA);
    writeFileSync(join(local, "B.md"), mineB);
    chmodSync(join(local, "B.md"), 0o444);
    const head = git(local, "rev-parse", "HEAD");
    const result = await sync(local);
    chmodSync(join(local, "B.md"), 0o644);
    expect(result.pulled).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "A.md")).equals(mineA)).toBe(true);
    expect(readFileSync(join(local, "B.md")).equals(mineB)).toBe(true);
  });

  test("받기가 실패하는 동안 파일이 잘린 채 남아도 원래 바이트로 되돌린다", async () => {
    const { other, local } = fixture({ "B.md": "b1\nb2\nb3\nb4\nb5\n" });
    push(other, { "B.md": "b1 remote\nb2\nb3\nb4\nb5\n" });
    const mineB = Buffer.from("b1\nb2\nb3\nb4\nb5 local\n");
    writeFileSync(join(local, "B.md"), mineB);
    const base = spawnExec();
    const truncating: Exec = async (command, args, options) => {
      if (args[0] === "merge") { writeFileSync(join(local, "B.md"), "b1\n"); throw new Error("ENOSPC"); }
      return base(command, args, options);
    };
    const head = git(local, "rev-parse", "HEAD");
    const result = await syncBehindUpstream(base, "git", local, truncating);
    expect(result.pulled).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "B.md")).equals(mineB)).toBe(true);
  });

  test("백업 객체와 병합 입력은 확인한 바이트로 만든다(그 사이 고쳤다 되돌린 내용이 끼지 않는다)", async () => {
    const { other, local } = fixture();
    push(other, { "HANDOFF.md": handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격\n") });
    const editA = handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬 A\n");
    writeFileSync(join(local, "HANDOFF.md"), editA);
    const base = spawnExec();
    const flipping: Exec = async (command, args, options) => {
      if (args[0] !== "hash-object") return base(command, args, options);
      writeFileSync(join(local, "HANDOFF.md"), handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬 B\n"));
      const result = await base(command, args, options);
      writeFileSync(join(local, "HANDOFF.md"), editA);
      return result;
    };
    const result = await syncBehindUpstream(flipping, "git", local, base);
    expect(result.merged).toEqual(["HANDOFF.md"]);
    const text = readFileSync(join(local, "HANDOFF.md"), "utf8");
    expect(text).toContain("- 로컬 A");
    expect(text).not.toContain("- 로컬 B");
  });

  test("병합을 준비하는 동안 파일이 다시 바뀌면 그 수정을 덮지 않고 멈춘다", async () => {
    const { other, local } = fixture();
    push(other, { "HANDOFF.md": handoff.replace("## 연차\n- 기존 줄\n", "## 연차\n- 기존 줄\n- 원격\n") });
    writeFileSync(join(local, "HANDOFF.md"), handoff.replace("## 업무 화면\n- 기존 줄\n", "## 업무 화면\n- 기존 줄\n- 로컬\n"));
    const base = spawnExec();
    const editing: Exec = async (command, args, options) => {
      const result = await base(command, args, options);
      if (args[0] === "merge-file") writeFileSync(join(local, "HANDOFF.md"), "NEW LOCAL EDIT\n");
      return result;
    };
    const head = git(local, "rev-parse", "HEAD");
    const result = await syncBehindUpstream(editing, "git", local);
    expect(result.pulled).toBe(0);
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(local, "HANDOFF.md"), "utf8")).toBe("NEW LOCAL EDIT\n");
  });

  test("충돌로 거절할 때 index 파일 바이트도 그대로다", async () => {
    const { other, local } = fixture();
    push(other, { "HANDOFF.md": handoff.replace("- 기존 줄\n\n## 업무", "- 원격 값\n\n## 업무") });
    writeFileSync(join(local, "HANDOFF.md"), handoff.replace("- 기존 줄\n\n## 업무", "- 로컬 값\n\n## 업무"));
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(local, "task.ts"), later, later);
    const before = readFileSync(join(local, ".git", "index"));
    const result = await sync(local);
    expect(result.note).toContain("충돌");
    expect(readFileSync(join(local, ".git", "index")).equals(before)).toBe(true);
  });

  test("분리된 HEAD와 원격 브랜치가 없는 경우에도 받지 않은 이유를 알린다", async () => {
    const detached = fixture().local;
    git(detached, "checkout", "-q", "--detach");
    expect((await sync(detached)).note).toContain("분리된 HEAD");
    const { local } = fixture();
    git(join(local, "..", "origin.git"), "update-ref", "-d", "refs/heads/main");
    expect((await sync(local)).note).toContain("아직 없어");
  });
});
