import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Exec } from "../../extensions/lib/cross-review";

/**
 * git_finalize 앞단: 작업 사본이 원격보다 "뒤처지기만" 했을 때(로컬 HEAD가 원격의 조상, 로컬 커밋 없음) 원격 커밋을
 * fast-forward로 받는다. 사용자 결정(2026-11-05): 다른 세션이 올린 커밋 때문에 커밋이 멈추고 사람에게 "받아도 되냐"고
 * 묻던 일을 없앤다. 역사를 다시 쓰지 않으므로 rebase·HEAD reset·merge commit은 하지 않는다.
 *
 * - 갈라진 경우, stage된 변경, 원격 브랜치 없음, 분리된 HEAD는 아무것도 바꾸지 않고 안내만 돌려준다. 그 뒤 판정(멈춤)은
 *   finalizer.ps1이 그대로 한다. index는 읽기만 한다(`--no-optional-locks`).
 * - 원격 커밋이 고친 파일과 로컬의 커밋 안 한 수정이 겹치면 작업 트리 바이트 공간에서 3-way 병합한다: 로컬은 원래 바이트
 *   (`hash-object --no-filters`, 이것이 객체 백업이다), 기준판·원격판은 이 작업 사본에 놓일 바이트(`cat-file --filters`).
 *   `merge-file --object-id`가 충돌 없이 끝날 때만 진행하므로 합친 결과도 줄바꿈·인코딩 바이트가 그대로다.
 *   새 파일·삭제가 겹치면 건드리지 않고, 무시 파일은 `--no-overwrite-ignore`로 git이 덮어쓰기를 거절한다.
 * - 작업 사본 쓰기는 모두 Node가 바이트로 하고, 받은 뒤에는 파일 바이트로 판정한다: 원격판이면 병합 결과, 기준판이면
 *   (받지 못했다) 원래 바이트, 그 밖이면 누가 고친 것이라 건드리지 않는다. git 조회·파일 쓰기가 실패해도 파일마다 따로
 *   되돌리며, 깨끗하게 끝나지 않으면(받는 도중 다른 쪽이 새로 저장한 파일 포함) 원래 바이트를 복사한 임시 폴더와 백업 객체를 알린다.
 * - `commitExec`는 작업 사본을 바꾸는 fast-forward에 쓴다. 호출부가 취소 신호 없는 실행기를 주면 취소가 그 단계를 반쯤
 *   끊지 않는다(조회·fetch는 `exec`로 취소된다). `readBytes`는 바이트 그대로의 출력이 필요한 git 호출이다.
 */
export interface UpstreamSync {
  /** 받은 원격 커밋 수. 0이면 아무것도 바꾸지 않았다. */
  pulled: number;
  /** 3-way로 합친 로컬 수정 파일(저장소 상대 경로). */
  merged: string[];
  /** 사용자·Main에게 보일 한 줄 안내. 받지 않은 이유도 여기에 담는다. */
  note?: string;
}

export type ReadBytes = (git: string, args: string[], cwd: string) => Promise<Buffer>;

interface Plan { path: string; abs: string; raw: Buffer; rawOid: string; base: Buffer; theirs: Buffer; merged: Buffer }

