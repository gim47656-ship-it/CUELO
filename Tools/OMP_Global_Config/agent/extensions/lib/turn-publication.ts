import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { boundary, localPath, targets, within, type Boundary, type Result } from "./turn-documents";
import { readGuardField } from "../command-guard/task-guard";

// Main 세션의 게시(commit+push) 누락 관측. 근거는 성공한 edit·write·draft 결과, task 발주 영수증과 async-result 정산,
// git_finalize 영수증(input.files와 details.ok/stage)뿐이다. Git을 실행해 바꾸지 않고, 더러운 파일 전체를 소유로 보지 않는다.
// 2026-11-11: 0.10.132(71cd4152)에서 기본 commit/push 규칙 문장이 빠진 뒤 로컬 완료로 끝나는 턴이 늘었다.
const GIT = "커밋|푸시|푸쉬|깃|commit|push|git";
// 보류·해제 낱말은 Git 낱말에 조사만 사이에 두고 바로 붙어야 한다. "커밋하고 배포는 보류해", "커밋 후 릴리스는 보류해"의 보류는 Git 몫이 아니다.
const PARTICLE = "(?:은|는|을|를|도|만|이나|까지|좀|과|와|랑)?\\s*";
// 영어는 문장·절 첫머리의 명령만 본다("The README says please commit"은 해제가 아니다).
const CLAUSE = "(?:^|[.!?,;:]\\s*|\\b(?:and|but|then|so)\\s+)(?:please\\s+)?";
const HOLD = new RegExp(`(?:${GIT})${PARTICLE}(?:하지\\s*마|하지\\s*말|말고|말아|보류|금지|멈춰|중단|기다려|나중에|없이|내가\\s*(?:할|직접|하))`
  + `|${CLAUSE}(?:do\\s*n['’]?t|do not|never|no|hold(?:\\s+off)?(?:\\s+on)?|skip)\\s+(?:the\\s+|any\\s+)?(?:git\\s+)?(?:commit|push)`, "im");
// 해제는 명령형과 목적어가 절 끝까지 이어져야 한다. "Commit messages should…", "Commit and push are separate…"는 해제가 아니다. 놓친 해제는 보류를 유지할 뿐이다.
const RELEASE = new RegExp(`(?:${GIT})${PARTICLE}(?:해\\s*(?:줘|주세요|라)|해도\\s*(?:돼|된다|좋아|괜찮)|하자|해\\s*$|진행\\s*(?:해|하자))`
  + `|${CLAUSE}(?:go ahead and\\s+|now\\s+)?(?:commit|push)(?:\\s+(?:it|this|that|them|everything|all|the changes|the fix|the work))?`
  + `(?:\\s+and\\s+push(?:\\s+(?:it|them|everything))?)?(?:\\s+now)?\\s*[.!]?\\s*$`, "im");
