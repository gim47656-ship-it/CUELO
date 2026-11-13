import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { getLabPlugin } from "../plugin-lab";
import { getOmpRuntime } from "../omp-runtime";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { CHECKER_MODEL, type CheckerContext, parseRoutineModel, selectRoutineModel } from "../../Tools/OMP_Global_Config/agent/cuelo-plugins/routine-model/policy";

export async function routineModelSettings(override?: string | null, agentDir = getAgentDir()) {
  const plugin = await getLabPlugin("routine-model", agentDir);
  if (!plugin?.enabled || plugin.problem) return { enabled: false, model: undefined };
  if (override) {
    parseRoutineModel(override);
    return { enabled: true, model: override };
  }
  let pcModel: string | undefined;
  try {
    const value = JSON.parse((await readFile(join(agentDir, "routine-model.json"), "utf8")).replace(/^\uFEFF/, ""));
    if (value.model !== undefined && value.model !== null && value.model !== "") {
      if (typeof value.model !== "string") throw new Error(`model must be a string: ${JSON.stringify(value.model).slice(0, 300)}`);
      const selected = value.model.trim();
      parseRoutineModel(selected);
      pcModel = selected;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`routine-model.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { enabled: true, model: selectRoutineModel(true, override, pcModel) };
}

/** A single direct completion: no session, tools, transcript, role fallback or retries. */
export async function runRoutineChecker(context: CheckerContext, signal: AbortSignal): Promise<string> {
  const { modelRegistry } = await getOmpRuntime();
  const ref = parseRoutineModel(CHECKER_MODEL);
  const model = modelRegistry.find(ref.provider, ref.modelId);
  if (!model) throw new Error(`checker model unavailable: ${CHECKER_MODEL}`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No credentials for ${CHECKER_MODEL}` : auth.error);
  const response = await completeSimple(model, context, {
    apiKey: auth.apiKey, headers: auth.headers, signal, maxTokens: 8192, disableReasoning: true,
    sessionId: crypto.randomUUID(), cacheRetention: "none",
  });
  if (response.stopReason !== "stop") throw new Error(`checker ${response.stopReason}: ${response.errorMessage ?? "incomplete answer"}`);
  return response.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
}