const SHA = /^[0-9a-f]{40,64}$/;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 문자열로 풀지 않고 stdout 바이트를 그대로 받는다(cp949·CRLF 보존). */
export const spawnBytes: ReadBytes = async (git, args, cwd) => {
  const child = Bun.spawn([git, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return Buffer.from(stdout);
};

export async function syncBehindUpstream(exec: Exec, git: string, root: string, commitExec: Exec = exec, readBytes: ReadBytes = spawnBytes): Promise<UpstreamSync> {
  const run = (args: string[], stdin?: Buffer) => exec(git, args, { cwd: root, ...(stdin ? { stdin } : {}) });
  const out = async (args: string[], stdin?: Buffer) => {
    const result = await run(args, stdin);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim();
  };
  const skip = (note: string): UpstreamSync => ({ pulled: 0, merged: [], note });

  // finalizer.ps1의 remote·upstream 선택과 같은 기준.
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (!branch || branch === "HEAD") return skip("분리된 HEAD라 원격 커밋을 확인하지 않았다.");
  const config = async (key: string) => { const r = await run(["config", "--get", key]); return r.code === 0 ? r.stdout.trim() : ""; };
  const remotes = (await run(["remote"])).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const configured = await config(`branch.${branch}.remote`);
  const remote = configured && configured !== "." ? configured : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "";
  if (!remote || !remotes.includes(remote)) return skip("push할 원격을 정하지 못해 원격 커밋을 확인하지 않았다.");
  const upstreamRef = (await config(`branch.${branch}.merge`)) || `refs/heads/${branch}`;
  if (!upstreamRef.startsWith("refs/heads/")) return skip(`지원하지 않는 upstream(${upstreamRef})이라 원격 커밋을 확인하지 않았다.`);
  if ((await run(["ls-remote", "--exit-code", "--refs", remote, upstreamRef])).code !== 0) {
    return skip(`원격에 ${upstreamRef}가 아직 없어 받을 커밋이 없다.`);
  }

  await out(["fetch", "--no-tags", remote, upstreamRef]);
  const upstream = await out(["rev-parse", "FETCH_HEAD"]);
  const head = await out(["rev-parse", "HEAD"]);
  if (!SHA.test(upstream) || !SHA.test(head) || upstream === head) return { pulled: 0, merged: [] };
  if ((await run(["merge-base", "--is-ancestor", upstream, head])).code === 0) return { pulled: 0, merged: [] }; // 앞서 있다.
  if ((await run(["merge-base", "--is-ancestor", head, upstream])).code !== 0) {
    return skip("작업 사본이 원격과 갈라져(로컬에만 있는 커밋이 있다) 자동으로 받지 않았다.");
  }
  if ((await run(["diff", "--cached", "--quiet"])).code !== 0) return skip("stage된 변경이 있어 원격 커밋을 자동으로 받지 않았다.");

  const pulled = Number(await out(["rev-list", "--count", `${head}..${upstream}`]));
  const split = (text: string) => text.split("\0").filter(Boolean);
  const incoming = new Set(split((await run(["-c", "core.quotepath=false", "diff", "--no-renames", "--name-only", "-z", head, upstream])).stdout));
  // `--no-optional-locks`: 거절하고 끝나는 경우에도 index의 stat 갱신을 쓰지 않는다. porcelain -z 한 항목은 "XY path".
  const entries = split((await run(["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"])).stdout);
  const overlap = entries.map((entry) => ({ path: entry.slice(3), untracked: entry.startsWith("??"), deleted: entry[1] === "D" }))
    .filter((file) => incoming.has(file.path));
  const blocked = overlap.filter((file) => file.untracked || file.deleted).map((file) => file.path);
  if (blocked.length) return skip(`원격 커밋 ${pulled}개가 로컬의 새 파일·삭제와 겹쳐 자동으로 받지 않았다: ${blocked.join(", ")}`);

  // 겹치는 파일을 작업 트리 바이트 공간에서 미리 병합한다. 충돌이 하나라도 있으면 작업 사본을 건드리지 않는다.
  const plans: Plan[] = [];
  const conflicts: string[] = [];
  for (const { path } of overlap) {
    if ((await run(["cat-file", "-e", `${upstream}:${path}`])).code !== 0) { conflicts.push(`${path}(원격에서 삭제)`); continue; }
    const abs = join(root, path);
    const raw = readFileSync(abs);
    // 확인한 바로 그 바이트를 객체로 남기고 병합한다(경로를 다시 읽으면 그 사이 바뀐 내용이 들어갈 수 있다).
    const rawOid = await out(["hash-object", "-w", "--no-filters", "--stdin"], raw);
    const base = await readBytes(git, ["cat-file", "--filters", `--path=${path}`, `${head}:${path}`], root);
    const theirs = await readBytes(git, ["cat-file", "--filters", `--path=${path}`, `${upstream}:${path}`], root);
    const baseOid = await out(["hash-object", "-w", "--no-filters", "--stdin"], base);
    const theirsOid = await out(["hash-object", "-w", "--no-filters", "--stdin"], theirs);
    const merge = await run(["merge-file", "--object-id", rawOid, baseOid, theirsOid]);
    const mergedOid = merge.stdout.trim();
    if (merge.code !== 0 || !SHA.test(mergedOid)) { conflicts.push(path); continue; }
    const merged = await readBytes(git, ["cat-file", "blob", mergedOid], root);
    plans.push({ path, abs, raw, rawOid, base, theirs, merged });
  }
  if (conflicts.length) return skip(`원격 커밋 ${pulled}개가 로컬 수정과 충돌해 자동으로 받지 않았다: ${conflicts.join(", ")}. 작업 사본은 그대로다.`);

  // 원래 바이트 복사(객체 백업과 별도). 깨끗하게 끝나지 않으면 이 폴더를 남겨 되살릴 수 있게 한다.
  const backupDir = plans.length ? mkdtempSync(join(tmpdir(), "git-finalize-sync-")) : "";
  for (const plan of plans) {
    mkdirSync(dirname(join(backupDir, plan.path)), { recursive: true });
    writeFileSync(join(backupDir, plan.path), plan.raw);
  }
  const dropBackup = () => { if (backupDir) rmSync(backupDir, { recursive: true, force: true }); };
  const recovery = () => `겹친 파일의 원래 내용: ${backupDir} (백업 객체 ${plans.map((plan) => `${plan.path}=${plan.rawOid}`).join(", ")})`;
  // 준비하는 동안 파일이 또 바뀌었으면(편집기·다른 작업) 그 수정을 덮지 않도록 손대기 전에 멈춘다.
  const changed = plans.filter((plan) => !readFileSync(plan.abs).equals(plan.raw)).map((plan) => plan.path);
  if (changed.length) {
    dropBackup();
    return skip(`병합을 준비하는 동안 ${changed.join(", ")}가 다시 바뀌어 원격 커밋을 받지 않았다. 작업 사본은 그대로다.`);
  }

  // 파일 바이트로 상태를 판정해 한 파일씩 마무리한다: 원격판 → 병합 결과(받았을 때만), 기준판 → 원래 바이트, 그 밖 → 건드리지 않는다.
  // 받지 못했으면(HEAD가 원격이 아니거나 확인 실패) 기준판을 쓰다 잘린 내용(기준판의 앞부분)도 원래 바이트로 되돌린다.
  // 그 밖의 바이트(받지 못했는데 원격판과 같은 내용 포함)는 받는 도중 편집기·다른 작업이 저장한 것이라 건드리지 않고 백업을 남긴다.
  const touched = new Set<string>();
  const settle = (received: boolean) => {
    const result = { merged: 0, restored: 0, untouched: [] as string[], errors: [] as string[] };
    for (const plan of plans) {
      try {
        const current = readFileSync(plan.abs);
        if (received && current.equals(plan.theirs)) { writeFileSync(plan.abs, plan.merged); result.merged++; }
        else if (current.equals(plan.base) || current.equals(plan.raw)
          || (!received && touched.has(plan.path) && current.length < plan.base.length && plan.base.subarray(0, current.length).equals(current))) {
          if (!current.equals(plan.raw)) writeFileSync(plan.abs, plan.raw);
          result.restored++;
        }
        else result.untouched.push(plan.path);
      } catch (error) {
        result.errors.push(`${plan.path}: ${message(error)}`);
      }
    }
    return result;
  };

  // 겹친 파일을 기준판으로 돌려놓아야 fast-forward가 진행된다. 확인과 쓰기 사이에 await가 없다.
  let ffError: string | undefined;
  try {
    for (const plan of plans) { touched.add(plan.path); writeFileSync(plan.abs, plan.base); }
    const ff = await commitExec(git, ["merge", "--ff-only", "--no-overwrite-ignore", upstream], { cwd: root });
    if (ff.code !== 0) ffError = (ff.stderr || ff.stdout).trim();
  } catch (error) {
    ffError = message(error);
  }
  const now = await commitExec(git, ["rev-parse", "HEAD"], { cwd: root }).then((r) => r.code === 0 ? r.stdout.trim() : "", () => "");
  const settled = settle(now === upstream);
  const paths = plans.map((plan) => plan.path);
  if (now === upstream && settled.merged === plans.length) {
    dropBackup();
    const mergedNote = paths.length ? ` 양쪽이 고친 ${paths.join(", ")}는 충돌 없이 합쳤다.` : "";
    return { pulled, merged: paths, note: `작업 사본이 원격보다 뒤처져 있어 원격 커밋 ${pulled}개를 fast-forward로 먼저 받았다.${mergedNote}` };
  }
  if (now === head && settled.restored === plans.length) {
    dropBackup();
    return skip(`원격 커밋 ${pulled}개를 fast-forward로 받지 못해 작업 사본을 원래대로 두었다: ${ffError ?? "알 수 없는 이유"}`);
  }
  throw new Error(`원격 커밋을 받는 도중 상태가 어긋났다(HEAD ${now || "확인 실패"}, 받기 전 ${head}, 원격 ${upstream}${ffError ? `, ${ffError}` : ""}).`
    + `${settled.untouched.length ? ` 그 사이 다시 바뀐 파일은 건드리지 않았다: ${settled.untouched.join(", ")}.` : ""}`
    + `${settled.errors.length ? ` 마무리하지 못한 파일: ${settled.errors.join("; ")}.` : ""} ${recovery()}`);
}
