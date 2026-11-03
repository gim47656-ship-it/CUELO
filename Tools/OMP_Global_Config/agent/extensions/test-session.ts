import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  brokerBackend,
  endSession,
  type Env,
  finishScope,
  launchResource,
  listScopes,
  OUTPUTS_DIR,
  readState,
  type Resource,
  type Scope,
  startScope,
  stopScopeResources,
  storeRoot,
  TestSessionError,
  trackResource,
  workspacePath,
} from "./lib/test-session-store";

/**
 * test_session: 한 세션이 이름 붙인 테스트 환경(관리 작업 공간 + SDK launch broker 서비스)을 턴을 넘어 다시 쓰고
 * 명시한 finish에서만 정리하는 도구. 상태·소유권 규칙은 lib/test-session-store.ts에 있다.
 *
 * 턴 종료에는 아무것도 하지 않는다. 세션 전체가 끝나면(session_shutdown, 다른 세션으로 전환) 이 세션이 띄운 살아 있는
 * 자원만 멈추고 작업 공간과 기록은 남긴다. 같은 세션을 다시 열면(재시작 뒤 resume 포함) 남은 범위를 한 번 알리고,
 * reload(같은 세션 id)는 아무것도 다시 띄우지 않는다.
 */

export const NOTICE_TYPE = "test-session-retained";

const DESCRIPTION =
  "Reusable test environments for this session. A named scope owns a managed workspace that persists across turns and reloads until an explicit finish. "
  + "Files under the workspace's outputs/ folder (and any keep paths) are kept by finish; everything else in the workspace is scratch and is deleted by finish. "
  + "Actions: start (create, or reopen by name in the same session reusing the same workspace), list (scopes with live broker status; never restarts anything), "
  + "launch (run command as an SDK launch broker service owned by this session; cwd defaults to the workspace, env TEST_SESSION_WORKSPACE and TEST_SESSION_OUTPUTS; "
  + "a live resource of the same name is reused, not restarted; optional ready {log|port, timeout seconds}), "
  + "track (attach a live broker service this same session already started, e.g. a bash `name` service; nothing else), "
  + "stop (stop resources only; scope and workspace stay), "
  + "finish (stop verified resources, then delete scratch keeping outputs/ and keep; an unverifiable resource leaves the scope needs-cleanup with the workspace untouched; calling finish again retries only what is left). "
  + "Turn end does nothing; session end stops this session's running resources and keeps workspace and record. Service logs: read proc://<service>.";

interface Params {
  action: string;
  name?: string;
  purpose?: string;
  resource?: string;
  command?: string;
  cwd?: string;
  ready?: { log?: string; port?: number; host?: string; timeout?: number };
  service?: string;
  keep?: string[];
}

const STATE_LABEL: Record<Resource["state"], string> = { running: "실행 중", stopped: "정지함", exited: "끝남", "needs-cleanup": "정리 필요" };
const STATUS_LABEL: Record<Scope["status"], string> = { active: "사용 중", "needs-cleanup": "정리 필요", finished: "끝남" };
/** 끝난 것이 확인되지 않은 상태. 요약 문장은 이 상태가 하나라도 있으면 멈췄다고 말하지 않는다. */
const unverified = (state: Resource["state"]): boolean => state === "running" || state === "needs-cleanup";

function describeScope(env: Env, scope: Scope): string[] {
  const workspace = workspacePath(env, scope.id);
  const lines = [`- ${scope.name} [${STATUS_LABEL[scope.status]}] 작업 공간 ${workspace}`];
  if (scope.status !== "finished") lines.push(`  남길 결과물 위치: ${workspace}/${OUTPUTS_DIR} (finish 때 이 폴더와 keep 경로만 남고 나머지는 지웁니다)`);
  if (scope.purpose) lines.push(`  목적: ${scope.purpose}`);
  for (const resource of scope.resources) {
    const note = resource.note ? ` — ${resource.note}` : "";
    const logs = resource.state === "running" ? `, 로그 read proc://${resource.service}` : "";
    lines.push(`  자원 ${resource.key}: ${STATE_LABEL[resource.state]}${note} (서비스 ${resource.service}${logs})`);
  }
  if (scope.sessionEndedAt && scope.status !== "finished") {
    lines.push(scope.resources.some((resource) => unverified(resource.state))
      ? `  이전 세션이 끝날 때(${scope.sessionEndedAt}) 멈춘 것을 확인하지 못한 자원이 있습니다(위 '실행 중'·'정리 필요'). 자동으로 다시 띄우지 않았습니다.`
      : `  이전 세션이 끝난 뒤(${scope.sessionEndedAt}) 실행 중인 자원이 없습니다. 자동으로 다시 띄우지 않았습니다.`);
  }
  for (const issue of scope.cleanupIssues ?? []) lines.push(`  정리 대기: ${issue}`);
  if (scope.status === "finished") {
    lines.push(scope.kept?.length ? `  남긴 결과물: ${scope.kept.join(", ")} (${workspace})` : "  작업 공간을 모두 지웠습니다.");
  }
  return lines;
}

