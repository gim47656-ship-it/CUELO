import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createScreenFastPath } from "../../cuelo-plugins/screen-fast-path/index";
import { allowingFailure, asksCoordinates, displayProblem } from "../../cuelo-plugins/screen-fast-path/policy";
import { ensureReady, MODEL_FILES, type Ready, type Run, type SetupDeps } from "../../cuelo-plugins/screen-fast-path/setup";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const X11 = { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" };

/** ensureReady 시험용 setup 층: 파이썬 환경만 있는 것처럼 꾸민다(실제 설치·다운로드를 하지 않는다). */
function readySetup(): SetupDeps {
  const dir = mkdtempSync(join(tmpdir(), "screen-fast-"));
  scratch.push(dir);
  mkdirSync(join(dir, "env", "bin"), { recursive: true });
  writeFileSync(join(dir, "env", "bin", "python"), "");
  return {
    pythonEnv: join(dir, "env"),
    modelsDir: join(dir, "models"),
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    download: async (url) => new TextEncoder().encode(url),
  };
}

type HookResult = { block?: boolean; reason?: string; additionalContext?: string; systemPrompt?: string[] } | undefined;
type Handler = (event: unknown, ctx?: unknown) => HookResult;
type ToolDef = { execute: (id: string, params: unknown, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> };

function harness(options: { env?: Record<string, string | undefined>; finds?: Run[]; prepare?: () => Promise<Ready>; platform?: string } = {}) {
  const handlers = new Map<string, Handler>();
  let tool: ToolDef | undefined;
  const logs: Record<string, unknown>[] = [];
  const calls: string[][] = [];
  const scratchDirs: string[] = [];
  const queue = [...(options.finds ?? [])];
  createScreenFastPath({
    env: options.env ?? X11,
    platform: options.platform ?? "linux",
    prepare: options.prepare ?? (async () => ({ python: "/fake/python", modelsDir: "/fake/models", steps: [] })),
    find: async (_ready, args) => {
      calls.push(args);
      // 파이썬이 캡처를 남긴 채 죽은 경우를 흉내 낸다: 도구가 폴더째 지워야 한다.
      const dir = args.find((arg) => arg.startsWith("--tmpdir="))?.slice("--tmpdir=".length);
      if (dir) {
        writeFileSync(join(dir, "screen-find-left.png"), "pixels");
        scratchDirs.push(dir);
      }
      return queue.shift() ?? { code: 0, stdout: "", stderr: "" };
    },
    log: (record) => logs.push(record),
  })({
    zod: z,
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerTool: (definition: ToolDef) => { tool = definition; },
  } as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getSessionId: () => "s1" } };
  return {
    logs,
    calls,
    get leftovers() { return scratchDirs.map((dir) => existsSync(dir)); },
    read: (path: string, session: unknown = ctx) => handlers.get("tool_call")!({ toolName: "read", input: { path } }, session),
    find: async (params: Record<string, unknown>, session: unknown = ctx) =>
      (await tool!.execute("c1", params, undefined, undefined, session)).content[0].text,
    beforeStart: (reason: string) => handlers.get("before_agent_start")!({ reason, systemPrompt: ["base"] }),
  };
}

describe("screen-fast-path read guard", () => {
  test("blocks image questions that ask a vision model for click coordinates", () => {
    const h = harness();
    const questions = [
      "로그인 버튼의 좌표를 알려줘", "어디를 클릭해야 해?", "'서버 시작' 버튼 클릭할 위치", "확인 버튼 위치 알려주면 누를게",
      "Give pixel coordinates of OK", "Where should I click to open it?", "return x,y of the icon",
      "Give the screen position of the OK button so I can click it",
    ];
    for (const q of questions) {
      const result = h.read(`/tmp/shot.png?q=${encodeURIComponent(q)}`);
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("lab_screen_find");
      expect(result?.reason).toContain("vm-desktop.sh");
    }
    expect(h.logs.filter((log) => log.event === "blocked")).toHaveLength(questions.length);
  });

  test("lets ocr reads, plain reads and descriptive questions through", () => {
    const h = harness();
    expect(h.read("/tmp/shot.png?ocr=화면 글자 전부")).toBeUndefined();
    expect(h.read("/tmp/shot.png")).toBeUndefined();
    expect(h.read("/tmp/shot.png?q=오류 메시지가 뭐라고 써 있어?")).toBeUndefined();
    expect(h.read("/tmp/shot.png?q=버튼들 위치가 가운데 정렬돼 있나?")).toBeUndefined();
    expect(h.read("/tmp/notes.txt?q=좌표")).toBeUndefined();
    expect(asksCoordinates("레이아웃이 깨졌는지 봐 줘")).toBe(false);
    expect(asksCoordinates("Describe the pixel art style")).toBe(false);
    expect(asksCoordinates("Is the logo position centred?")).toBe(false);
  });

  test("allows a coordinate question only for the target lab_screen_find failed on", async () => {
    const h = harness({ finds: [{ code: 3, stdout: "", stderr: "no text matches '서버 시작'" }] });
    const text = await h.find({ window: "AnyDesk", find: "서버 시작" });
    expect(text).toContain("결과 없음");
    expect(h.read("/tmp/a.png?q=서버 시작 버튼 좌표 알려줘")).toEqual({ additionalContext: expect.stringContaining("허용") });
    expect(h.logs.some((log) => log.event === "allowed")).toBe(true);
    // 다른 대상, 다른 세션은 여전히 막는다.
    expect(h.read("/tmp/a.png?q=브라우저 열기 좌표 알려줘")?.block).toBe(true);
    expect(h.read("/tmp/a.png?q=서버 시작 버튼 좌표 알려줘", { sessionManager: { getSessionId: () => "s2" } })?.block).toBe(true);
  });

  test("matches failed targets exactly: same png path, any word of a window regex, nothing for an untargeted miss", async () => {
    const h = harness({ finds: [
      { code: 3, stdout: "", stderr: "no text recognised" },
      { code: 3, stdout: "", stderr: "" },
      { code: 2, stdout: "", stderr: "no visible window" },
    ] });
    expect(await h.find({})).toContain("좌표 질문은 열리지 않는다");
    expect(h.read("/tmp/unrelated.png?q=Delete button coordinates")?.block).toBe(true);
    await h.find({ png: "/tmp/A.png" });
    expect(h.read("/tmp/A.png?q=OK coordinates")).toHaveProperty("additionalContext");
    expect(h.read("/tmp/a.png?q=OK coordinates")?.block).toBe(true);
    expect(h.read("/tmp/a b.png?q=OK coordinates")?.block).toBe(true);
    await h.find({ window: "^(AnyDesk|Remmina)$" });
    expect(h.read("/tmp/shot.png?q=AnyDesk 창의 확인 버튼 좌표")).toHaveProperty("additionalContext");
  });

  test("a successful find does not unlock coordinate questions and the capture folder is always removed", async () => {
    const h = harness({ finds: [{ code: 0, stdout: "100 200 0.98 서버 시작\n", stderr: "" }] });
    expect(await h.find({ window: "AnyDesk", find: "-서버 시작" })).toContain("100 200 0.98 서버 시작");
    const [window, find, scratch] = h.calls[0];
    expect([window, find]).toEqual(["--window=AnyDesk", "--find=-서버 시작"]);
    expect(scratch).toStartWith("--tmpdir=");
    expect(h.leftovers).toEqual([false]);
    expect(h.read("/tmp/a.png?q=서버 시작 버튼 좌표")?.block).toBe(true);
  });

  test("adds the short fast-path guide only on prompts", () => {
    const h = harness();
    expect(h.beforeStart("prompt").systemPrompt.at(-1)).toContain("lab_screen_find");
    expect(h.beforeStart("continue")).toBeUndefined();
  });
});

describe("lab_screen_find without a screen", () => {
  test("says there is no screen path on a display-less or Wayland PC and unlocks coordinate reads", async () => {
    const h = harness({ env: {} });
    expect(await h.find({ find: "확인" })).toContain("화면 조작 경로가 없다");
    expect(h.calls).toHaveLength(0);
    expect(h.read("/tmp/x.png?q=확인 버튼 좌표")).toHaveProperty("additionalContext");
    expect(displayProblem({ DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" })).toContain("Wayland");
    expect(displayProblem({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toContain("Wayland");
    expect(displayProblem({ ...X11, WAYLAND_DISPLAY: "wayland-0" })).toBeUndefined();
    expect(displayProblem(X11)).toBeUndefined();
  });

  test("refuses every mode, png included, off Linux", async () => {
    const h = harness({ platform: "win32" });
    expect(await h.find({ png: "/tmp/x.png", find: "확인" })).toContain("지원하지 않는다");
    expect(h.calls).toHaveLength(0);
  });

  test("png mode still runs without a screen and refuses click", async () => {
    const h = harness({ env: {}, finds: [{ code: 0, stdout: "5 6 0.9 확인\n", stderr: "" }] });
    expect(await h.find({ png: "/tmp/x.png", click: "확인" })).toContain("click과 함께 쓸 수 없다");
    expect(await h.find({ png: "/tmp/x.png", find: "확인" })).toContain("5 6 0.9 확인");
  });
});

describe("ensureReady", () => {
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  test("installs rapidocr when missing and keeps only models whose sha256 matches", async () => {
    const deps = readySetup();
    const ran: string[][] = [];
    deps.run = async (_command, args) => {
      ran.push(args);
      return { code: args[0] === "-c" ? 1 : 0, stdout: "", stderr: "" };
    };
    deps.download = async (url) => new TextEncoder().encode(`fake ${url}`);
    await expect(ensureReady(deps)).rejects.toThrow("sha256");
    expect(ran.some((args) => args.includes("pip"))).toBe(true);
    expect(existsSync(join(deps.modelsDir, MODEL_FILES[0].name))).toBe(false);
  });

  test("refuses a mismatched download without touching the models already on disk", async () => {
    const deps = readySetup();
    mkdirSync(deps.modelsDir, { recursive: true });
    const payloads = new Map<string, Uint8Array>();
    for (const model of MODEL_FILES) {
      const bytes = new TextEncoder().encode(model.name);
      payloads.set(model.name, bytes);
      writeFileSync(join(deps.modelsDir, model.name), bytes);
    }
    // 실제 sha256과 다르므로 다시 받으려 한다: 받은 내용도 다르면 실패해야 한다.
    deps.download = async () => new Uint8Array([1]);
    await expect(ensureReady(deps)).rejects.toThrow("sha256");
    // 원래 파일은 그대로 남는다(덮어쓰지 않았다).
    expect(sha(readFileSync(join(deps.modelsDir, MODEL_FILES[0].name)))).toBe(sha(payloads.get(MODEL_FILES[0].name)!));
  });
});

describe("lab_screen_find setup failure", () => {
  test("reports the setup error, retries setup on the next call and unlocks coordinate reads", async () => {
    let attempts = 0;
    const h = harness({
      prepare: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("pip 설치 실패");
        return { python: "/fake/python", modelsDir: "/fake/models", steps: ["rapidocr 설치"] };
      },
      finds: [{ code: 0, stdout: "1 2 0.9 확인\n", stderr: "" }],
    });
    expect(await h.find({ window: "AnyDesk", find: "확인" })).toContain("pip 설치 실패");
    expect(h.read("/tmp/x.png?q=확인 버튼 좌표")).toHaveProperty("additionalContext");
    const second = await h.find({ window: "AnyDesk", find: "확인" });
    expect(second).toContain("1 2 0.9 확인");
    expect(second).toContain("처음 사용 준비: rapidocr 설치");
  });
});

describe("ensureReady partial venv", () => {
  test("removes a venv it just created when creation fails, so the next call creates it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-fast-"));
    scratch.push(dir);
    const env = join(dir, "env");
    let venvRuns = 0;
    const deps: SetupDeps = {
      pythonEnv: env,
      modelsDir: join(dir, "models"),
      download: async () => new Uint8Array(),
      run: async (_command, args) => {
        if (args[1] === "venv") {
          venvRuns += 1;
          mkdirSync(join(env, "bin"), { recursive: true });
          writeFileSync(join(env, "bin", "python"), "");
          return { code: 1, stdout: "", stderr: "ensurepip failed" };
        }
        return { code: 1, stdout: "", stderr: "No module named pip" };
      },
    };
    await expect(ensureReady(deps)).rejects.toThrow("ensurepip failed");
    expect(existsSync(env)).toBe(false);
    await expect(ensureReady(deps)).rejects.toThrow("ensurepip failed");
    expect(venvRuns).toBe(2);
  });
});

describe("round-2 regressions", () => {
  test("a window failure needs the whole window name; a png failure needs the exact path", () => {
    expect(allowingFailure([{ window: "Production Console" }], { target: "/tmp/backup.png", question: "Backup Console: give OK coordinates" })).toBeUndefined();
    expect(allowingFailure([{ window: "Sign in" }], { target: "/tmp/other.png", question: "Give coordinates of Delete button" })).toBeUndefined();
    expect(allowingFailure([{ window: "Production Console" }], { target: "/tmp/x.png", question: "Production Console OK coordinates" })).toBeDefined();
    expect(allowingFailure([{ png: "/tmp/a\\b.png" }], { target: "/tmp/a/b.png", question: "OK coordinates" })).toBeUndefined();
  });

  test("mentioning a position and the word click is not a coordinate request without click intent", () => {
    expect(asksCoordinates("Is the position of the 'Click here' label centered?")).toBe(false);
    expect(asksCoordinates("'클릭' 라벨 위치가 가운데인가?")).toBe(false);
    expect(asksCoordinates("확인 버튼 위치 보고 누르려고 해")).toBe(true);
  });

  test("a failed venv inside an existing folder drops only bin/python so the next call creates it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "screen-fast-"));
    scratch.push(dir);
    const env = join(dir, "env");
    mkdirSync(env, { recursive: true });
    writeFileSync(join(env, "keep.txt"), "user file");
    let venvRuns = 0;
    const deps: SetupDeps = {
      pythonEnv: env,
      modelsDir: join(dir, "models"),
      download: async () => new Uint8Array(),
      run: async (_command, args) => {
        if (args[1] === "venv") {
          venvRuns += 1;
          mkdirSync(join(env, "bin"), { recursive: true });
          writeFileSync(join(env, "bin", "python"), "");
          return { code: 1, stdout: "", stderr: "ensurepip failed" };
        }
        return { code: 1, stdout: "", stderr: "No module named pip" };
      },
    };
    await expect(ensureReady(deps)).rejects.toThrow("ensurepip failed");
    await expect(ensureReady(deps)).rejects.toThrow("ensurepip failed");
    expect(venvRuns).toBe(2);
    expect(existsSync(join(env, "keep.txt"))).toBe(true);
  });
});

describe("round-3 regressions", () => {
  test("click intent may come before the position request; a label named 'Click position' is descriptive", () => {
    expect(asksCoordinates("Is the 'Click position' label centered?")).toBe(false);
    expect(asksCoordinates("To click Save, give me its position.")).toBe(true);
  });

  test("window failures match the title regex itself, anchored or grouped", () => {
    const q = (question: string, target = "/tmp/other.png") => ({ target, question });
    expect(allowingFailure([{ window: "^(Production|Backup) Console$" }], q("Production Dashboard: where should I click Delete?"))).toBeUndefined();
    expect(allowingFailure([{ window: "^(Production|Backup) Console$" }], q("Backup Console: where should I click Delete?"))).toBeDefined();
    expect(allowingFailure([{ window: "^(?:AnyDesk|Remmina)$" }], q("AnyDesk OK coordinates"))).toBeDefined();
    expect(allowingFailure([{ window: "^AnyDesk$" }], q("OK coordinates", "/tmp/AnyDesk.png"))).toBeDefined();
    expect(allowingFailure([{ window: "[broken" }], q("[broken OK coordinates"))).toBeUndefined();
  });
});

describe("round-4 regressions", () => {
  test("click intent phrasing and quoted labels", () => {
    expect(asksCoordinates("I will click Save; give me its position.")).toBe(true);
    expect(asksCoordinates("To click Save, what is its position?")).toBe(true);
    expect(asksCoordinates("Give me the click position of Save")).toBe(true);
    expect(asksCoordinates("Is the 'Click target' label centered?")).toBe(false);
  });

  test("window regex is matched inside one field, any title length, never when it matches empty text", () => {
    const q = (question: string, target = "/tmp/other.png") => ({ target, question });
    expect(allowingFailure([{ window: "^Production Console$" }], q("Where should I click in Production?", "Console.png"))).toBeUndefined();
    expect(allowingFailure([{ window: "^Remote Desktop Connection Manager Console$" }], q("Where should I click in Remote Desktop Connection Manager Console?"))).toBeDefined();
    expect(allowingFailure([{ window: ".*" }], q("Where should I click Delete?", "/tmp/unrelated.png"))).toBeUndefined();
    expect(allowingFailure([{ window: "AnyDesk|" }], q("Where should I click Delete?", "/tmp/unrelated.png"))).toBeUndefined();
    expect(allowingFailure([{ window: "^example\\.com$" }], q("Where do I click OK on example.com?"))).toBeDefined();
  });
});
