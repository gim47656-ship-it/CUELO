/**
 * The listing adapter against the installed SDK's real OAuth registry and auth
 * policies. Models and the credential store are passed in through the
 * `buildProviderListingInputs` seam; no module is mocked.
 */
import { expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { buildApiKeyProviderList, buildOAuthProviderList } from "./provider-listing";
import { buildProviderListingInputs, resolveOAuthLoginId } from "./provider-listing-runtime";

const MODEL_PROVIDERS = ["openai-codex", "anthropic", "snowflake", "google-gemini-cli", "gitlab-duo"];
const inputs = buildProviderListingInputs(
  MODEL_PROVIDERS.map((provider) => ({ provider })),
  { credentials: { list: () => [] }, keys: { source: () => undefined } },
);

test("openai-codex is named by its primary login, offers the device login, and has no API-key form", () => {
  const codex = inputs.find((input) => input.id === "openai-codex");
  const primaryName = getOAuthProviders().find((login) => login.id === "openai-codex")?.name;

  expect(codex?.name).toBe(primaryName!);
  expect(codex?.hasApiKeyLogin).toBe(false);
  expect(codex?.deviceLoginId).toBe("openai-codex-device");
  expect(buildOAuthProviderList(inputs).find((p) => p.id === "openai-codex")?.deviceLoginId).toBe("openai-codex-device");
  expect(buildApiKeyProviderList(inputs).some((p) => p.id === "openai-codex")).toBe(false);
});

test("OAuth-only providers leave the API-key list; key-accepting ones stay", () => {
  const apiKeyIds = buildApiKeyProviderList(inputs).map((p) => p.id);

  expect(apiKeyIds).not.toContain("google-gemini-cli");
  // anthropic: catalog descriptor; gitlab-duo: auth env GITLAB_TOKEN; snowflake: raw PAT exception.
  expect(apiKeyIds).toEqual(expect.arrayContaining(["anthropic", "gitlab-duo", "snowflake"]));
});

test("an explicit login id is started only when it stores under the requested provider", () => {
  expect(resolveOAuthLoginId("openai-codex")).toBe("openai-codex");
  expect(resolveOAuthLoginId("openai-codex", "openai-codex-device")).toBe("openai-codex-device");
  expect(resolveOAuthLoginId("openai-codex", "anthropic")).toBeUndefined();
  expect(resolveOAuthLoginId("anthropic", "openai-codex-device")).toBeUndefined();
  expect(resolveOAuthLoginId("openai-codex", "no-such-login")).toBeUndefined();
  expect(resolveOAuthLoginId("openai-codex", "")).toBeUndefined();
});
