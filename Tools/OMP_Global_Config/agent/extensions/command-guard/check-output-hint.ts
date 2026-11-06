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

/** Advisory only: a check and an output filter share a shell call, so verify whose status was recorded. */
export function checkOutputHint(command: string): string | undefined {
  const calls = invokedCommandLines(command);
  let check = false;
  let filter = false;
  for (const { word, args } of calls) {
    const name = word.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.exe$/i, "").toLowerCase() ?? "";
    filter ||= Object.hasOwn(FILTERS, name);
    if (args.includes("--help") || args.includes("--version")) continue;
    const target = Object.hasOwn(RUNNERS, name) ? runnerTarget(args, name) : undefined;
    check ||= Object.hasOwn(TOOLS, name)
      || (name === "node" && args.includes("--test"))
      || (Object.hasOwn(RUNNERS, name) && target !== undefined && (CHECKS.test(target) || Object.hasOwn(TOOLS, target)));
  }
  if (!check || !filter) return undefined;
  return "[검사 종료 코드] 검사와 출력 가공 명령을 함께 실행했다. 셸 종료 코드가 출력 가공 명령의 결과일 수 있으므로 검사 자체의 종료 코드가 보존됐는지 확인한다. 이미 보존된 결과가 있으면 재실행하지 않는다. 결과를 확정할 근거가 없을 때만 검사 명령을 직접 실행하고 긴 출력은 artifact로 읽는다. 이 안내는 실패 판정이 아니며 명령과 결과를 바꾸지 않는다.";
}
