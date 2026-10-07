import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  buildCandidates,
  buildJudgeRequest,
  type CatalogEntry,
  type DisabledServer,
  extractRequestCue,
  type McpServerInfo,
  mentionedServers,
  planSelection,
  renderJudgeFailure,
  renderOutcomeLines,
  renderReport,
  summarizeProjectStack,
  VERIFIED_CATALOG,
} from "./lib/mcp-selection";

/**
 * 요청별 MCP 선택(`mcp.selection: per-request`). 패치된 core가 매 사용자 요청의 system prompt를 만들기
 * 전에 `mcp_select`를 보내면, 이미 허용된 서버 중 native JEV가 needed로 본 것만 연결하게 이름을 돌려준다.
 * 꺼진 서버·미설치 추천은 안내만 하고 이 선택기는 켜거나 설치하지 않는다. 설치·인증·권한은 먼저 사용자 승인을 요청하고
 * 승인 후 Main 에이전트가 실행하며, 사용자 본인 로그인·제공자 안전 동의만 사용자가 한다. 설정 파일은 읽기만 하고,
 * 한 번 보여 준 설치 제안 이름만 `mcp-suggested.json`에 남겨 다음 세션부터는 요청에 그 이름이 있을 때만 다시 판단한다.
 * `mcp_select`를 모르는 core(standalone omp 등)에서는 핸들러가 호출되지 않아 아무 일도 하지 않는다.
 */

interface JudgeAnswers {
  answers: Record<string, { type: string; choice?: string } | undefined>;
}

