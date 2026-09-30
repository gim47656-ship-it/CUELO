import { randomUUID } from "node:crypto";
import { streamSimple, type AuthStorage, type OAuthAccountSummary, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { LoungeUnavailableError, type LoungeInvoker } from "./room";
import type { LoungeMemberSpec } from "./roster";

/** SDK `Effort`는 ambient const enum이라 isolatedModules에서 멤버를 직접 못 쓴다. 고정 SDK의 THINKING_EFFORTS가 low를 포함한다. */
const LOUNGE_EFFORT = THINKING_EFFORTS.find((effort) => String(effort) === "low")!;

export interface LoungeProviderDeps {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /** SDK HTTP transport만 교체하는 검사 경계. 제품에서는 지정하지 않는다. */
  fetch?: SimpleStreamOptions["fetch"];
}

/** 저장 위치는 durable id가 아니다. position 필드를 우선하고 옛 목록에서만 index를 쓴다. */
export function loungeAccount(accounts: readonly OAuthAccountSummary[], member: LoungeMemberSpec): OAuthAccountSummary | undefined {
  const position = member.oauthPosition ?? 0;
  return accounts.find((account, index) => (Number.isInteger(account.position) ? account.position : index) === position);
}

/**
 * AgentSession을 만들지 않는다. registry의 모델과 AuthStorage의 인증만 재사용한다.
 * OAuth는 선택한 row를 accessById로 해석해 고정 bearer로 streamSimple에 전달한다.
 * invocation 전용 affinity는 usage header 귀속만 위한 것이며 작업 session pin을 건드리지 않는다.
 */
export function createLoungeInvoker({ authStorage, modelRegistry, fetch: transport }: LoungeProviderDeps): LoungeInvoker {
  let inventoryReady = false;
  let inventoryGeneration = -1;
  let refreshing: Promise<void> | undefined;
  let ambiguousProviders = new Set<string>();
  const needsOAuth = (member: LoungeMemberSpec) =>
    member.oauthPosition !== undefined || authPolicyFor(member.provider)?.login?.kind === "oauth-code"
    || authStorage.oauth.accounts(member.provider).length > 0 || ambiguousProviders.has(member.provider);
  const refreshAccounts = (): Promise<void> => {
    refreshing ??= (async () => {
      inventoryReady = false;
      try {
        await authStorage.credentials.revalidate();
        const disabled = await authStorage.credentials.listDisabled();
        ambiguousProviders = new Set(disabled.filter((entry) => entry.type === "oauth").map((entry) => entry.provider));
        inventoryGeneration = authStorage.credentials.generation;
        inventoryReady = true;
      } catch {
        // 계정 목록을 확인하지 못하면 신규 자동 binding과 OAuth 호출을 허용하지 않는다.
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return {
    refreshAccounts,
    account(member, credentialId) {
      if (!needsOAuth(member) && credentialId === undefined) return undefined;
      const choices = authStorage.oauth.accounts(member.provider).map((entry, index) => {
        const position = Number.isInteger(entry.position) ? entry.position : index;
        return { credentialId: entry.credentialId, position, label: `계정 ${position + 1} · ID ${entry.credentialId}` };
      });
      return { credentialId, choices: inventoryReady ? choices : [],
        selectionRequired: !inventoryReady || !choices.some((choice) => choice.credentialId === credentialId) };
    },
    defaultAccount(member) {
      if (!inventoryReady || inventoryGeneration !== authStorage.credentials.generation
        || ambiguousProviders.has(member.provider) || !needsOAuth(member)) return undefined;
      return loungeAccount(authStorage.oauth.accounts(member.provider), member)?.credentialId;
    },
    availability(member, credentialId) {
      const model = modelRegistry.find(member.provider, member.model);
      if (!model) return { ok: false, reason: "등록된 모델을 찾지 못했습니다." };
      if (!modelRegistry.hasConfiguredAuth(model)) return { ok: false, reason: "인증된 계정이 없습니다." };
      const accounts = authStorage.oauth.accounts(member.provider);
      const account = accounts.find((entry) => entry.credentialId === credentialId);
      if (needsOAuth(member) || credentialId !== undefined) {
        if (!inventoryReady) return { ok: false, reason: "계정 목록을 확인하지 못했습니다." };
        if (!account) return { ok: false, reason: credentialId === undefined
          ? "단톡방 전용 계정을 선택하세요. 계정 자리만으로는 연결을 확정할 수 없습니다."
          : "연결한 계정이 비활성화되었거나 없어졌습니다. 사용할 계정을 다시 선택하세요." };
      }
      if (account && authStorage.blocks.list([account.credentialId]).some((entry) =>
        entry.blockedUntilMs > Date.now()
        && (entry.blockScope === "" || entry.blockScope === `model:${model.id}`))) {
        return { ok: false, reason: "사용량 한도로 계정이 일시 차단됐습니다." };
      }
      return { ok: true };
    },
    async invoke(request) {
      const { member } = request;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]);
      signal.throwIfAborted();
      await refreshAccounts();
      signal.throwIfAborted();
      const model = modelRegistry.find(member.provider, member.model);
      if (!model || !modelRegistry.hasConfiguredAuth(model)) throw new LoungeUnavailableError("모델 또는 인증을 사용할 수 없습니다.");
      const invocationId = `cuelo-lounge:${randomUUID()}`;
      const accounts = authStorage.oauth.accounts(member.provider);
      const account = accounts.find((entry) => entry.credentialId === request.credentialId);
      if ((needsOAuth(member) || request.credentialId !== undefined) && (!inventoryReady || !account)) {
        throw new LoungeUnavailableError("연결한 계정을 사용할 수 없습니다. 단톡방 전용 계정을 다시 선택하세요.");
      }
      let text = "";
      try {
        let apiKey: string | undefined;
        let credentialId: number | undefined;
        if (account) {
          credentialId = account.credentialId;
          if (!authStorage.sessions.pin(member.provider, invocationId, credentialId)
            || !authStorage.oauth.accounts(member.provider, invocationId).some((entry) => entry.credentialId === credentialId && entry.active)) {
            throw new LoungeUnavailableError("단톡방 전용 계정 연결을 확인하지 못했습니다.");
          }
          const access = await authStorage.oauth.accessById(member.provider, credentialId, {
            modelId: model.id, baseUrl: model.baseUrl, signal,
          });
          signal.throwIfAborted();
          if (!access?.ok || access.credentialId !== credentialId) throw new LoungeUnavailableError("지정한 계정의 인증을 갱신하지 못했습니다.");
          // SDK getOAuthApiKey와 같은 catalog serialization 정책. refresh token은 요청에 불필요하며 노출하지 않는다.
          apiKey = authPolicyFor(member.provider)?.apiKeyFormat === "structured"
            ? JSON.stringify({ token: access.accessToken, accountId: access.accountId, projectId: access.projectId,
                enterpriseUrl: access.enterpriseUrl, email: access.email, apiEndpoint: access.apiEndpoint })
            : access.accessToken;
        } else {
          const resolved = await modelRegistry.getApiKeyWithCredentialForProvider(member.provider, invocationId, {
            modelId: model.id, baseUrl: model.baseUrl, signal,
          });
          apiKey = resolved?.apiKey;
          credentialId = resolved?.credentialId;
        }
        signal.throwIfAborted();
        if (!apiKey) throw new LoungeUnavailableError("인증 정보를 사용할 수 없습니다.");
        if (credentialId !== undefined) {
          const block = authStorage.blocks.list([credentialId]).find((entry) =>
            entry.blockedUntilMs > Date.now()
            && (entry.blockScope === "" || entry.blockScope === `model:${model.id}`));
          if (block) throw new LoungeUnavailableError("사용량 한도로 계정이 일시 차단됐습니다.", block.blockedUntilMs);
        }
        // exact accessById는 자체적으로 quota를 검사하지 않는다. 5h를 포함한 코어 health를 별도로 확인한다.
        const health = await authStorage.health.model(member.provider, {
          modelId: model.id, baseUrl: model.baseUrl, sessionId: invocationId, reserveFraction: 0, signal,
        });
        signal.throwIfAborted();
        const selectedHealth = credentialId === undefined ? undefined : health.accounts.find((entry) => entry.credentialId === credentialId);
        if (selectedHealth?.state === "depleted" || (!selectedHealth && health.state === "depleted")) {
          throw new LoungeUnavailableError("사용량 한도에 도달했습니다. 해제 후 다시 참여할 수 있습니다.", selectedHealth?.resetsAt);
        }
        const headers = await modelRegistry.resolveModelHeaders(model, signal);
        signal.throwIfAborted();
        let headerError = false;
        const stream = streamSimple(model, {
          systemPrompt: [request.systemPrompt],
          messages: [{ role: "user", content: request.userText, timestamp: Date.now() }],
          tools: [],
        }, {
          apiKey, credentialId, headers, signal, sessionId: invocationId,
          maxTokens: 512, reasoning: LOUNGE_EFFORT, cacheRetention: "none", statefulResponses: false,
          codexSseMaxAttempts: 1, acceptEmptyResponse: true, maxRetryDelayMs: 1,
          ...(transport ? { fetch: transport } : {}),
          onResponse(response) {
            try {
              authStorage.usage.ingestHeaders(member.provider, response.headers, {
                sessionId: invocationId, baseUrl: model.baseUrl, responseStatus: response.status,
              });
            } catch {
              headerError = true;
            }
          },
        });
        for await (const event of stream) {
          signal.throwIfAborted();
          if (event.type === "text_delta") {
            text += event.delta;
            request.onText(text);
          } else if (event.type === "error") {
            // provider 원문을 사유에 남긴다. 고정 문구만 남기면 라이브에서만 나는 실패를 진단할 수 없다.
            const detail = event.error.errorMessage?.trim().slice(0, 300);
            throw new LoungeUnavailableError(`모델 응답을 받지 못했습니다${detail ? `: ${detail}` : ". 인증·사용량·연결 상태를 확인하세요."}`);
          } else if (event.type === "done") {
            authStorage.usage.observe({ provider: member.provider, model: model.id, usage: event.message.usage, costUsd: event.message.usage.cost.total });
            text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
          }
        }
        if (headerError) throw new LoungeUnavailableError("사용량 응답을 기록하지 못했습니다.");
        return text;
      } finally {
        authStorage.sessions.release(member.provider, invocationId);
      }
    },
  };
}
