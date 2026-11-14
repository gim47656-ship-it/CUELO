import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { compilePatterns, matchHeavy, realDeps, VmMemoryGuard, type GuardDeps, type Outcome } from "./guard";

// 무거운 bash 호출(production 빌드, 전체 시험) 직전에 메모리가 모자라면 WinBoat VM을 정상 종료하고, 끝난 뒤 다시 켠다.
// 코어는 tool_call(실행 전)과 tool_result(끝난 뒤)를 보내고, 처리기는 30초에 막힌다. 그래서 끄기·부팅 대기는 25초까지만 기다린다.

const ASYNC_POLL_MS = 10_000;

interface Held {
  refId: string;
  session: string;
}

/** bash 결과 details가 백그라운드로 넘어간 작업을 가리키면 그 job id. */
function runningJobId(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || !("async" in details)) return undefined;
  const info = details.async;
  if (typeof info !== "object" || info === null || !("state" in info) || !("jobId" in info)) return undefined;
  return info.state === "running" && typeof info.jobId === "string" ? info.jobId : undefined;
}

export function createVmMemoryGuard(options: { deps?: GuardDeps; asyncPollMs?: number } = {}) {
  const asyncPollMs = options.asyncPollMs ?? ASYNC_POLL_MS;
  return function vmMemoryGuard(pi: ExtensionAPI): void {
    const guard = new VmMemoryGuard(options.deps ?? realDeps());
    const z = pi.zod;
    // 결과를 기다리는 동기 호출 (toolCallId → 참조)
    const pending = new Map<string, Held>();
    // 백그라운드로 넘어간 호출: 작업이 끝날 때까지 참조를 쥔다.
    const background = new Map<string, Held & { jobId: string; ctx: ExtensionContext; timer: NodeJS.Timeout }>();
    const sessionOf = (ctx: ExtensionContext) => ctx.sessionManager?.getSessionId?.() ?? "";
    const notice = (outcome: Outcome) => (outcome.notice ? { additionalContext: outcome.notice } : undefined);

    pi.on("session_start", async (_event, ctx) => {
      const outcome = await guard.recover().catch(() => ({}) as Outcome);
      if (outcome.notice) ctx.ui?.notify?.(outcome.notice, "info");
    });

    pi.on("tool_call", async (event, ctx) => {
      try {
        if (event.toolName === "vm_build") {
          const outcome = await guard.prepareVmBuild();
          if (outcome.block) return { block: true, reason: outcome.block };
          return notice(outcome);
        }
        if (event.toolName !== "bash") return;
        const input = event.input as Record<string, unknown>;
        // 이름 붙은 서비스(개발 서버 등)는 끝이 없는 작업이라 감싸지 않는다.
        if (typeof input.command !== "string" || typeof input.name === "string" && input.name.trim()) return;
        const { patterns } = compilePatterns(guard.heavyPatterns());
        if (!matchHeavy(input.command, patterns)) return;
        const refId = `${process.pid}:${event.toolCallId}`;
        pending.set(event.toolCallId, { refId, session: sessionOf(ctx) });
        return notice(await guard.acquire(refId));
      } catch {
        // 장치의 실패가 도구 호출을 막지 않는다.
        return;
      }
    });

    pi.on("tool_result", async (event, ctx) => {
      const held = pending.get(event.toolCallId);
      if (!held) return;
      pending.delete(event.toolCallId);
      const jobId = runningJobId(event.details);
      if (jobId) {
        const finish = () => {
          const job = background.get(held.refId);
          if (!job) return;
          clearInterval(job.timer);
          background.delete(held.refId);
          void guard.release(held.refId).then((outcome) => outcome.notice && job.ctx.ui?.notify?.(outcome.notice, "info")).catch(() => undefined);
        };
        const timer = setInterval(() => {
          try {
            const snapshot = ctx.getAsyncJobSnapshot?.();
            // 목록을 못 읽으면 끝났는지 알 수 없으니 쥐고 있는다(오래된 참조는 상태 파일이 걷어 낸다).
            if (snapshot && !snapshot.running.some((job) => job.id === jobId)) finish();
          } catch {
            // 다음 주기에 다시 본다.
          }
        }, asyncPollMs);
        timer.unref?.();
        background.set(held.refId, { ...held, jobId, ctx, timer });
        return;
      }
      return notice(await guard.release(held.refId).catch(() => ({}) as Outcome));
    });

    // 결과가 오지 않은 동기 호출(다른 처리기가 막은 호출 등)의 참조는 턴이 끝나면 놓는다.
    pi.on("turn_end", async (_event, ctx) => {
      const session = sessionOf(ctx);
      for (const [toolCallId, held] of [...pending]) {
        if (held.session !== session) continue;
        pending.delete(toolCallId);
        await guard.release(held.refId).catch(() => undefined);
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const session = sessionOf(ctx);
      const refs = [
        ...[...pending].filter(([, held]) => held.session === session).map(([toolCallId, held]) => { pending.delete(toolCallId); return held.refId; }),
        ...[...background].filter(([, job]) => job.session === session).map(([refId, job]) => { clearInterval(job.timer); background.delete(refId); return refId; }),
      ];
      for (const refId of refs) await guard.release(refId).catch(() => undefined);
    });

    pi.registerTool({
      name: "lab_vm_memory_guard",
      label: "VM memory guard",
      loadMode: "essential",
      description:
        "WinBoat VM memory guard. `status` shows the VM state, MemAvailable, the threshold, active job references, the last guard action and the active heavy-command patterns; "
        + "`stop` shuts the VM down normally (refused while vm_build runs or a VM client is connected unless force: true; a manual stop is never undone automatically); "
        + "`start` starts it. The guard itself stops the VM before heavy local bash jobs (next build, bun run build, bun run test, bun test) when MemAvailable is below the threshold, "
        + "and starts it again afterwards, but only a VM it stopped.",
      parameters: z.object({
        action: z.enum(["status", "stop", "start"]).describe("status | stop | start"),
        force: z.boolean().optional().describe("stop only: also stop while vm_build runs or a VM client is connected"),
      }),
      async execute(_callId, params) {
        const { action, force } = params as { action: "status" | "stop" | "start"; force?: boolean };
        let text: string;
        if (action === "stop") text = await guard.manualStop(force === true);
        else if (action === "start") text = await guard.manualStart();
        else {
          const recovered = await guard.recover().catch(() => ({}) as Outcome);
          const status = await guard.status();
          text = recovered.notice ? `${recovered.notice}\n${status.text}` : status.text;
        }
        return { content: [{ type: "text", text }] };
      },
    });
  };
}

export default createVmMemoryGuard();