async function run(params: Params, env: Env): Promise<{ text: string; details: unknown }> {
  const name = params.name ?? "";
  switch (params.action) {
    case "start": {
      const result = await startScope(env, { name, purpose: params.purpose });
      const head = result.created ? `새 테스트 범위 '${name}'를 만들었습니다.` : `기존 테스트 범위 '${name}'를 다시 열었습니다(작업 공간 재사용).`;
      return { text: [head, ...describeScope(env, result.scope)].join("\n"), details: result };
    }
    case "list": {
      const result = await listScopes(env, params.name);
      const lines = result.scopes.length ? result.scopes.flatMap((scope) => describeScope(env, scope)) : [params.name ? `'${params.name}' 범위가 없습니다.` : "이 세션에 열린 테스트 범위가 없습니다."];
      if (result.otherSessions > 0) lines.push(`다른 세션이 끝내지 않고 남긴 범위 ${result.otherSessions}개가 ${env.root}에 있습니다(이 세션에서는 조작하지 않습니다).`);
      return { text: lines.join("\n"), details: result };
    }
    case "launch": {
      if (!params.resource || !params.command) throw new TestSessionError("launch에는 resource와 command가 필요합니다.");
      const result = await launchResource(env, { name, resource: params.resource, command: params.command, cwd: params.cwd, ready: params.ready });
      const resource = result.resource;
      const lines = [result.reused
        ? `실행 중인 '${resource.key}'를 재사용했습니다(재시작 없음, 서비스 ${resource.service}).`
        : `'${resource.key}'를 서비스 ${resource.service}로 띄웠습니다.`];
      if (result.commandDiffers) lines.push("요청한 command가 실행 중인 것과 다릅니다. 바꾸려면 stop 뒤 다시 launch하세요.");
      if (result.leftover) lines.push(`동시에 띄운 서비스 ${result.leftover.service}가 끝났는지 확인하지 못해 정리 필요로 기록했습니다. finish에서 다시 확인합니다.`);
      if (result.readyTimedOut) lines.push("준비 조건을 제한 시간 안에 확인하지 못했습니다. 서비스는 계속 실행 중이며 read proc://로 로그를 보세요.");
      if (resource.state === "exited") lines.push(`서비스가 이미 끝났습니다${resource.exitCode === undefined ? "" : `(exit ${resource.exitCode})`}. read proc://${resource.service}로 로그를 보세요.`);
      return { text: [...lines, ...describeScope(env, result.scope)].join("\n"), details: result };
    }
    case "track": {
      if (!params.resource || !params.service) throw new TestSessionError("track에는 resource와 service가 필요합니다.");
      const result = await trackResource(env, { name, resource: params.resource, service: params.service });
      return { text: [`서비스 ${params.service}를 '${params.resource}' 자원으로 붙였습니다.`, ...describeScope(env, result.scope)].join("\n"), details: result };
    }
    case "stop": {
      const result = await stopScopeResources(env, { name, resource: params.resource });
      const pending = result.acted.filter((item) => unverified(item.state)).map((item) => item.key);
      const head = result.acted.length === 0
        ? "멈출 실행 중 자원이 없습니다."
        : pending.length === 0
          ? "자원만 멈췄습니다. 범위와 작업 공간은 그대로 남아 다시 launch할 수 있습니다."
          : `멈춘 것을 확인한 자원 ${result.acted.length - pending.length}개, 확인하지 못한 자원 ${pending.join(", ")}(아래 상태 참고). 범위와 작업 공간은 그대로 남습니다.`;
      return { text: [head, ...describeScope(env, result.scope)].join("\n"), details: result };
    }
    case "finish": {
      const result = await finishScope(env, { name, keep: params.keep });
      const head = result.issues.length === 0
        ? `'${name}' 정리를 마쳤습니다.`
        : `'${name}' 정리가 끝나지 않았습니다(정리 필요). 같은 finish를 다시 부르면 남은 일만 다시 합니다.`;
      return { text: [head, ...describeScope(env, result.scope)].join("\n"), details: result };
    }
    default:
      throw new TestSessionError("action은 start, list, launch, track, stop, finish 중 하나입니다.");
  }
}

