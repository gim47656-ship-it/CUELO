import { invokedCommandLines } from "./matcher";

const RUNNERS: Record<string, true> = { bun: true, npm: true, pnpm: true, yarn: true, npx: true, bunx: true };
const CHECKS = /^(?:test|tests|typecheck|lint|build|check|verify|smoke)(?::|$)/;
const TOOLS: Record<string, true> = { vitest: true, jest: true, pytest: true, tsc: true, eslint: true };
const FILTERS: Record<string, true> = { tail: true, head: true, grep: true, rg: true, tee: true };

function runnerTarget(args: string[], runner: string): string | undefined {
  let position = 0;
  while (position < args.length) {
    const arg = args[position]!;
    if (arg === "--") return args[position + 1];
    if (arg.startsWith("-")) {
      const takesValue = /^(?:--require|--import|--loader|--cwd|--prefix|-C|--dir|-p|--package|--workspace|--filter|-F|--loglevel|--env-file|--userconfig|--globalconfig|--cache|--registry|--include|--exclude|--from|--jobs|-j)$/.test(arg)
        || (arg === "-r" && runner !== "pnpm")
        || (arg === "-w" && (runner === "npm" || runner === "npx"));
      position += takesValue ? 2 : 1;
      continue;
    }
    if (/^(?:run|run-script|exec|x|dlx)$/.test(arg)) {
      position++;
      continue;
    }
    if (runner === "yarn" && arg === "workspaces" && /^(?:foreach|run)$/.test(args[position + 1] ?? "")) {
      position += 2;
      continue;
    }
    if (runner === "yarn" && arg === "workspace") {
      position += 2;
      continue;
    }
    return arg;
  }
  return undefined;
}

const PIPE_STATUS = /\$\{?PIPESTATUS\b/;
const STATUS = /\$\?|\$\{?PIPESTATUS\b/;
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true };

/** `set -o pipefail` (also `set -euo pipefail`) turns it on and `set +o pipefail` off; undefined when the call leaves it alone. */
function pipefailSetting(name: string, args: string[]): boolean | undefined {
  if (name !== "set") return undefined;
  let setting: boolean | undefined;
  args.forEach((arg, position) => {
    if (/^[-+][A-Za-z]*o$/.test(arg) && args[position + 1] === "pipefail") setting = arg.startsWith("-");
  });
  return setting;
}

/**
 * Advisory only: an output filter that runs after a check can leave its own status as the shell's, so verify whose status
 * was recorded. A filter in the check's pipeline is quiet only when a lone `set -o pipefail` ran earlier in that script or
 * the segment right after the pipeline expands `PIPESTATUS`; a nested check (`bash -c '…' | tail`) is judged the same way on
 * the outermost pipeline around it; a filter run later is quiet when the segment right after the check's pipeline (or the
 * outermost one around it) expands `$?` or `PIPESTATUS` in the same shell. Heuristic: it reads the command text, not what
 * ran, and cannot tell a single-quoted `'$?'` from an expansion.
 */
export function checkOutputHint(command: string): string | undefined {
  const lines = invokedCommandLines(command);
  const pipelineSize = new Map<string, number>();
  for (const line of lines) pipelineSize.set(line.pipeline, (pipelineSize.get(line.pipeline) ?? 0) + 1);
  const pipefail = new Map<string, boolean>();
  const script = (pipeline: string): string => pipeline.slice(0, pipeline.indexOf("."));
  const calls = lines.map(({ word, args, pipeline, after, outer }) => {
    const name = word.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.exe$/i, "").toLowerCase() ?? "";
    const setting = pipefailSetting(name, args);
    // A `set` inside a pipeline runs in a subshell and leaves the script's own option alone.
    if (setting !== undefined && pipelineSize.get(pipeline) === 1) pipefail.set(script(pipeline), setting);
    const base = {
      pipeline,
      after,
      outer,
      filter: Object.hasOwn(FILTERS, name),
      pipefail: pipefail.get(script(pipeline)) === true,
      outerPipefail: pipefail.get(script(outer.pipeline)) === true,
    };
    if (args.includes("--help") || args.includes("--version")) return { ...base, check: false };
    const target = Object.hasOwn(RUNNERS, name) ? runnerTarget(args, name) : undefined;
    const check = Object.hasOwn(TOOLS, name)
      || (name === "node" && args.includes("--test"))
      || (Object.hasOwn(RUNNERS, name) && target !== undefined && (CHECKS.test(target) || Object.hasOwn(TOOLS, target)));
    return { ...base, check };
  });
  // A child shell in the next segment (`bash -c 'echo $?'`) reads its own status, not this shell's.
  const reads = (after: readonly string[], pattern: RegExp): boolean =>
    !Object.hasOwn(SHELLS, after[0]?.split("/").at(-1) ?? "") && after.some((value) => pattern.test(value));
  const masked = calls.some((call, index) => call.check && calls.slice(index + 1).some((later) => {
    if (!later.filter) return false;
    if (later.pipeline === call.pipeline) return !call.pipefail && !reads(call.after, PIPE_STATUS);
    if (script(later.pipeline) !== script(call.pipeline) && later.outer.pipeline === call.outer.pipeline) {
      return !call.outerPipefail && !reads(call.outer.after, PIPE_STATUS);
    }
    return !reads(call.after, STATUS) && !reads(call.outer.after, STATUS);
  }));
  if (!masked) return undefined;
  return "[검사 종료 코드] 검사와 출력 가공 명령을 함께 실행했다. 셸 종료 코드가 출력 가공 명령의 결과일 수 있으므로 검사 자체의 종료 코드가 보존됐는지 확인한다. 이미 보존된 결과가 있으면 재실행하지 않는다. 결과를 확정할 근거가 없을 때만 검사 명령을 직접 실행하고 긴 출력은 artifact로 읽는다. 이 안내는 실패 판정이 아니며 명령과 결과를 바꾸지 않는다.";
}
