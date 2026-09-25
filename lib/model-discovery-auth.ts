import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { getOmpRuntime } from "./omp-runtime";

export interface ModelDiscoveryAuth {
  apiKey?: string;
  headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function resolveModelDiscoveryAuth(
  providerName: string,
  provider: Record<string, unknown>,
): Promise<ModelDiscoveryAuth> {
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "cuelo-model-discovery-"));
    const modelsPath = join(tempDir, "models.json");
    // 모델 목록 조회에는 가짜 모델을 등록하지 않는다. provider 단위 resolver가
    // 저장된 AuthStorage 키와 명시된 config/header 인증을 그대로 해석한다.
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...provider,
          models: [],
        },
      },
    }, null, 2), "utf8");

    // A throwaway registry over the submitted provider config, sharing the real
    // AuthStorage so an already-saved key for this provider still resolves.
    const { authStorage } = await getOmpRuntime();
    const registry = new ModelRegistry(authStorage, modelsPath);
    await registry.refresh("offline");
    const loadError = registry.getError();
    if (loadError) throw new Error(loadError.message);

    const key = await registry.getApiKeyForProvider(providerName, undefined, {
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
    });
    return {
      ...(key && key !== kNoAuth ? { apiKey: key } : {}),
      headers: stringRecord(await registry.getProviderHeaders(providerName)),
    };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
