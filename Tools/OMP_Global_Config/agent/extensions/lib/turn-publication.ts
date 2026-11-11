import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { boundary, localPath, targets, within, type Boundary, type Result } from "./turn-documents";

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
  const field = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im").exec(block)?.[1];
  return {
    workClass: field("WORK_CLASS")?.toLowerCase(),
    owned: (field("OWNED_PATHS") ?? "").split(",").map((path) => path.trim()).filter(Boolean),
  };
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
  let failedStage: string | undefined;
  let hold = false;
  let noticed = false;
  return {
    reset() { changed.clear(); running.clear(); handoffs.clear(); branchOnly.clear(); failedStage = undefined; hold = false; noticed = false; },
    /** 사용자 직접 입력·조향만 넘긴다. Git 보류는 해제 전까지 유지하고, 해제는 안내를 다시 연다. */
    user(text: string) {
      const own = text.replace(QUOTED, " ");
      if (HOLD.test(own)) hold = true;
      else if (RELEASE.test(own)) { hold = false; noticed = false; }
    },
    observe(event: Result, cwd: string | undefined) {
      if (!cwd) return;
      let base: string;
      try { base = realpathSync(cwd); } catch { return; }
      const input = record(event.input), details = record(event.details);
      const pushed = !event.isError && details.ok === true && details.stage === "complete" && typeof details.commitSha === "string";
      if (event.toolName === "git_finalize") {
        const files = Array.isArray(input.files) ? input.files.filter((file): file is string => typeof file === "string") : [];
        if (pushed) {
          const sessionBranch = typeof details.upstreamRef === "string" && details.upstreamRef.startsWith("refs/heads/wt/");
          for (const file of files) {
            const path = localPath(file, base, false);
            if (!path) continue;
            changed.delete(path);
            // wt 브랜치 push 뒤의 다른 finalize는 통합 영수증이 아니다. branch-only 증거는 git_integrate 완료로만 지운다.
            if (sessionBranch) branchOnly.add(path);
          }
          failedStage = undefined;
        } else {
          failedStage = `git_finalize ${typeof details.stage === "string" ? details.stage : "error"}`;
          noticed = false;
        }
        return;
      }
      if (event.toolName === "git_integrate") {
        // complete만 세션 브랜치 전체를 대상에 push한 영수증이다. up-to-date·aborted·충돌 안내는 완료로 보지 않는다.
        if (pushed) { branchOnly.clear(); failedStage = undefined; }
        else if (event.isError) { failedStage = "git_integrate error"; noticed = false; }
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
      if (event.isError) return;
      const paths = event.toolName === "draft"
        ? [details.savedPath].filter((path): path is string => typeof path === "string")
        : event.toolName === "write" || event.toolName === "edit" ? targets(event) : [];
      const memo = new Map<string, Boundary>();
      for (const target of paths) {
        const path = localPath(target, base, false);
        if (!path || !within(base, path) || !boundary(dirname(path), memo).git) continue;
        if (relative(base, path).split(sep).includes(".git")) continue;
        changed.add(path);
        noticed = false;
      }
    },
    /** async-result details.jobs[]: task job의 agentId(없으면 jobId)가 발주 영수증의 child id와 같을 때만 정산한다. */
    settle(details: unknown) {
      const jobs = record(details).jobs;
      if (!Array.isArray(jobs)) return;
      for (const job of jobs.map(record)) {
        if (job.type !== undefined && job.type !== "task") continue;
        const id = typeof job.agentId === "string" ? job.agentId : typeof job.jobId === "string" ? job.jobId : undefined;
        const owned = id ? running.get(id) : undefined;
        if (!id || !owned || job.status === "running" || job.status === "pending") continue;
        running.delete(id);
        if (job.status === "completed") { handoffs.set(id, owned); noticed = false; }
      }
    },
    /** 게시할 근거가 있고 사용자 Git 보류가 없을 때 한 번만 안내문을 돌려준다. 새 근거·해제가 다시 연다. */
    note(cwd: string | undefined): string | undefined {
      if (hold || noticed || !cwd) return undefined;
      let base: string;
      try { base = realpathSync(cwd); } catch { return undefined; }
      const shown = (paths: string[]) => `${paths.slice(0, SHOWN).join(", ")}${paths.length > SHOWN ? ` 외 ${paths.length - SHOWN}개` : ""}`;
      const parts: string[] = [];
      let files = [...changed].map((path) => relative(base, path).split(sep).join("/"));
      if (files.length) {
        // gitignore 대상은 게시할 파일이 아니다. 판정할 수 없으면(exit 128 등) 모두 남긴다. 추적 중인 파일은 무시 대상으로 나오지 않는다.
        const ignored = spawnSync("git", ["--no-optional-locks", "check-ignore", "-z", "--stdin"], { cwd: base, input: files.join("\0"), encoding: "utf8", timeout: 5_000 });
        if (ignored.status === 0 && !ignored.error) {
          const skip = new Set(ignored.stdout.split("\0").filter(Boolean));
          files = files.filter((file) => !skip.has(file));
        }
      }
      if (files.length) parts.push(`이번 세션에서 성공한 edit, write, draft로 바뀐 파일 ${files.length}개가 push까지 끝난 git_finalize 영수증(input.files)에 없다: ${shown(files)}`);
      for (const [id, owned] of handoffs) {
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
      const branch = [...branchOnly].map((path) => relative(base, path).split(sep).join("/"));
      if (branch.length) parts.push(`wt 세션 브랜치 upstream에만 push됐고 git_integrate 완료 영수증이 없는 파일 ${branch.length}개가 있다: ${shown(branch)}`);
      if (failedStage) parts.push(`마지막 게시 호출이 push까지 끝나지 않았다(${failedStage})`);
      if (!parts.length) return undefined;
      noticed = true;
      return `게시 확인: ${parts.join(". ")}. 검증과 기록을 마쳤고 사용자의 Git 보류가 없다면 Main이 정확한 소유 파일과 기록으로 git_finalize(commit과 push)를 실행하라. 배포나 장비 확인 대기만으로는 Git 보류가 아니다. 소유가 불분명한 파일은 확인 없이 넣지 마라. git_finalize가 실패했다면 같은 호출을 반복하지 말고 원인과 남은 차단을 보고하라. 이 안내는 관측 근거일 뿐 소유권, 승인, 자동 커밋이 아니다.`;
    },
  };
}