function idOf(ctx: ExtensionContext): string | undefined {
  const id = ctx.sessionManager?.getSessionId?.();
  return typeof id === "string" && id ? id : undefined;
}

export default function testSession(pi: ExtensionAPI): void {
  const z = pi.zod;
  const backend = brokerBackend();
  const envFor = (sessionId: string, ctx: ExtensionContext): Env => ({ root: storeRoot(), sessionId, projectDir: ctx.cwd, backend });

  pi.registerTool({
    name: "test_session", label: "Test Session", loadMode: "essential", approval: "exec",
    description: DESCRIPTION,
    parameters: z.object({
      action: z.enum(["start", "list", "launch", "track", "stop", "finish"]),
      name: z.string().optional().describe("scope name; required except for list"),
      purpose: z.string().optional(),
      resource: z.string().optional().describe("resource key inside the scope (launch, track, stop)"),
      command: z.string().optional().describe("launch: shell command run as a broker service"),
      cwd: z.string().optional().describe("launch: working directory, relative to the workspace by default"),
      ready: z.object({ log: z.string().optional(), port: z.number().optional(), host: z.string().optional(), timeout: z.number().optional() }).optional(),
      service: z.string().optional().describe("track: name of a live broker service this session started"),
      keep: z.array(z.string()).optional().describe("finish: extra workspace-relative paths to keep besides outputs/"),
    }) as never,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionId = idOf(ctx);
      try {
        if (!sessionId) throw new TestSessionError("세션 id를 알 수 없어 테스트 범위를 다룰 수 없습니다.");
        const input = params as Params;
        if (input.action !== "list" && !input.name) throw new TestSessionError(`${input.action}에는 name이 필요합니다.`);
        const { text, details } = await run(input, envFor(sessionId, ctx));
        return { content: [{ type: "text", text }], details };
      } catch (error) {
        const text = `test_session 오류: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: "text", text }], isError: true };
      }
    },
  });

  // 세션 전환으로 이전 세션을 떠나면 그 세션의 살아 있는 자원을 멈춘다. 같은 id의 reload는 아무것도 멈추지 않는다.
  let current: string | undefined;
  let noticePending = false;
  const end = async (sessionId: string, ctx: ExtensionContext): Promise<void> => {
    try {
      await endSession(envFor(sessionId, ctx));
    } catch (error) {
      pi.logger.warn("test_session: 세션 종료 정리 실패", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // 세션을 열거나(start) 다시 읽으면(resume·reload·fork·new) 남은 범위 안내를 다음 prompt 하나에 싣는다. switch 도중에
  // 보낸 메시지는 core가 직후 대화를 파일에서 다시 채우며 버리므로 before_agent_start 결과로 붙인다.
  pi.on("session_start", (_event, ctx) => {
    current = idOf(ctx);
    noticePending = true;
  });
  pi.on("session_switch", async (_event, ctx) => {
    const next = idOf(ctx);
    const previous = current;
    current = next;
    noticePending = true;
    if (previous && previous !== next) await end(previous, ctx);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!noticePending || event.reason !== "prompt") return undefined;
    noticePending = false;
    const sessionId = idOf(ctx);
    if (!sessionId) return undefined;
    try {
      const env = envFor(sessionId, ctx);
      const open = (await readState(env)).scopes.filter((scope) => scope.status !== "finished");
      if (open.length === 0) return undefined;
      const content = ["[test_session] 이 세션에 남아 있는 테스트 범위입니다. 아무것도 자동으로 다시 띄우지 않았습니다. "
        + "실제 상태는 test_session list, 계속 쓰려면 launch, 끝내려면 finish를 부르세요.", ...open.flatMap((scope) => describeScope(env, scope))].join("\n");
      return { message: { customType: NOTICE_TYPE, content, display: false, attribution: "agent" } };
    } catch (error) {
      pi.logger.warn("test_session: 남은 범위 안내 실패", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = idOf(ctx) ?? current;
    if (sessionId) await end(sessionId, ctx);
  });
}
