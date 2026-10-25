import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
  groupOAuthLogins,
  pickOAuthLoginId,
  type OAuthLoginGroup,
  type ProviderCredentialType,
  type ProviderListingInput,
} from "@/lib/provider-listing";
import { getOmpRuntime, type OmpRuntime } from "@/lib/omp-runtime";

/**
 * Providers whose only declared login is OAuth but whose transport still takes
 * a pasted raw key. Snowflake's `custom` login is OAuth, yet a bare PAT stored
 * as the key works (pi-ai `registry/snowflake.ts` `parseSnowflakeCredential`
 * treats non-JSON as a PAT). No catalog field separates it from openai-codex.
 */
const RAW_KEY_DESPITE_OAUTH_LOGIN: Record<string, true> = { snowflake: true };

/** Available OAuth-registry logins with the auth-policy facts the listing reads. */
function availableOAuthLogins(): Map<string, OAuthLoginGroup> {
  return groupOAuthLogins(
    getOAuthProviders()
      .filter((provider) => provider.available)
      .map((provider) => {
        const policy = authPolicyFor(provider.id);
        const kind = policy?.login?.kind;
        return {
          id: provider.id,
          name: provider.name,
          storedAs: provider.storeCredentialsAs ?? provider.id,
          yieldsApiKey: kind === "api-key" || policy?.result === "api-key",
          callbackFree: kind === "device-code" || (kind === "custom" && policy?.callbackPort === undefined),
        };
      }),
  );
}

/**
 * True when every login the core declares for `id` is OAuth: no `api-key`
 * login, no key result, and no environment credential in its auth policy.
 * Such a provider (openai-codex, google-antigravity, google-gemini-cli) has no
 * API key to paste, even though it has models.
 */
function declaresOnlyOAuth(id: string, group: OAuthLoginGroup | undefined): boolean {
  if (!group || Object.hasOwn(RAW_KEY_DESPITE_OAUTH_LOGIN, id)) return false;
  if ([group.primary, ...group.alternatives].some((login) => login.yieldsApiKey)) return false;
  const env = authPolicyFor(id)?.env;
  return !(env && "vars" in env && env.vars.length > 0);
}

/**
 * Adapter between omp's runtime services and the pure listing helpers in
 * `lib/provider-listing.ts`.
 *
 * omp splits what pi kept in one `ModelRuntime`: the model catalog lives in
 * `ModelRegistry` / `@oh-my-pi/pi-catalog`, OAuth capability lives in the
 * `pi-ai` OAuth registry, and credentials live in `AuthStorage` (SQLite). This
 * folds those three back into the flat shape the listing helpers expect.
 */
export async function collectProviderListingInputs(): Promise<ProviderListingInput[]> {
  const { modelRegistry, authStorage } = await getOmpRuntime();
  return buildProviderListingInputs(modelRegistry.getAll(), authStorage);
}

/** The credential-store reads the listing needs. */
interface ListingAuthStorage {
  credentials: Pick<OmpRuntime["authStorage"]["credentials"], "list">;
  keys: Pick<OmpRuntime["authStorage"]["keys"], "source">;
}

/**
 * The listing over the given models and credential store, read against the
 * SDK's real OAuth registry and catalog. Exported as the test seam, so tests
 * need no process-wide module mock of the omp runtime.
 */
export function buildProviderListingInputs(
  models: readonly { provider: string }[],
  authStorage: ListingAuthStorage,
): ProviderListingInput[] {
  const modelCounts = new Map<string, number>();
  for (const model of models) {
    modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
  }

  // An OAuth login may store its credential under a different provider id
  // (e.g. `openai-codex-device` ⇒ `openai-codex`); key by the id the model
  // catalog actually uses so a logged-in provider is not listed twice.
  const oauthByProvider = availableOAuthLogins();

  const descriptorsById = new Map(PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.providerId, descriptor]));
  const ids = new Set<string>([
    ...modelCounts.keys(),
    ...oauthByProvider.keys(),
    ...descriptorsById.keys(),
  ]);

  const credentialTypes = new Map<string, ProviderCredentialType>();
  for (const id of ids) {
    const stored = authStorage.credentials.list(id);
    const type: ProviderCredentialType | undefined = stored.some((entry) => entry.credential.type === "oauth")
      ? "oauth"
      : stored.length > 0
        ? "api_key"
        : undefined;
    if (type) credentialTypes.set(id, type);
  }

  return [...ids].sort().map((id) => {
    const group = oauthByProvider.get(id);
    const oauth = group?.primary;
    const deviceLogin = group?.alternatives.find((login) => login.callbackFree);
    const origin = authStorage.keys.source(id);
    return {
      id,
      name: oauth?.name ?? id,
      // Catalog providers with a model-manager descriptor accept a bearer key;
      // other providers with models do too unless they declare only OAuth logins.
      hasApiKeyLogin: descriptorsById.has(id) || (modelCounts.has(id) && !declaresOnlyOAuth(id, group)),
      hasOAuth: Boolean(oauth),
      ...(oauth?.name ? { oauthName: oauth.name } : {}),
      ...(deviceLogin ? { deviceLoginId: deviceLogin.id } : {}),
      status: {
        configured: origin !== undefined,
        ...(origin?.kind ? { source: origin.kind } : {}),
      },
      ...(credentialTypes.has(id) ? { credentialType: credentialTypes.get(id) } : {}),
      modelCount: modelCounts.get(id) ?? 0,
    };
  });
}

/**
 * The OAuth login id to start for `provider`: its primary login, or an explicit
 * alternative `requested` id that stores under `provider`. Anything else is
 * undefined, so a caller cannot start an unrelated provider's login.
 */
export function resolveOAuthLoginId(provider: string, requested?: string | null): string | undefined {
  return pickOAuthLoginId(availableOAuthLogins(), provider, requested);
}