/** 판정기 seam. 기본 구현은 native 후보에서만 판정을 실행한다. */
export interface NativeJudge {
  judge(request: { state: unknown; questions: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<JudgeAnswers>;
}

type JudgeKind = "native" | "local" | "online";

interface ChainJudgeLike {
  withCandidate<T>(run: (judge: NativeJudge, kind: JudgeKind) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

/** 기존 core 판정 모듈. 런타임 값은 host가 해석하고 타입은 여기 필요한 만큼만 둔다. */
export interface CoreJudgmentModules {
  judgment: {
    resolveJudge(deps: {
      settings: unknown;
      registry: unknown;
      sessionId?: string;
      purpose: string;
      onUsage?: unknown;
    }): ChainJudgeLike;
    hasNativeJudge(settings: unknown, registry: unknown): boolean;
    journalJudgmentUsage?(manager: unknown): unknown;
  };
  settings: { findScopedSettings(cwd?: string): unknown };
}

export interface McpSelectionDeps {
  /** 결정적 판정기 seam(테스트). 없으면 {@link loadCore}의 native JEV를 쓴다. */
  resolveJudge?: (ctx: ExtensionContext) => Promise<NativeJudge | undefined>;
  /** 기존 판정·설정 모듈 로더. 테스트는 검증 대상 core 사본의 모듈을 넘긴다. */
  loadCore?: () => Promise<CoreJudgmentModules>;
  /** user `mcp.json`이 있는 agent 루트. 기본은 이 확장이 설치된 프로필 루트다. */
  agentDir?: string;
  catalog?: readonly CatalogEntry[];
}

interface McpSelectOutcomeLike {
  connected: string[];
  failed: Array<{ name: string; error: string }>;
}

interface McpSelectEventLike {
  prompt: string;
  deferred: McpServerInfo[];
  connected: McpServerInfo[];
  signal?: AbortSignal;
  outcome?: Promise<McpSelectOutcomeLike>;
}

const CUSTOM_TYPE = "mcp-selection";
const SUGGESTED_FILE = "mcp-suggested.json";
const STACK_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "bin", "obj", "dist", "build", "out", "target", "vendor"]);
const STACK_DIR_LIMIT = 40;

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readSuggested(agentDir: string): Promise<Set<string>> {
  const names = (await readJson(join(agentDir, SUGGESTED_FILE)))?.names;
  return new Set(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : []);
}

/** 다른 세션이 남긴 이름과 합쳐 원자적으로 바꾼다. */
async function writeSuggested(agentDir: string, names: ReadonlySet<string>): Promise<void> {
  const merged = new Set([...(await readSuggested(agentDir)), ...names]);
  const path = join(agentDir, SUGGESTED_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ names: [...merged].sort() }, null, 2)}\n`);
  await rename(temp, path);
}

/** 사용자가 끈 서버 이름만 읽는다(command·url·env·headers는 읽지 않는다). */
async function readDisabledServers(agentDir: string, cwd: string): Promise<DisabledServer[]> {
  const found = new Map<string, DisabledServer>();
  const collect = (config: Record<string, unknown> | undefined, scope: DisabledServer["scope"]) => {
    const servers = config?.mcpServers;
    if (servers && typeof servers === "object") {
      for (const [name, server] of Object.entries(servers)) {
        if (server && typeof server === "object" && "enabled" in server && server.enabled === false) {
          found.set(name, { name, scope });
        }
      }
    }
  };
  const user = await readJson(join(agentDir, "mcp.json"));
  collect(user, "user");
  for (const name of Array.isArray(user?.disabledServers) ? user.disabledServers : []) {
    if (typeof name === "string") found.set(name, { name, scope: "user" });
  }
  collect(await readJson(join(cwd, ".omp", "mcp.json")), "project");
  return [...found.values()];
}

/** cwd와 한 단계 하위 폴더의 파일명(종류 판정용)과 package.json 의존성 이름을 모은다. 내용은 읽지 않는다. */
async function readProjectStack(cwd: string): Promise<string> {
  const fileNames: string[] = [];
  const list = async (dir: string) => {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const top = await list(cwd);
  const subdirs: string[] = [];
  for (const entry of top) {
    if (entry.isFile()) fileNames.push(entry.name);
    else if (entry.isDirectory() && !entry.name.startsWith(".") && !STACK_SKIP_DIRS.has(entry.name)) subdirs.push(entry.name);
  }
  for (const dir of subdirs.slice(0, STACK_DIR_LIMIT)) {
    for (const entry of await list(join(cwd, dir))) if (entry.isFile()) fileNames.push(entry.name);
  }
  const manifest = await readJson(join(cwd, "package.json"));
  const dependencyNames: string[] = [];
  for (const key of ["dependencies", "devDependencies"]) {
    const deps = manifest?.[key];
    if (deps && typeof deps === "object") dependencyNames.push(...Object.keys(deps));
  }
  return summarizeProjectStack({ fileNames, dependencyNames });
}

async function defaultLoadCore(): Promise<CoreJudgmentModules> {
  // 지연 import: 테스트 미러에는 node_modules가 없고, 런타임은 host 번들로 해석한다(jev-runtime과 같다).
  const [judgment, settings] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/judgment"),
    import("@oh-my-pi/pi-coding-agent/config/settings"),
  ]);
  return { judgment, settings } as unknown as CoreJudgmentModules;
}

/**
 * 기존 native JEV만 쓴다. judge 역할의 첫 후보가 native가 아니면 판정하지 않고, 세션 모델 fallback을
 * 붙이지 않으며(sessionModel 미전달), 체인이 native가 아닌 후보를 내면 그 후보에서는 실행하지 않는다.
 */
async function resolveNativeJudge(ctx: ExtensionContext, loadCore: () => Promise<CoreJudgmentModules>): Promise<NativeJudge> {
  const { judgment, settings: settingsModule } = await loadCore();
  const settings = settingsModule.findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("세션 설정을 찾지 못함");
  if (!judgment.hasNativeJudge(settings, ctx.modelRegistry)) throw new Error("judge 역할 첫 후보가 native JEV가 아님");
  const chain = judgment.resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    purpose: "mcp_selection",
    onUsage: judgment.journalJudgmentUsage?.(ctx.sessionManager),
  });
  return {
    judge: (request, options) =>
      chain.withCandidate(
        (candidate, kind) =>
          kind === "native" ? candidate.judge(request, options) : Promise.reject(new Error(`native가 아닌 judge 후보(${kind})`)),
        options,
      ),
  };
}

export function createMcpSelection(deps: McpSelectionDeps = {}) {
  const agentDir = deps.agentDir ?? join(import.meta.dir, "..");
  const catalog = deps.catalog ?? VERIFIED_CATALOG;
  const loadCore = deps.loadCore ?? defaultLoadCore;
  const resolveJudge = deps.resolveJudge ?? ((ctx: ExtensionContext) => resolveNativeJudge(ctx, loadCore));

  return function mcpSelection(pi: ExtensionAPI): void {
    /** 이미 보여 준 설치 제안. 세션을 넘어 반복하지 않도록 agentDir 파일과 함께 유지한다. */
    let suggestedPromise: Promise<Set<string>> | undefined;
    let judgePromise: Promise<NativeJudge | undefined> | undefined;
    let stackPromise: Promise<string> | undefined;
    /** 진행 중 선택. before_agent_start가 닫으면 늦게 끝난 판정은 상태를 바꾸지 못한다. */
    let current: { controller: AbortController; done: boolean } | undefined;
    let pending: { lines: string[]; requested: boolean; outcome?: Promise<McpSelectOutcomeLike> } | undefined;

    const judgeFor = (ctx: ExtensionContext) => {
      // 해석 실패·미해석은 캐시하지 않는다. 다음 요청에서 다시 해석한다.
      judgePromise ??= resolveJudge(ctx).then(
        (judge) => {
          if (!judge) judgePromise = undefined;
          return judge;
        },
        (error) => {
          judgePromise = undefined;
          throw error;
        },
      );
      return judgePromise;
    };

    const onSelect = async (event: McpSelectEventLike, ctx: ExtensionContext) => {
      current?.controller.abort();
      const token = { controller: new AbortController(), done: false };
      current = token;
      pending = undefined;
      const finish = (value: typeof pending) => {
        if (current !== token) return false;
        token.done = true;
        pending = value;
        return true;
      };

      const cue = extractRequestCue(event.prompt);
      if (!cue) {
        finish(undefined);
        return undefined;
      }
      const known = new Set([...event.deferred, ...event.connected].map((server) => server.name));
      const disabled = (await readDisabledServers(agentDir, ctx.cwd)).filter((server) => !known.has(server.name));
      const suggested = await (suggestedPromise ??= readSuggested(agentDir));
      const namedCatalog = mentionedServers(event.prompt, catalog.map((entry) => entry.name));
      const pendingCatalog = catalog.filter(
        (entry) =>
          !known.has(entry.name) &&
          !disabled.some((server) => server.name === entry.name) &&
          (!suggested.has(entry.name) || namedCatalog.has(entry.name)),
      );
      const candidates = buildCandidates({ deferred: event.deferred, connected: event.connected, disabled, catalog: pendingCatalog });
      if (candidates.length === 0) {
        finish(undefined);
        return undefined;
      }
      const mentioned = mentionedServers(event.prompt, candidates.map((candidate) => candidate.name));
      stackPromise ??= readProjectStack(ctx.cwd);

      const answers: Record<string, string | undefined> = {};
      try {
        const judge = await judgeFor(ctx);
        if (!judge) throw new Error("JEV 판정기를 해석하지 못함");
        const signal = event.signal ? AbortSignal.any([event.signal, token.controller.signal]) : token.controller.signal;
        const result = await judge.judge(buildJudgeRequest(cue, await stackPromise, candidates), { signal });
        for (const [key, answer] of Object.entries(result.answers)) {
          answers[key] = answer?.type === "choice" ? answer.choice : undefined;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (current === token) pi.logger.warn("mcp-selection: JEV 판정 실패, 새 MCP 연결 없음", { error: reason });
        finish({ lines: [renderJudgeFailure(reason, event.deferred.map((server) => server.name))], requested: false });
        return undefined;
      }

      const plan = planSelection({ candidates, answers, mentioned, catalog: pendingCatalog });
      if (!finish({ lines: plan.lines, requested: plan.connect.length > 0, outcome: event.outcome })) return undefined;
      const shown = pendingCatalog.filter((entry) => !suggested.has(entry.name) && plan.lines.some((line) => line.includes(`\`${entry.name}\``)));
      if (shown.length > 0) {
        for (const entry of shown) suggested.add(entry.name);
        await writeSuggested(agentDir, suggested).catch((error) =>
          pi.logger.warn("mcp-selection: 설치 제안 기록 실패", { error: error instanceof Error ? error.message : String(error) }),
        );
      }
      return { connect: plan.connect, expose: plan.expose };
    };

    // 18.4.3 upstream·standalone 타입에는 `mcp_select` overload가 없어 문자열 이벤트로 등록한다.
    (pi.on as unknown as (event: string, handler: (event: McpSelectEventLike, ctx: ExtensionContext) => unknown) => void)(
      "mcp_select",
      onSelect,
    );

    pi.on("before_agent_start", async () => {
      const token = current;
      const result = pending;
      current = undefined;
      pending = undefined;
      if (!token) return undefined;
      let content: string | undefined;
      if (!token.done) {
        // runner 제한 시간 안에 판정이 끝나지 않았다. 늦은 결과는 버리고 진행 중 판정을 취소한다.
        token.controller.abort();
        content = renderJudgeFailure("판정이 제한 시간 안에 끝나지 않음", []);
      } else if (result) {
        const lines = [...result.lines];
        if (result.requested && result.outcome) lines.unshift(...renderOutcomeLines(await result.outcome));
        if (lines.length > 0) content = lines[0]!.startsWith("[MCP 선택]") ? lines.join("\n") : renderReport(lines);
      }
      if (!content) return undefined;
      return { message: { customType: CUSTOM_TYPE, content, display: true, attribution: "agent" } };
    });

    pi.on("session_start", () => {
      current?.controller.abort();
      current = undefined;
      pending = undefined;
      stackPromise = undefined;
    });
  };
}

export default createMcpSelection();