// 따옴표 안의 문구는 사용자가 인용하거나 시킨 말이라 보류나 해제가 아니다. 영어 축약형의 '는 따옴표로 보지 않는다.
const QUOTED = /"[^"\n]*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`|(?<![A-Za-z])'[^'\n]*'(?![A-Za-z])/g;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const SHOWN = 5;

/** TASK_GUARD 블록(표식 줄부터 첫 빈 줄까지)의 WORK_CLASS·OWNED_PATHS. 산문에서 소유를 추정하지 않는다. */
function guard(task: string): { workClass?: string; owned: string[] } {
  const marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(task);
  if (!marker) return { owned: [] };
  const tail = task.slice(marker.index + marker[0].length);
  const block = tail.slice(0, /\r?\n\s*\r?\n/.exec(tail)?.index ?? tail.length);
  return {
    workClass: readGuardField(block, "WORK_CLASS")?.toLowerCase(),
    owned: (readGuardField(block, "OWNED_PATHS") ?? "").split(",").map((path) => path.trim()).filter(Boolean),
  };
}

/**
 * 게시할 차이가 남은 파일만 돌려준다. 만들었다 지운 draft 초안이나 HEAD 내용으로 되돌린 파일은 올릴 것이 없다
 * (11-18 사무실, 11-21 집: 지운 초안 파일이 안내에 실려 사용자가 그 파일을 올려 달라고 다시 물었다).
 * 저장소마다 read-only `git status`와 upstream에서 갈라진 뒤 로컬에서 바뀐 트리로 판정한다. 판정할 수 없는 저장소(upstream 없음 등)의
 * 파일과 시간 한도를 넘겨 판정하지 못한 파일은 모두 남긴다.
 */
function pendingOnly(base: string, files: string[]): string[] {
  // --literal-pathspecs: 파일 이름을 pathspec 문법(`:(exclude)`, 글롭)으로 읽지 않는다.
  const run = (cwd: string, args: string[]) => spawnSync("git", ["--no-optional-locks", "--literal-pathspecs", ...args], { cwd, encoding: "utf8", timeout: 5_000 });
  const ok = (result: SpawnSyncReturns<string>) => result.status === 0 && !result.error;
  const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
  // 턴 끝을 오래 붙잡지 않는다. 한도를 넘기면 남은 파일은 판정하지 않고 남긴다.
  const deadline = Date.now() + 10_000;
  const roots = new Map<string, string | undefined>();
  const groups = new Map<string, string[]>();
  const keep = new Set<string>();
  for (const file of files) {
    // 초안과 함께 지운 폴더에서는 Git을 시작할 수 없어 남아 있는 가장 가까운 상위 디렉터리에서 저장소를 찾는다.
    let dir = dirname(join(base, file));
    while (!isDirectory(dir) && dirname(dir) !== dir) dir = dirname(dir);
    if (!roots.has(dir)) {
      if (Date.now() > deadline) { keep.add(file); continue; }
      const top = run(dir, ["rev-parse", "--show-toplevel"]);
      let root: string | undefined;
      try { root = ok(top) ? realpathSync(top.stdout.replace(/\n$/, "")) : undefined; } catch { root = undefined; }
      roots.set(dir, root);
    }
    const root = roots.get(dir);
    if (!root) { keep.add(file); continue; }
    groups.set(root, [...groups.get(root) ?? [], file]);
  }
  for (const [root, group] of groups) {
    if (Date.now() > deadline) { for (const file of group) keep.add(file); continue; }
    const paths = group.map((file) => relative(root, join(base, file)).split(sep).join("/"));
    const status = run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...paths]);
    // merge base부터 HEAD까지의 트리 비교라 병합 커밋에서만 바뀐 내용도 빠지지 않는다.
    const unpushed = run(root, ["diff", "--name-only", "-z", "--no-renames", "@{upstream}...HEAD", "--", ...paths]);
    if (!ok(status) || !ok(unpushed) || Date.now() > deadline) { for (const file of group) keep.add(file); continue; }
    const pending = new Set([
      ...status.stdout.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3)),
      ...unpushed.stdout.split("\0").filter(Boolean),
    ]);
    group.forEach((file, index) => { if (pending.has(paths[index]!)) keep.add(file); });
  }
  return files.filter((file) => keep.has(file));
}

// 게시 관례 근거: 저장소 루트의 지침 문서 한 문단이 commit과 push 마감을 함께 적었거나(push를 금지하는 절이 있으면 제외), 이 사용자의 신원으로 쓴 커밋이 이미 원격 추적 ref에 있다.
// 문서 문구 판독은 휴리스틱이다. 놓치면 기본 게시 안내만 생략되고(명시 게시 요청은 그대로 된다) 틀리게 읽으면 기존 안내가 나올 뿐이다.
const CONVENTION_DOCS = ["AGENTS.md", "CLAUDE.md", "HANDOFF.md"];
const COMMIT_WORD = /git_finalize|커밋|commit/i;
const PUSH_WORD = /git_finalize|푸시|푸쉬|push|기본\s*게시/i;
// push를 금지하는 문구: 부정어 뒤 몇 낱말 안에 push가 오거나, push 뒤에 금지 표현이 온다. 줄바꿈은 공백으로 보고 판정한다.
const NEGATED_PUSH = /\b(?:never|don['’]?t|do not|must not|cannot|not allowed to|forbidden to|prohibit\w*|no\s+(?:push|pushes|pushing))\b\W*(?:\w+\W+){0,3}?(?:push|푸시|푸쉬|git_finalize)|(?:금지|하지\s*마|하지\s*말)\W+(?:\w+\W+){0,3}?(?:push|푸시|푸쉬|git_finalize)|(?:push|푸시|푸쉬)\S*\s*(?:is |are |was )?(?:forbidden|prohibited|not allowed|not permitted|금지|하지\s*마|하지\s*말|하지\s*않)|\bno\s+push(?:es|ing)?\b/i;
/** 주소 비교 키: 도메인은 대소문자를 구분하지 않고, 앞부분은 그대로 둔다. */
const addressKey = (email: string) => { const text = email.trim(); const at = text.lastIndexOf("@"); return at < 0 ? text : `${text.slice(0, at)}@${text.slice(at + 1).toLowerCase()}`; };
type PublishScope = "yes" | "no-remote" | "no-convention" | "unknown";
const conventionStated = (text: string) => text.split(/\n\s*\n/).some((paragraph) => COMMIT_WORD.test(paragraph) && PUSH_WORD.test(paragraph)
  && !NEGATED_PUSH.test(paragraph.replace(/\s+/g, " ")));
const HISTORY_LIMIT = 500;

/** 선언 범위 경로가 속한 디렉터리(디렉터리면 그 자신). */
function ownerDir(base: string, path: string): string {
  const abs = join(base, path.replace(/\/+$/, ""));
  try { return statSync(abs).isDirectory() ? abs : dirname(abs); } catch { return dirname(abs); }
}

/** 이 저장소가 기본 게시 대상인가. git 실패와 신원 없음은 모두 unknown이며 없다는 근거로 쓰지 않는다. 원격 조회 없이 로컬 설정과 추적 ref만 읽는다. known은 저장소 루트별 결과 캐시다. */
function publishScope(base: string, known: Map<string, PublishScope>): PublishScope {
  const run = (args: string[]) => spawnSync("git", ["--no-optional-locks", ...args], { cwd: base, encoding: "utf8", timeout: 5_000 });
  const failed = (result: SpawnSyncReturns<string>) => result.status !== 0 || !!result.error;
  const top = run(["rev-parse", "--show-toplevel"]);
  if (failed(top)) return "unknown";
  const root = top.stdout.endsWith("\n") ? top.stdout.slice(0, -1) : top.stdout;
  const cached = known.get(root);
  if (cached) return cached;
  const scope = ((): PublishScope => {
    const remotes = run(["remote"]);
    if (failed(remotes)) return "unknown";
    if (!remotes.stdout.trim()) return "no-remote";
    for (const name of CONVENTION_DOCS) {
      // O_NONBLOCK: 이름 있는 파이프로 바뀌어도 읽기가 쓰는 쪽을 기다리지 않는다. 열고 나서 fstat으로 일반 파일만 읽는다.
      let fd: number | undefined;
      try {
        fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NONBLOCK);
        if (fstatSync(fd).isFile() && conventionStated(readFileSync(fd, "utf8"))) return "yes";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown"; // 읽지 못한 문서는 없다는 근거가 아니다
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    const identity = run(["config", "user.email"]);
    const who = failed(identity) ? "" : addressKey(identity.stdout);
    if (!who) return "unknown";
    const prior = run(["log", "--remotes", "--format=%ae", "-n", String(HISTORY_LIMIT + 1)]);
    if (failed(prior)) return "unknown";
    const emails = prior.stdout.split("\n").filter(Boolean);
    if (emails.some((email) => addressKey(email) === who)) return "yes";
    return emails.length > HISTORY_LIMIT ? "unknown" : "no-convention";
  })();
  known.set(root, scope);
  return scope;
}

export function createTurnPublication() {
  /** Main이 바꿨고 push까지 끝난 git_finalize가 아직 덮지 않은 절대 경로. */
  const changed = new Set<string>();
  /** 실행 중인 구현 Maker: child id → OWNED_PATHS. */
  const running = new Map<string, string[]>();
  /** 완료한 구현 Maker: child id → OWNED_PATHS. 게시 여부는 note 때 선언 범위의 read-only git status와 upstream 대비 로컬 커밋으로만 판단한다. */
  const handoffs = new Map<string, string[]>();
  /** wt/<주제> 브랜치 upstream에만 push됐고 git_integrate 완료 영수증이 아직 없는 절대 경로. */
  const branchOnly = new Set<string>();
  const pending = new Map<string, { paths: string[]; editedLater: Set<string> }>();
  let failedStage: string | undefined;
  let hold = false;
  let noticed = false;
  /** 사용자가 직접 게시(commit·push)를 요청한 입력이 마지막 사용자 입력일 때만 참이다. */
  let explicit = false;
  const finish = (paths: string[], details: Record<string, unknown>, editedLater?: Set<string>) => {
    for (const path of paths) {
      if (!editedLater?.has(path)) changed.delete(path);
      if (typeof details.upstreamRef === "string" && details.upstreamRef.startsWith("refs/heads/wt/")) branchOnly.add(path);
    }
    failedStage = undefined;
  };
  const settleFinalize = (job: Record<string, unknown>) => {
    const id = typeof job.jobId === "string" ? job.jobId : job.id;
    if (typeof id !== "string") return;
    const receipt = pending.get(id);
    if (!receipt || !["completed", "failed", "cancelled"].includes(String(job.status))) return;
    pending.delete(id);
    const details = record(job.toolResultDetails);
    if (job.status === "completed" && details.ok === true && details.stage === "complete" && typeof details.commitSha === "string") {
      finish(receipt.paths, details, receipt.editedLater);
    } else {
      const by = record(details.refused).by;
      failedStage = `git_finalize ${id} ${job.status === "completed" && typeof by === "string" ? `refused by ${by}` : job.status}`;
    }
    noticed = false;
  };
  return {
    reset() { changed.clear(); running.clear(); handoffs.clear(); branchOnly.clear(); pending.clear(); failedStage = undefined; hold = false; noticed = false; explicit = false; },
    /** 사용자 직접 입력·조향만 넘긴다. Git 보류는 해제 전까지 유지하고, 해제는 안내를 다시 연다. */
    user(text: string) {
      const own = text.replace(QUOTED, " ");
      if (HOLD.test(own)) { hold = true; explicit = false; }
      else if (RELEASE.test(own)) { hold = false; noticed = false; explicit = true; }
      else explicit = false;
    },
    observe(event: Result, cwd: string | undefined) {
      if (!cwd) return;
      let base: string;
      try { base = realpathSync(cwd); } catch { return; }
      const input = record(event.input), details = record(event.details);
      const by = record(details.refused).by;
      const refused = !event.isError && typeof by === "string";
      const pushed = !event.isError && details.ok === true && details.stage === "complete" && typeof details.commitSha === "string";
      if (event.toolName === "git_finalize") {
        const files = Array.isArray(input.files) ? input.files.filter((file): file is string => typeof file === "string") : [];
        const paths = files.map(file => localPath(file, base, false)).filter((path): path is string => !!path);
        if (!event.isError && details.stage === "pending" && typeof details.jobId === "string") {
          pending.set(details.jobId, { paths, editedLater: new Set() });
          noticed = false;
        } else if (pushed) {
          finish(paths, details);
        } else {
          failedStage = `git_finalize ${refused ? `refused by ${by}` : typeof details.stage === "string" ? details.stage : "error"}`;
          noticed = false;
        }
        return;
      }
      if (event.toolName === "wait" || ((event.toolName === "write" || event.toolName === "read") &&
        typeof input.path === "string" && input.path.startsWith("proc://"))) {
        const rows = event.toolName === "wait" ? details.jobs : record(details.proc).jobs;
        if (Array.isArray(rows)) for (const job of rows) settleFinalize(record(job));
      }
      if (event.toolName === "git_integrate") {
        // complete만 세션 브랜치 전체를 대상에 push한 영수증이다. up-to-date·aborted·충돌 안내는 완료로 보지 않는다.
        if (pushed) { branchOnly.clear(); failedStage = undefined; }
        else if (refused) {
          failedStage = `git_integrate refused by ${by}`;
          noticed = false;
        } else if (event.isError) { failedStage = "git_integrate error"; noticed = false; }
        return;
      }
      if (event.toolName === "task") {
        const items: unknown[] = Array.isArray(input.tasks) ? input.tasks : typeof input.task === "string" ? [input] : [];
        const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
        const progress = rows(details.progress), results = rows(details.results);
        for (const [index, raw] of items.entries()) {
          const item = record(raw);
          const agent = typeof item.agent === "string" && item.agent.trim() ? item.agent.trim().toLowerCase() : "maker";
          const { workClass, owned } = guard(typeof item.task === "string" ? item.task : "");
          if (agent !== "maker" || workClass?.startsWith("diag") || owned.length === 0) continue;
          const at = (row: Record<string, unknown>, position: number) => (typeof row.index === "number" ? row.index : position) === index;
          const inline = results.find(at);
          if (inline && typeof inline.id === "string") {
            if (inline.exitCode === 0 && inline.aborted !== true && inline.error === undefined) { handoffs.set(inline.id, owned); noticed = false; }
            continue;
          }
          const id = progress.find(at)?.id;
          if (!event.isError && typeof id === "string" && id) running.set(id, owned);
        }
        return;
      }
      if (event.isError || refused || details.scriptError === true) return;
      const paths = event.toolName === "draft"
        ? [details.savedPath].filter((path): path is string => typeof path === "string")
        : event.toolName === "write" || event.toolName === "edit" ? targets(event) : [];
      const memo = new Map<string, Boundary>();
      for (const target of paths) {
        const path = localPath(target, base, false);
        if (!path || !within(base, path) || !boundary(dirname(path), memo).git) continue;
        if (relative(base, path).split(sep).includes(".git")) continue;
        changed.add(path);
        for (const receipt of pending.values()) if (receipt.paths.includes(path)) receipt.editedLater.add(path);
        noticed = false;
      }
    },
    /** async-result details.jobs[]: task job의 agentId(없으면 jobId)가 발주 영수증의 child id와 같을 때만 정산한다. */
    settle(details: unknown) {
      const jobs = record(details).jobs;
      if (!Array.isArray(jobs)) return;
      for (const job of jobs.map(record)) {
        settleFinalize(job);
        if (job.type !== undefined && job.type !== "task") continue;
        const id = typeof job.agentId === "string" ? job.agentId : typeof job.jobId === "string" ? job.jobId : undefined;
        const owned = id ? running.get(id) : undefined;
        if (!id || !owned || job.status === "running" || job.status === "pending") continue;
        running.delete(id);
        if (job.status === "completed") { handoffs.set(id, owned); noticed = false; }
      }
    },
    note(cwd: string | undefined, snapshot?: (options: { recentLimit: number }) => { running: readonly unknown[]; recent: readonly unknown[] } | null): string | undefined {
      let missingReceipt = false;
      if (pending.size && snapshot) {
        const state = snapshot({ recentLimit: Number.POSITIVE_INFINITY });
        if (state) {
          // Recent rows are newest first. Apply terminal receipts oldest first so an
          // older failure cannot overwrite the latest publication outcome.
          for (let i = state.recent.length - 1; i >= 0; i--) settleFinalize(record(state.recent[i]));
          missingReceipt = [...pending.keys()].some(id => !state.running.some(row => record(row).id === id));
        }
      }
      if (hold || noticed || !cwd) return undefined;
      if (pending.size) {
        noticed = true;
        if (missingReceipt) return `git_finalize ${[...pending.keys()].join(", ")}: no terminal receipt yet. Do not assume success or retry; check the job result.`;
        return `git_finalize ${[...pending.keys()].join(", ")} is still running. You can answer the user now; do not report a push or repeat the call before its result.`;
      }
      let base: string;
      try { base = realpathSync(cwd); } catch { return undefined; }
      const shown = (paths: string[]) => `${paths.slice(0, SHOWN).join(", ")}${paths.length > SHOWN ? ` 외 ${paths.length - SHOWN}개` : ""}`;
      const parts: string[] = [];
      const scopes = new Map<string, boolean>();
      const repoScopes = new Map<string, PublishScope>();
      /** 저장소(dir)가 기본 게시 대상이 아니라고 확인됐는가. 명시 게시 요청과 unknown은 닫지 않는다. */
      const closed = (dir: string) => {
        if (explicit) return false;
        let value = scopes.get(dir);
        if (value === undefined) { const scope = publishScope(dir, repoScopes); value = scope === "no-remote" || scope === "no-convention"; scopes.set(dir, value); }
        return value;
      };
      let files = [...changed].map((path) => relative(base, path).split(sep).join("/"));
      if (files.length) {
        // gitignore 대상은 게시할 파일이 아니다. 판정할 수 없으면(exit 128 등) 모두 남긴다. 추적 중인 파일은 무시 대상으로 나오지 않는다.
        const ignored = spawnSync("git", ["--no-optional-locks", "check-ignore", "-z", "--stdin"], { cwd: base, input: files.join("\0"), encoding: "utf8", timeout: 5_000 });
        if (ignored.status === 0 && !ignored.error) {
          const skip = new Set(ignored.stdout.split("\0").filter(Boolean));
          files = files.filter((file) => !skip.has(file));
        }
      }
      if (files.length) files = pendingOnly(base, files).filter((file) => !closed(dirname(join(base, file))));
      if (files.length) parts.push(`이번 세션에서 성공한 edit, write, draft로 바뀐 파일 ${files.length}개가 push까지 끝난 git_finalize 영수증(input.files)에 없다: ${shown(files)}`);
      for (const [id, owned] of handoffs) {
        if (owned.every((path) => closed(ownerDir(base, path)))) continue;
        // 선언 범위만 읽는다. --no-optional-locks: 다른 agent의 index.lock과 겹치지 않는다.
        const status = spawnSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...owned], { cwd: base, encoding: "utf8", timeout: 5_000 });
        if (status.status !== 0 || status.error) {
          parts.push(`완료한 구현 Maker ${id}(OWNED_PATHS ${owned.join(",")})의 게시 여부를 확인하지 못했다(read-only git status 실패). receipt를 직접 확인하라`);
          continue;
        }
        const dirty = status.stdout.split("\0").filter((entry) => /^.. ./.test(entry)).map((entry) => entry.slice(3));
        if (!dirty.length) {
          // 작업 트리가 깨끗해도 로컬 커밋만 되고 push되지 않았을 수 있다. 원격 조회 없이 로컬 upstream ref와만 비교한다.
          const local = spawnSync("git", ["--no-optional-locks", "log", "--format=%h", "@{upstream}..HEAD", "--", ...owned], { cwd: base, encoding: "utf8", timeout: 5_000 });
          const unpushed = local.stdout?.split("\n").filter(Boolean) ?? [];
          if (local.status !== 0 || local.error) {
            parts.push(`완료한 구현 Maker ${id}(OWNED_PATHS ${owned.join(",")})의 선언 범위는 깨끗하지만 upstream과 비교하지 못해 push 여부를 모른다. receipt와 git_finalize 결과를 직접 확인하라`);
          } else if (unpushed.length) {
            parts.push(`완료한 구현 Maker ${id}(OWNED_PATHS ${owned.join(",")})의 선언 범위를 바꾼 로컬 커밋 ${unpushed.length}개가 upstream에 없다(${shown(unpushed)})`);
          } else handoffs.delete(id);
          continue;
        }
        parts.push(`완료한 구현 Maker ${id}(OWNED_PATHS ${owned.join(",")})의 선언 범위에 커밋되지 않은 변경 ${dirty.length}개가 남아 있다: ${shown(dirty)}. 다른 writer 몫이 섞였을 수 있으니 receipt와 대조하라`);
      }
      const branch = [...branchOnly].filter((path) => !closed(dirname(path))).map((path) => relative(base, path).split(sep).join("/"));
      if (branch.length) parts.push(`wt 세션 브랜치 upstream에만 push됐고 git_integrate 완료 영수증이 없는 파일 ${branch.length}개가 있다: ${shown(branch)}`);
      // 2026-11-22 사용자 결정(게시 범위 좁히기): 원격이 없거나 게시 관례 근거가 없는 저장소의 변경은 기본 게시로 재촉하지 않는다(작업 트리에 두고 보고).
      // 위 판정은 파일이 속한 저장소마다 한다. 사용자가 직접 게시를 요청했으면 보지 않고, 확인하지 못한 상태는 없다는 근거가 아니므로 기존대로 안내한다.
      // 이미 실패한 게시 호출 보고는 그대로 둔다.
      if (failedStage) parts.push(`마지막 게시 호출이 push까지 끝나지 않았다(${failedStage})`);
      if (!parts.length) return undefined;
      noticed = true;
      return `게시 확인: ${parts.join(". ")}. 검증과 기록을 마쳤고 사용자의 Git 보류가 없다면 Main이 정확한 소유 파일과 기록으로 git_finalize(commit과 push)를 실행하라. 배포나 장비 확인 대기만으로는 Git 보류가 아니다. 소유가 불분명한 파일은 확인 없이 넣지 마라. git_finalize가 실패했다면 같은 호출을 반복하지 말고 원인과 남은 차단을 보고하라. 이 안내는 관측 근거일 뿐 소유권, 승인, 자동 커밋이 아니다.`;
    },
  };
}
