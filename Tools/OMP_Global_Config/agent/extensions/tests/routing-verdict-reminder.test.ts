import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createJevRuntime } from "../jev-runtime";
import { createRoutingLedger, type AttemptIdentity, type OutcomeRecord, type VerdictRecord } from "../lib/routing-ledger";

test("Main receives one quiet reminder per terminal turn until the exact attempt has a verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "routing-verdict-reminder-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const auth = await AuthStorage.create(join(agentDir, "agent.db"));
  const sessions = SessionManager.create(root, join(root, "sessions"));
  try {
    const ts = "2026-11-18T00:00:00.000Z";
    const ledgerPath = join(agentDir, "routing-ledger.jsonl");
    const ledger = createRoutingLedger(ledgerPath);
    const sessionId = sessions.getSessionId();
    function seed(name: string, status: OutcomeRecord["status"] | "running", session = sessionId, attempt = 1): AttemptIdentity {
      const assignmentId = `${session}#${name}`;
      const identity = { sessionId: session, assignmentId, attempt, attemptId: `${assignmentId}#a${attempt}`, agentId: name, jobId: "" };
      expect(ledger.append({
        ...identity, type: "dispatch", ts, name, workClass: "NORMAL", focus: null, recommendedProfile: null,
        recommendedModel: null, recommendedEffort: null, chosenModel: "fixture/main", chosenEffort: "off",
        routingReason: false, purpose: "primary",
      })).toBe(true);
      if (status !== "running") expect(ledger.append({ ...identity, type: "outcome", ts, status, durationSec: 1 })).toBe(true);
      return identity;
    }
    function seedVerdict(identity: AttemptIdentity, verdict: VerdictRecord["verdict"]): void {
      expect(ledger.append({ ...identity, type: "verdict", ts, verdict, reason: "Fixture", revision: null, evidenceLocators: [] })).toBe(true);
    }
    seedVerdict(seed("Reviewable", "completed"), "rework");
    const pending = seed("Reviewable", "completed", sessionId, 2);
    seedVerdict(seed("AlreadyAccepted", "completed"), "accepted");
    seedVerdict(seed("AlreadyHeld", "completed"), "held");
    seed("ForeignMaker", "completed", "another-session");
    seed("FailedMaker", "failed");
    seed("CancelledMaker", "cancelled");
    seed("RunningMaker", "running");
    appendFileSync(ledgerPath, `${JSON.stringify({ type: "verdict", ts, sessionId, name: "LegacyMaker", verdict: "held" })}\n`);
    appendFileSync(ledgerPath, `${JSON.stringify({ ...pending, type: "verdict", ts, verdict: "unknown" })}\n`);

    const registry = new ModelRegistry(auth, join(agentDir, "models.yml"));
    registry.registerProvider("fixture", {
      baseUrl: "http://127.0.0.1:9/v1", apiKey: "local", api: "openai-completions",
      models: [{ id: "main", name: "Main", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    });
    const model = registry.find("fixture", "main")!;
    let end = Promise.withResolvers<void>();
    const verdictHooks: string[] = [];
    const { session } = await createAgentSession({
      cwd: root, agentDir, agentId: "Main", model, modelRegistry: registry, sessionManager: sessions,
      settings: Settings.isolated({ tools: { commands: true, approvalMode: "yolo" } } as never),
      disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
      skills: [], rules: [], contextFiles: [],
      extensions: [
        createJevRuntime({ ledgerPath, resolveJudge: () => { throw new Error("No judge expected"); } }),
        pi => {
          pi.on("agent_end", event => { if (!event.willContinue) end.resolve(); });
          pi.on("tool_call", event => { if (event.toolName === "routing_verdict") verdictHooks.push("call"); });
          pi.on("tool_result", event => { if (event.toolName === "routing_verdict") verdictHooks.push(event.isError ? "error" : "result"); });
        },
      ],
    });
    try {
      const sends: Promise<unknown>[] = [];
      const errors: unknown[] = [];
      await initializeExtensions(session, {
        reportSendError: (_action, error) => { errors.push(error); },
        reportRuntimeError: error => { errors.push(error); },
        trackExtensionSend: send => { sends.push(send); },
      });
      expect(errors).toEqual([]);
      let calls = 0;
      let recordOnNextCall = false;
      session.agent.streamFn = () => {
        calls++;
        const stream = createAssistantMessageEventStream();
        const write = recordOnNextCall;
        recordOnNextCall = false;
        const params = { sessionId, assignmentId: pending.assignmentId, attemptId: pending.attemptId, verdict: "held", reason: "Waiting for test evidence." };
        const toolCall = { type: "toolCall" as const, id: "record-verdict", name: "bash", arguments: {
          command: `routing_verdict --json '${JSON.stringify(params)}'`,
        } };
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: write ? [toolCall] : [{ type: "text", text: "Fixture done." }], stopReason: write ? "toolUse" : "stop",
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          if (write) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          stream.push({ type: "done", reason: write ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      };
      async function run(prompt: string): Promise<void> {
        end = Promise.withResolvers<void>();
        await session.prompt(prompt);
        await end.promise;
        await Promise.all(sends);
      }
      const reminders = () => session.messages.flatMap(message =>
        message.role === "custom" && typeof message.content === "string" && message.content.includes("[JevRuntime:verdict-reminder]")
          ? [message.content] : []);

      await run("First ordinary turn.");
      expect(reminders()).toHaveLength(1);
      const [first] = reminders();
      expect(first).toContain(`${sessionId}|${pending.assignmentId}|${pending.attemptId}`);
      expect(first).toContain("routing_verdict --help");
      expect(first).not.toMatch(/#a1|AlreadyAccepted|AlreadyHeld|ForeignMaker|FailedMaker|CancelledMaker|RunningMaker/);
      expect(ledger.read(sessionId).filter(row => row.type === "verdict" && row.attemptId === pending.attemptId)).toMatchObject([{ verdict: "unknown" }]);
      console.log(first);

      await run("Second ordinary turn.");
      expect(reminders()).toEqual([first, first]);
      expect(calls).toBe(2);
      expect(await Promise.all(sends)).toEqual([false, false]);

      recordOnNextCall = true;
      await run("Record the explicit held verdict.");
      expect(verdictHooks).toEqual(["call", "result"]);
      expect(ledger.read(sessionId).findLast(row => row.type === "verdict" && row.attemptId === pending.attemptId)).toMatchObject({ verdict: "held" });
      expect(reminders()).toEqual([first, first]);
      expect(calls).toBe(4);
      expect(errors).toEqual([]);
      console.log("SDK smoke: 1 reminder per undecided Main turn, 0 additional reminders after the routing_verdict command, 0 autonomous turns.");
    } finally {
      await session.dispose();
    }
  } finally {
    await sessions.close();
    auth.close();
    rmSync(root, { recursive: true, force: true });
  }
});
