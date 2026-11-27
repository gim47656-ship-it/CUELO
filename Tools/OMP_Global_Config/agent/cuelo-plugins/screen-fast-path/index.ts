import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowingFailure, asksCoordinates, blockReason, displayProblem, imageQuestion, SYSTEM_BLOCK, type FindFailure } from "./policy";
import { ensureReady, realSetupDeps, runProcess, type Ready, type Run } from "./setup";

// 다른 앱 창 조작을 빠른 경로로 돌린다(2026-11-15 실측: AnyDesk 원격 명령 하나에 원격 vision 좌표 찾기 8회 61초,
// 로컬 OCR은 화면 전체 약 1초). lab_screen_find 도구, 좌표를 vision에 묻는 이미지 read 차단, 짧은 경로 안내.

const SCRIPT = join(import.meta.dir, "screen_find.py");
const MAX_LINES = 150;
export const EVENTS_FILE = "cuelo-screen-fast-path-events.jsonl";
const GUIDE_TYPE = "screen-fast-path-guide";
const SCREEN_REQUEST = /\b(?:AnyDesk|WinBoat|RDP|VNC|remote desktop|screen(?:shot)?|lab_screen_find|AT-SPI|click (?:the|on)|press the .*? button)\b|화면|스크린샷|원격\s*데스크톱|윈도우\s*창|클릭해|눌러\s*줘/i;
const COMPUTER_CALL = /\bcomputer\s*(?:\.|\[)/;
const IMAGE_READ = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif)(?:$|\?)/i;

// 이 안내가 아직 모델 문맥에 있으면 true다. 압축이나 /clear(reset_boundary) 앞은 문맥에서 빠졌으므로 거기서 멈춘다.
// requestOnly면 이번 요청(마지막 user 메시지 뒤)만 본다. 요청 시작 때는 문맥 전체를 봐서, 같은 안내를 다시 넣지 않는다
// (2026-11-28 야간: 사무실 7일 41건 중 5건이 압축 뒤 이미 들어간 같은 안내였다).
function hasGuide(manager: ExtensionContext["sessionManager"], requestOnly: boolean): boolean {
  for (let entry = manager.getLeafEntry(); entry; entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined) {
    if (entry.type === "compaction" || entry.type === "reset_boundary") return false;
    if (entry.type === "custom_message" && entry.customType === GUIDE_TYPE && entry.content === SYSTEM_BLOCK) return true;
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "user" && requestOnly) return false;
    if (message.role === "developer" && Array.isArray(message.content)
      && message.content.some((part) => part.type === "text" && part.text.includes(SYSTEM_BLOCK))) return true;
  }
  return false;
}

type Log = (record: Record<string, unknown>) => void;

