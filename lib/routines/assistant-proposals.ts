import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { commitRoutineChange } from "./git-sync";
import { localParts, ROUTINE_TIMEZONE } from "./schedule";
import { type Routine, type RoutineInput, isRoutineId, newRoutineId, parseRoutineInput, readRoutine, routinePaths, writeRoutineFile, thisRoutineHost } from "./store";
import { startManualRoutineRun } from "./runner";
import { readRoutineRunStates } from "./state";

export type AssistantAction = "create" | "update" | "enable" | "disable" | "run";
export interface AssistantProposal {
  id: string;
  action: AssistantAction;
  status: "pending" | "applying" | "applied" | "cancelled" | "failed";
  routineId?: string;
  baseRevision?: string;
  before?: Routine;
  input?: RoutineInput;
  oneOff?: boolean;
  result?: string;
  at: string;
  changedAt: string;
  turn: string;
}
export interface AssistantState {
  sessionId?: string;
  sessionFile?: string;
  proposals: AssistantProposal[];
  notified: string[];
  newSession?: boolean;
  error?: string;
}
export const ASSISTANT_STATE_FILE = "cuelo-routine-assistant.json";
export class AssistantError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
/** A refusal that changed nothing, so the same card stays applicable. */
class AssistantRetryError extends AssistantError {}
export function readAssistantState(agentDir = getAgentDir()): AssistantState {
  try { return JSON.parse(readFileSync(join(agentDir, ASSISTANT_STATE_FILE), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { proposals: [], notified: [] };
    throw error;
  }
}
export function saveAssistantState(state: AssistantState, agentDir = getAgentDir()): void {
  mkdirSync(agentDir, { recursive: true });
  state.proposals = state.proposals.slice(-100);
  const retained = new Set(state.proposals.map((p) => p.id));
  state.notified = state.notified.filter((id) => retained.has(id));
  writePrivateFileAtomicSync(join(agentDir, ASSISTANT_STATE_FILE), `${JSON.stringify(state)}\n`);
}
/** Only synchronous field-level updates: never replace state captured before asynchronous work. */
export function updateAssistantState<T>(mutate: (state: AssistantState) => T, agentDir = getAgentDir()): T {
  const state = readAssistantState(agentDir);
  const result = mutate(state);
  saveAssistantState(state, agentDir);
  return result;
}
export function routineRevision(routine: Routine): string {
  return createHash("sha256").update(JSON.stringify(routine)).digest("hex");
}
const fence = /^[ \t]*(?:>[ \t]*|[-*+] |\d+[.)] )?```routine-proposal([^\r\n]*)\r?\n([\s\S]*?)(^[ \t]*(?:>[ \t]*)?```[ \t]*(?:\r?\n|$)|(?![\s\S]))/gm;
export function visibleAssistantText(text: string): string { return text.replace(fence, "\n").trim(); }
export function extractAssistantProposals(text: string, dir: string, turn: string, now = new Date()): { proposals: AssistantProposal[]; errors: string[] } {
  const proposals: AssistantProposal[] = [];
  const errors: string[] = [];
  for (const match of text.matchAll(fence)) {
    try {
      if (match[1].trim() || !match[3].trim()) throw new Error("Invalid proposal fence");
      const raw = JSON.parse(match[2]);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Proposal must be an object");
      const action: AssistantAction = raw.action;
      if (!["create", "update", "enable", "disable", "run"].includes(action)) throw new Error("Unknown proposal action");
      let before: Routine | undefined;
      if (action !== "create") {
        if (typeof raw.routineId !== "string" || !isRoutineId(raw.routineId)) throw new Error("Invalid routineId");
        before = readRoutine(dir, raw.routineId) ?? undefined;
        if (!before) throw new Error("Routine not found");
      }
      let input: RoutineInput | undefined;
      if (action === "create" || action === "update") {
        const parsed = parseRoutineInput(action === "update" ? { ...before, ...raw } : raw);
        if ("error" in parsed) throw new Error(parsed.error);
        input = parsed.input;
      }
      if (raw.oneOff !== undefined && typeof raw.oneOff !== "boolean") throw new Error("oneOff must be a boolean");
      if (raw.oneOff === true && (action !== "create" || input?.schedule.kind !== "once")) throw new Error("oneOff requires create with a once schedule");
      if (raw.oneOff === true && input) {
        const at = localParts(now, ROUTINE_TIMEZONE);
        input.schedule = { kind: "once", date: at.date, time: at.time };
        input.enabled = true;
      }
      const at = now.toISOString();
      proposals.push({ id: randomUUID(), action, status: "pending", ...(before ? { routineId: before.id, baseRevision: routineRevision(before), before } : {}), ...(input ? { input } : {}), ...(action === "create" ? { oneOff: raw.oneOff === true } : {}), at, changedAt: at, turn });
    } catch { errors.push("제안 메모 형식이 올바르지 않습니다. 다시 요청해 주세요."); }
  }
  return { proposals, errors };
}
export function pendingProposal(state: AssistantState, id: string): AssistantProposal {
  const proposal = state.proposals.find((p) => p.id === id);
  if (!proposal || proposal.status !== "pending") throw new AssistantError("적용할 수 있는 제안이 없거나 이미 처리되었습니다.");
  return proposal;
}
export function cancelAssistantProposal(id: string, agentDir = getAgentDir()): AssistantProposal {
  return updateAssistantState((state) => {
    const proposal = pendingProposal(state, id);
    proposal.status = "cancelled";
    proposal.changedAt = new Date().toISOString();
    return proposal;
  }, agentDir);
}
/** A reservation is persisted before awaiting Git or starting a run. A crash cannot replay the card. */
export async function applyAssistantProposal(dir: string, id: string, agentDir = getAgentDir(), run?: (dir: string, routine: Routine) => boolean): Promise<AssistantProposal> {
  const proposal = updateAssistantState((state) => {
    const current = pendingProposal(state, id);
    current.status = "applying";
    current.result = "적용하는 중입니다. 이 상태가 계속되면 루틴 목록에서 반영되었는지 확인한 뒤 다시 요청해 주세요.";
    current.changedAt = new Date().toISOString();
    return current;
  }, agentDir);
  const persistResult = () => updateAssistantState((state) => {
    const current = state.proposals.find((p) => p.id === id);
    if (current) Object.assign(current, { status: proposal.status, routineId: proposal.routineId, result: proposal.result, changedAt: proposal.changedAt });
  }, agentDir);
  try {
    const manualRun = run ?? startManualRoutineRun;
    const routine = await commitRoutineChange(dir, `routine-assistant: ${proposal.action} ${proposal.routineId ?? proposal.input?.name}`, () => {
      let current: Routine | null = null;
      if (proposal.action !== "create") {
        current = readRoutine(dir, proposal.routineId!);
        if (!current) throw new AssistantError("해당 루틴을 찾을 수 없습니다.", 404);
        if (routineRevision(current) !== proposal.baseRevision) throw new AssistantError("그사이 루틴이 변경되었습니다. 다시 요청해 주세요.");
      }
      if (proposal.action === "run") {
        if (!manualRun(dir, current!)) throw new AssistantRetryError("이전 실행을 처리하고 있습니다. 잠시 후 같은 카드를 다시 적용해 주세요.");
        return { paths: [], result: current! };
      }
      const now = new Date().toISOString();
      const next: Routine = proposal.action === "create"
        ? { ...proposal.input!, id: newRoutineId(new Date()), timezone: ROUTINE_TIMEZONE, createdAt: now, updatedAt: now }
        : proposal.action === "update"
          ? { ...current!, ...proposal.input!, timezone: ROUTINE_TIMEZONE, updatedAt: now }
          : { ...current!, enabled: proposal.action === "enable", timezone: ROUTINE_TIMEZONE, updatedAt: now };
      if (proposal.action === "create" && proposal.oneOff) {
        const at = localParts(new Date(), ROUTINE_TIMEZONE);
        next.schedule = { kind: "once", date: at.date, time: at.time };
        next.enabled = true;
      }
      if (current && (proposal.action === "enable" || proposal.action === "disable") && current.enabled === next.enabled && current.timezone === next.timezone) return { paths: [], result: current };
      const previous = current ? readFileSync(routinePaths(dir, current.id).json, "utf8") : null;
      return {
        paths: [writeRoutineFile(dir, next)], result: next,
        rollback: () => {
          if (previous === null) rmSync(routinePaths(dir, next.id).folder, { recursive: true, force: true });
          else writeFileSync(routinePaths(dir, next.id).json, previous, "utf8");
        },
      };
    });
    proposal.routineId = routine.id;
    proposal.status = "applied";
    proposal.result = proposal.action === "run" ? `${thisRoutineHost()} PC에서 실행을 시작했습니다.` : "적용됨";
    // Record the created id before the optional run. A failed run must never create a second routine.
    persistResult();
    if (proposal.action === "create" && proposal.oneOff) {
      if (routine.host === thisRoutineHost()) {
        const existingRun = readRoutineRunStates()[routine.id];
        // Only the run start is caught here: a failure must report "saved but not started", never a second create.
        let started = !!(existingRun?.running || existingRun?.lastRun);
        if (!started) {
          try { started = manualRun(dir, routine); }
          catch (error) { console.error("[routine-assistant] run after apply failed", error); }
        }
        proposal.result = started
          ? `${thisRoutineHost()} PC에서 실행을 시작했습니다.`
          : "저장은 완료되었지만 실행을 시작하지 못했습니다. 다시 실행해 주세요.";
      } else proposal.result = `${routine.host} PC가 켜져 있으면 동기화 후 약 10분 안에 시작합니다.`;
    }
    proposal.changedAt = new Date().toISOString();
    persistResult();
    return proposal;
  } catch (error) {
    proposal.changedAt = new Date().toISOString();
    // A committed change stays applied. Only a refusal before any change keeps the card applicable.
    if (proposal.status !== "applied") {
      proposal.status = error instanceof AssistantRetryError ? "pending" : "failed";
      proposal.result = error instanceof Error ? error.message : String(error);
    }
    persistResult();
    throw error;
  }
}
