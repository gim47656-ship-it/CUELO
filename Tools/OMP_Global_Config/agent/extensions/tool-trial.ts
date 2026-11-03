import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { redactSecrets } from "./lib/cross-review";
import {
  appendEvent,
  createTrial,
  defaultTrialRoot,
  listAllTrials,
  listTrials,
  loadTrial,
  SCHEME_LOCATOR,
  TrialConflictError,
  type Environment,
  type EvidenceRef,
  type ObservedEvent,
  type Outcome,
  type Side,
  type Trial,
} from "./lib/tool-trial-store";

/**
 * tool_trial: 같은 시나리오에서 기존 도구(baseline)와 후보 도구(candidate)를 실제로 돌려 본 결과를 근거 위치와 함께 남기고,
 * 보수적인 참고 판정을 돌려준다. 게이트가 아니며 통과(PASS)를 주지 않는다. 텔레메트리를 훑거나 모델에게 판정을 맡기거나
 * 벤치마크를 대신 돌리지 않는다. 소요 시간으로 성능 개선을 추론하지 않는다.
 */

export interface TrialInput {
  action: "start" | "observe" | "show" | "list" | "past";
  trialId?: string;
  scenario?: string;
  acceptance?: string;
  environment?: Record<string, string>;
  baselineTool?: string;
  baselineVersion?: string;
  candidateTool?: string;
  candidateVersion?: string;
  side?: Side;
  outcome?: Outcome;
  evidence?: string[];
  note?: string;
  expectedRevision?: number;
}

export type VerdictCode =
  | "conflicting-evidence"
  | "environment-mismatch"
  | "candidate-not-run"
  | "baseline-not-run"
  | "candidate-failed-baseline-not-run"
  | "no-added-capability"
  | "added-capability-observed"
  | "candidate-worse-observed"
  | "neither-passed";

type SideStatus = "pass" | "fail" | "unsupported" | "not-run" | "mixed";

const MAX_EVIDENCE = 10;
const MAX_ENV_ENTRIES = 20;
const OUTCOME_LABEL: Record<Outcome, string> = { pass: "통과", fail: "실패", unsupported: "미지원", "not-run": "미실행" };
const SIDE_LABEL: Record<Side, string> = { baseline: "기존", candidate: "후보" };
const STATUS_LABEL: Record<SideStatus, string> = { ...OUTCOME_LABEL, mixed: "상충" };
const VERDICT_TEXT: Record<VerdictCode, string> = {
  "conflicting-evidence": "판단 보류: 같은 쪽에 통과와 실패·미지원 관찰이 함께 있습니다. 반대 증거가 있으면 개선을 주장하지 않습니다.",
  "environment-mismatch": "판단 보류: 기존·후보 관찰의 환경이 서로 다릅니다. 같은 환경에서 다시 관찰해야 비교할 수 있습니다.",
  "candidate-not-run": "판단 보류: 후보 도구 관찰이 없습니다.",
  "baseline-not-run": "판단 보류: 후보는 통과했지만 기존 도구를 돌려 보지 않았습니다. 후보 성공만으로는 개선이 입증되지 않습니다.",
  "candidate-failed-baseline-not-run": "추가 능력 없음: 후보가 통과하지 못했고 기존 도구는 돌려 보지 않았습니다.",
  "no-added-capability": "추가 능력 입증 안 됨: 기존·후보 모두 통과했습니다. 이 시나리오에서 후보만의 가치는 보이지 않았습니다.",
  "added-capability-observed": "이 시나리오·환경·수락 기준에서만 후보가 추가로 해낸 것이 관찰됐습니다. 다른 시나리오나 일반적인 개선으로 넓히지 마세요.",
  "candidate-worse-observed": "후보가 더 못함: 기존은 통과했고 후보는 실패·미지원이었습니다.",
  "neither-passed": "추가 능력 없음: 기존·후보 모두 통과하지 못했습니다.",
};

function envKey(environment: Environment): string {
  return JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)));
}

function sideStatus(observations: readonly ObservedEvent[]): SideStatus {
  const outcomes = new Set(observations.map((item) => item.outcome).filter((outcome) => outcome !== "not-run"));
  if (outcomes.size === 0) return "not-run";
  if (outcomes.has("pass")) return outcomes.size === 1 ? "pass" : "mixed";
  return outcomes.has("fail") ? "fail" : "unsupported";
}