const defaultLog: Log = (record) => {
  try {
    // 설치된 플러그인 폴더(cuelo-plugins/<id>)에서 두 단계 위가 에이전트 폴더다. 정식 폴더는 프로필 동기화가 덮는다.
    appendFileSync(join(import.meta.dir, "..", "..", EVENTS_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // 기록 실패는 동작을 막지 않는다.
  }
};

export interface ScreenFastPathOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** OCR 실행 환경 준비. 기본은 ~/.omp 아래 실제 설치·다운로드다. */
  prepare?: (signal?: AbortSignal) => Promise<Ready>;
  /** screen_find.py 실행. 테스트가 바꿔 끼운다. */
  find?: (ready: Ready, args: string[], signal?: AbortSignal) => Promise<Run>;
  log?: Log;
}

interface Params {
  window?: string;
  png?: string;
  find?: string;
  click?: string;
  nth?: number;
}

export function createScreenFastPath(options: ScreenFastPathOptions = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const log = options.log ?? defaultLog;
  const runFind = options.find ?? ((ready: Ready, args: string[], signal?: AbortSignal) =>
    runProcess(ready.python, [SCRIPT, "--models", ready.modelsDir, ...args], { env: env as NodeJS.ProcessEnv, timeoutMs: 120_000, signal }));

  return function screenFastPath(pi: ExtensionAPI): void {
    const z = pi.zod;
    const failures = new Map<string, FindFailure[]>();
    let preparing: Promise<Ready> | undefined;
    const sessionOf = (ctx: ExtensionContext | undefined) => ctx?.sessionManager?.getSessionId?.() ?? "";
    const recordFailure = (ctx: ExtensionContext | undefined, failure: FindFailure) => {
      const session = sessionOf(ctx);
      failures.set(session, [...(failures.get(session) ?? []), failure]);
    };

    pi.on("before_agent_start", ({ reason, prompt }, ctx) => {
      if (reason !== "prompt" || !SCREEN_REQUEST.test(prompt) || hasGuide(ctx.sessionManager, false)) return;
      return { message: { customType: GUIDE_TYPE, content: SYSTEM_BLOCK, display: false, attribution: "agent" } };
    });

    pi.on("tool_result", ({ toolName, input }, ctx) => {
      const screenWork = toolName === "lab_screen_find"
        || (toolName === "read" && typeof input.path === "string" && IMAGE_READ.test(input.path.trim()))
        || (toolName === "eval" && typeof input.code === "string" && COMPUTER_CALL.test(input.code));
      if (!screenWork || hasGuide(ctx.sessionManager, true)) return;
      return { additionalContext: SYSTEM_BLOCK };
    });

    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "read") return;
      const input: unknown = event.input;
      const question = imageQuestion(input && typeof input === "object" && "path" in input ? input.path : undefined);
      if (!question || !asksCoordinates(question.question)) return;
      const allowed = allowingFailure(failures.get(sessionOf(ctx)) ?? [], question);
      if (allowed) {
        log({ event: "allowed", target: question.target, question: question.question.slice(0, 200), after: allowed });
        return { additionalContext: `screen-fast-path: lab_screen_find가 이 대상에서 실패해(${JSON.stringify(allowed)}) 좌표 질문을 허용했다.` };
      }
      log({ event: "blocked", target: question.target, question: question.question.slice(0, 200) });
      return { block: true, reason: blockReason(question) };
    });

    pi.registerTool({
      name: "lab_screen_find",
      label: "Screen find (local OCR)",
      loadMode: "essential",
      description:
        "Local Korean/English OCR for pixel-only windows; optional XTEST click brings target forward and restores mouse. window: title regex (largest match; default screen); png: existing image, no click. find/click: case-insensitive substring, spaces ignored; nth: 1-based match. Returns x y score text (screen coordinates, image pixels for png). Narrow find/click to avoid private text. First use installs OCR dependencies/model under ~/.omp. X11 required except png.",
      parameters: z.object({
        window: z.string().optional().describe("Window title regex; default whole screen"),
        png: z.string().optional().describe("Existing image to OCR instead of capturing; no click"),
        find: z.string().optional().describe("Only boxes containing this text"),
        click: z.string().optional().describe("Click the box containing this text"),
        nth: z.number().int().min(1).optional().describe("Which match to click, 1-based (default 1)"),
      }),
      async execute(_callId, rawParams, signal, _onUpdate, ctx) {
        const params = rawParams as Params;
        const target: FindFailure = {
          ...(params.window ? { window: params.window } : {}),
          ...(params.click ?? params.find ? { find: params.click ?? params.find } : {}),
          ...(params.png ? { png: params.png } : {}),
        };
        const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
        if (platform !== "linux") {
          recordFailure(ctx, { ...target, environment: true });
          return reply(`lab_screen_find: 이 PC(${platform})는 지원하지 않는다. 화면 캡처, XTEST 클릭, OCR 실행 환경 준비가 모두 Linux 기준이다.`);
        }
        if (params.png && params.click) return reply("lab_screen_find: png 좌표는 이미지 픽셀이라 click과 함께 쓸 수 없다. 화면에서 누르려면 window를 준다.");
        if (!params.png) {
          const problem = displayProblem(env);
          if (problem) {
            recordFailure(ctx, { ...target, environment: true });
            return reply(`lab_screen_find: ${problem}`);
          }
        }
        let ready: Ready;
        try {
          // 준비는 같은 프로세스의 호출이 함께 기다리므로 첫 호출자의 중단 신호에 묶지 않는다.
          preparing ??= (options.prepare ?? (() => ensureReady(realSetupDeps())))();
          ready = await preparing;
        } catch (error) {
          preparing = undefined;
          recordFailure(ctx, { ...target, environment: true });
          log({ event: "setup-failed", error: error instanceof Error ? error.message : String(error) });
          return reply(`lab_screen_find: OCR 실행 환경 준비에 실패했다. ${error instanceof Error ? error.message : String(error)}`);
        }
        // `--name=value`로 넘겨 `-`로 시작하는 글자도 옵션으로 읽히지 않게 한다.
        const args: string[] = [];
        if (params.window) args.push(`--window=${params.window}`);
        if (params.png) args.push(`--png=${params.png}`);
        if (params.click) args.push(`--click=${params.click}`, `--nth=${params.nth ?? 1}`);
        else if (params.find) args.push(`--find=${params.find}`);
        // 캡처는 이 폴더에 두고 여기서 지운다. 파이썬이 시간 초과(SIGKILL)로 죽어도 화면 사진이 남지 않는다.
        const scratch = params.png ? undefined : await mkdtemp(join(tmpdir(), "screen-find-"));
        if (scratch) args.push(`--tmpdir=${scratch}`);
        const started = Date.now();
        let run: Run;
        try {
          run = await runFind(ready, args, signal);
        } finally {
          if (scratch) await rm(scratch, { recursive: true, force: true });
        }
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const prepared = ready.steps.length ? `\n(처음 사용 준비: ${ready.steps.join(", ")})` : "";
        ready.steps = [];
        const lines = run.stdout.trim().split("\n").filter(Boolean);
        if (run.code !== 0) {
          recordFailure(ctx, target);
          const why = run.code === 3 ? "결과 없음" : "실패";
          const narrowed = Boolean(target.window || target.find || target.png);
          return reply([
            `lab_screen_find: ${why} (${seconds}s). ${run.stderr.trim().slice(-400)}`,
            ...lines.slice(0, MAX_LINES),
            narrowed
              ? "이 대상의 좌표는 이제 `read <이미지>?q=` 질문으로도 물을 수 있다."
              : "대상을 좁히지 않은 실패라 좌표 질문은 열리지 않는다. window나 find로 대상을 정해 다시 찾는다.",
          ].join("\n") + prepared);
        }
        const shown = lines.slice(0, MAX_LINES);
        const more = lines.length > shown.length ? `\n… ${lines.length - shown.length}개 더 있음. find로 좁힌다.` : "";
        const privacy = params.find || params.click ? "" : "\n(화면의 모든 글자가 담길 수 있다. 다음에는 find나 click으로 좁힌다.)";
        const boxes = lines.filter((line) => !line.startsWith("clicked ")).length;
        return reply(`lab_screen_find: ${boxes}개 (${seconds}s, x y score text)\n${shown.join("\n")}${more}${privacy}${prepared}`);
      },
    });
  };
}

export default createScreenFastPath();