/** 기록된 관찰만으로 정하는 보수적 참고 판정. 근거 내용의 진위는 보지 않는다. */
export function judgeTrial(trial: Trial): { code: VerdictCode; baseline: SideStatus; candidate: SideStatus } {
  const of = (side: Side) => trial.observations.filter((item) => item.side === side);
  const baseline = sideStatus(of("baseline"));
  const candidate = sideStatus(of("candidate"));
  const result = (code: VerdictCode) => ({ code, baseline, candidate });
  if (baseline === "mixed" || candidate === "mixed") return result("conflicting-evidence");
  const counted = trial.observations.filter((item) => item.outcome !== "not-run");
  const environments = new Set(counted.map((item) => envKey({ ...trial.created.environment, ...item.environment })));
  if (baseline !== "not-run" && candidate !== "not-run" && environments.size > 1) return result("environment-mismatch");
  if (candidate === "not-run") return result("candidate-not-run");
  if (baseline === "not-run") return result(candidate === "pass" ? "baseline-not-run" : "candidate-failed-baseline-not-run");
  if (baseline === "pass") return result(candidate === "pass" ? "no-added-capability" : "candidate-worse-observed");
  return result(candidate === "pass" ? "added-capability-observed" : "neither-passed");
}

/** 입력 글을 다듬고 길이·줄바꿈·비밀 모양을 검사한다. 비밀로 보이면 가려 저장하지 않고 거절한다. */
function cleanText(label: string, value: string | undefined, max: number, singleLine: boolean): string {
  const text = (value ?? "").trim();
  if (!text) throw new Error(`${label}을(를) 입력해 주세요.`);
  if (text.length > max) throw new Error(`${label}은(는) ${max}자 이하로 줄여 주세요. 원문 대신 요약과 근거 위치를 남깁니다.`);
  if (singleLine && /[\r\n]/.test(text)) throw new Error(`${label}은(는) 한 줄이어야 합니다.`);
  const secret = redactSecrets(text);
  if (secret.blocked || secret.count > 0 || /:\/\/[^/\s@]+@/.test(text)) throw new Error(`${label}에 비밀로 보이는 값이 있어 기록하지 않았습니다. 값을 빼고 다시 보내 주세요.`);
  return text;
}

function cleanEnvironment(value: Record<string, string> | undefined, required: boolean): Environment {
  const entries = Object.entries(value ?? {});
  if (required && entries.length === 0) throw new Error("environment에 관찰 환경(예: os, host, 대상 앱 버전)을 하나 이상 적어 주세요.");
  if (entries.length > MAX_ENV_ENTRIES) throw new Error(`environment 항목은 ${MAX_ENV_ENTRIES}개 이하로 적어 주세요.`);
  const environment: Environment = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) throw new Error("environment 키는 영문·숫자·_.- 40자 이하여야 합니다.");
    environment[cleanText("environment 키", key, 40, true)] = cleanText(`environment.${key}`, raw, 200, true);
  }
  return environment;
}

/** scheme 위치(artifact://, https:// 등)는 열지 않고 미확인으로 남긴다. 로컬 경로는 줄 선택자를 뗀 뒤 지금 있는지만 본다. */
function cleanEvidence(locators: readonly string[], cwd: string): EvidenceRef[] {
  if (locators.length > MAX_EVIDENCE) throw new Error(`evidence는 ${MAX_EVIDENCE}개 이하로 적어 주세요.`);
  return locators.map((raw) => {
    const locator = cleanText("evidence", raw, 400, true);
    if (SCHEME_LOCATOR.test(locator)) return { locator, check: "unchecked" as const };
    const path = locator.replace(/#.*$/, "").replace(/(?::[\d,+-]+)+$/, "");
    if (!existsSync(isAbsolute(path) ? path : resolve(cwd, path))) throw new Error(`증거 경로가 없습니다: ${locator}`);
    return { locator, check: "local-exists" as const };
  });
}

const comparable = (trial: Trial) => [trial.created.scenario, trial.created.acceptance, trial.created.baseline.tool, trial.created.candidate.tool]
  .map((part) => part.replace(/\s+/g, " ").trim().toLowerCase()).join("\u0000");

function describeTrial(trial: Trial): string[] {
  const { created } = trial;
  const verdict = judgeTrial(trial);
  const unchecked = trial.observations.reduce((sum, item) => sum + item.evidence.filter((ref) => ref.check === "unchecked").length, 0);
  const unknownVersion = [created.baseline.version, created.candidate.version].some((version) => /^unknown$/i.test(version));
  const lines = [
    `시험 ${trial.trialId} (revision ${trial.revision}, 시작 ${created.recordedAt})`,
    `시나리오: ${created.scenario}`,
    `수락 기준: ${created.acceptance}`,
    `환경: ${Object.entries(created.environment).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    `기존: ${created.baseline.tool} ${created.baseline.version} / 후보: ${created.candidate.tool} ${created.candidate.version}`,
    "관찰:",
    ...(trial.observations.length === 0 ? ["  (아직 없음)"] : trial.observations.map((item) => {
      const env = Object.keys(item.environment).length ? ` 환경 변경 ${Object.entries(item.environment).map(([key, value]) => `${key}=${value}`).join(", ")}` : "";
      const refs = item.evidence.map((ref) => `${ref.locator}${ref.check === "unchecked" ? " (미확인)" : ""}`).join(", ");
      return `  r${item.revision} ${item.recordedAt} [${SIDE_LABEL[item.side]}] ${OUTCOME_LABEL[item.outcome]}${env}${refs ? ` 근거: ${refs}` : ""}${item.note ? ` 메모: ${item.note}` : ""}`;
    })),
    `상태: 기존 ${STATUS_LABEL[verdict.baseline]}, 후보 ${STATUS_LABEL[verdict.candidate]}`,
    `참고 판정(${verdict.code}, 게이트 아님): ${VERDICT_TEXT[verdict.code]}`,
    "주의: 근거는 위치만 확인했습니다. 로컬 경로는 기록할 때 있었는지만 봤고, 내용이 관찰 결과를 실제로 뒷받침하는지는 이 도구가 검증하지 않았습니다.",
  ];
  if (unchecked > 0) lines.push(`주의: scheme 위치 근거 ${unchecked}개는 열어 보지 않은 미확인 근거입니다.`);
  if (unknownVersion) lines.push("주의: 버전을 모르는 도구가 있어 같은 버전끼리의 비교라고 볼 수 없습니다.");
  lines.push("주의: 한 번의 소요 시간으로 속도 개선을 판단하지 않습니다. 속도 주장은 같은 조건에서 반복 측정한 근거가 따로 있어야 합니다.");
  return lines;
}

function describePast(current: Trial, all: readonly Trial[]): string[] {
  const key = comparable(current);
  const matches = all.filter((trial) => trial.trialId !== current.trialId && comparable(trial) === key).slice(-10);
  if (matches.length === 0) return ["같은 시나리오·수락 기준·도구 조합의 과거 시험이 없습니다."];
  const lines = ["과거 시험(현재 환경·시점의 증거가 아닙니다. 현재 판정에 합치지 않았습니다):"];
  for (const trial of matches) {
    const envDiff = [...new Set([...Object.keys(current.created.environment), ...Object.keys(trial.created.environment)])]
      .filter((name) => current.created.environment[name] !== trial.created.environment[name]);
    const versions = trial.created.baseline.version === current.created.baseline.version && trial.created.candidate.version === current.created.candidate.version;
    const verdict = judgeTrial(trial);
    lines.push(`  ${trial.trialId} ${trial.created.recordedAt} ${trial.sessionKey === current.sessionKey ? "이 세션" : "다른 세션"}`
      + ` 판정 ${verdict.code} (기존 ${STATUS_LABEL[verdict.baseline]}, 후보 ${STATUS_LABEL[verdict.candidate]})`
      + ` 환경 ${envDiff.length ? `다름: ${envDiff.join(", ")}` : "같음"} 버전 ${versions ? "같음" : "다름"}`);
  }
  return lines;
}

export interface TrialDeps {
  root: string;
  cwd: string;
  sessionId: string | undefined;
  now?: () => Date;
}

export function runToolTrial(input: TrialInput, deps: TrialDeps): { text: string; isError: boolean } {
  try {
    const { sessionId } = deps;
    const trialId = () => cleanText("trialId", input.trialId, 40, true);
    switch (input.action) {
      case "start": {
        const scenario = cleanText("scenario", input.scenario, 1000, false);
        const acceptance = cleanText("acceptance", input.acceptance, 1000, false);
        const environment = cleanEnvironment(input.environment, true);
        const baseline = { tool: cleanText("baselineTool", input.baselineTool, 120, true), version: cleanText("baselineVersion", input.baselineVersion, 120, true) };
        const candidate = { tool: cleanText("candidateTool", input.candidateTool, 120, true), version: cleanText("candidateVersion", input.candidateVersion, 120, true) };
        const trial = createTrial(deps.root, sessionId, (id, recordedAt) => ({
          type: "created", revision: 1, recordedAt, trialId: id, scenario, acceptance, environment, baseline, candidate,
        }), deps.now);
        return { text: [...describeTrial(trial), "다음: 같은 시나리오를 기존·후보 도구로 각각 돌린 뒤 action observe로 결과와 근거 위치를 남기세요."].join("\n"), isError: false };
      }
      case "observe": {
        const id = trialId();
        if (input.side !== "baseline" && input.side !== "candidate") throw new Error("side는 baseline 또는 candidate여야 합니다.");
        const outcome = input.outcome;
        if (!outcome || !Object.hasOwn(OUTCOME_LABEL, outcome)) throw new Error("outcome은 pass, fail, unsupported, not-run 중 하나여야 합니다.");
        if (outcome !== "not-run" && !input.evidence?.length) throw new Error(`${OUTCOME_LABEL[outcome]} 관찰에는 근거 위치(evidence)가 하나 이상 필요합니다. 돌려 보지 않았다면 not-run으로 남기세요.`);
        const environment = cleanEnvironment(input.environment, false);
        const note = input.note?.trim() ? cleanText("note", input.note, 500, false) : undefined;
        const side = input.side;
        // 근거 경로 확인도 전이의 일부라 경합으로 다시 시도할 때마다 새로 한다(기록 시각에 있던 근거만 local-exists로 남긴다).
        const trial = appendEvent(deps.root, sessionId, id, (_current, revision, recordedAt) => ({
          type: "observed", revision, recordedAt, side, outcome, evidence: cleanEvidence(input.evidence ?? [], deps.cwd), environment, ...(note ? { note } : {}),
        }), { expectedRevision: input.expectedRevision, now: deps.now });
        return { text: describeTrial(trial).join("\n"), isError: false };
      }
      case "show":
        return { text: describeTrial(loadTrial(deps.root, sessionId, trialId())).join("\n"), isError: false };
      case "list": {
        const { trials, broken } = listTrials(deps.root, sessionId);
        const lines = trials.length === 0 ? ["이 세션에 시험 기록이 없습니다."] : trials.map((trial) => {
          const verdict = judgeTrial(trial);
          return `${trial.trialId} r${trial.revision} ${trial.created.baseline.tool} → ${trial.created.candidate.tool}: ${verdict.code} — ${trial.created.scenario.replace(/\s+/g, " ").slice(0, 80)}`;
        });
        return { text: [...lines, ...broken.map((message) => `손상된 기록: ${message}`)].join("\n"), isError: broken.length > 0 };
      }
      case "past": {
        const current = loadTrial(deps.root, sessionId, trialId());
        const { trials, broken } = listAllTrials(deps.root);
        return { text: [...describePast(current, trials), ...broken.map((message) => `손상된 기록: ${message}`)].join("\n"), isError: false };
      }
      default:
        throw new Error("action은 start, observe, show, list, past 중 하나여야 합니다.");
    }
  } catch (error) {
    if (error instanceof TrialConflictError) {
      return { text: `기록 충돌: 예상 revision ${error.expected}, 현재 ${error.actual}. 다른 기록이 먼저 들어왔습니다. action show로 최신 상태를 읽고 다시 판단해 주세요.`, isError: true };
    }
    return { text: `tool_trial 실패: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

export default function toolTrial(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool({
    name: "tool_trial", label: "Tool Trial", loadMode: "essential", approval: "read",
    description: "같은 시나리오에서 기존 도구(baseline)와 후보 도구(candidate)를 직접 돌려 본 결과를 근거 위치와 함께 이 세션의 비공개 기록으로 남기고 보수적인 참고 판정을 돌려줍니다. 게이트가 아니며 통과를 주지 않고, 도구를 대신 실행하거나 텔레메트리를 훑거나 모델로 판정하지 않습니다. action: start(scenario·acceptance·environment·baselineTool/Version·candidateTool/Version 필수) → observe(trialId·side·outcome pass|fail|unsupported|not-run·evidence 위치; not-run 외에는 근거 필수; expectedRevision을 주면 다른 기록이 먼저 들어왔을 때 충돌로 멈춤) → show/list. past는 같은 시나리오의 다른 세션 기록을 명시적으로 볼 때만 쓰며 현재 판정에 합치지 않습니다. 판정: 둘 다 통과면 추가 능력 입증 안 됨, 기존 미실행에 후보만 통과면 판단 보류, 기존 실패·미지원에 후보 통과면 그 시나리오에서만 추가 능력 관찰, 상충 관찰·환경 불일치는 판단 보류. 근거는 위치만 확인하고 내용의 진위는 검증하지 않습니다. 속도 개선은 추론하지 않습니다.",
    parameters: z.object({
      action: z.enum(["start", "observe", "show", "list", "past"]),
      trialId: z.string().optional(),
      scenario: z.string().optional(),
      acceptance: z.string().optional(),
      environment: z.record(z.string(), z.string()).optional(),
      baselineTool: z.string().optional(),
      baselineVersion: z.string().optional(),
      candidateTool: z.string().optional(),
      candidateVersion: z.string().optional(),
      side: z.enum(["baseline", "candidate"]).optional(),
      outcome: z.enum(["pass", "fail", "unsupported", "not-run"]).optional(),
      evidence: z.array(z.string()).optional(),
      note: z.string().optional(),
      expectedRevision: z.number().int().optional(),
    }) as never,
    async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const result = runToolTrial(params as TrialInput, { root: defaultTrialRoot(), cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId?.() });
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true as const } : {}) };
    },
  });
}
