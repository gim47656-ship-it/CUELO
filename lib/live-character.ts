import { CHARACTER_ROSTER, providerAccountFace } from "./hanse-resource-client";
import type { AgentSessionLike } from "./omp-types";

/**
 * 통화가 지금 말해야 할 캐릭터 — 이 세션의 Main이 실제로 쓰는 계정에서 정한다.
 *
 * 화면의 얼굴(`useAccountFace`)과 전역 `character-voice` 확장과 같은 규칙이다.
 * 계정이 하나뿐인 provider는 예약된 얼굴, 계정이 여럿인 provider(Anthropic의 RIN·MIO)는
 * **이 세션에 pin된** OAuth 계정의 저장 순서 자리로 고른다. `oauth.accounts(provider, sessionId)`는
 * 그 세션의 sticky credential만 `active`로 표시하므로, 같은 모델을 쓰는 두 세션이 동시에
 * 열려 있어도 각자의 계정으로 갈린다. 둘 이상이면 추측하지 않고 `null`이다.
 *
 * 첫 요청 전의 새 세션은 아직 pin이 없다. `pinCredential`이 주어지면 그때만 한 번 불러 이 세션의
 * 계정을 정한 뒤 다시 읽는다. 통화 시작은 이것으로 계정을 먼저 정해야 한다. 정하지 못하면 통화가
 * Codex 기본 음성으로 시작하고, 기본 음성은 통화 도중 캐릭터 음성으로 바뀌지 않는다.
 */
export async function resolveLiveCharacter(
  session: Pick<AgentSessionLike, "model" | "listCurrentProviderOAuthAccounts">,
  options: { pinCredential?: () => Promise<unknown> } = {},
): Promise<string | null> {
  const provider = session.model?.provider;
  if (!provider) return null;
  const reserved = providerAccountFace(provider);
  if (reserved) return reserved.alias;

  const seats = CHARACTER_ROSTER.filter((entry) => entry.provider === provider && entry.oauthPosition !== undefined);
  const list = session.listCurrentProviderOAuthAccounts;
  if (seats.length === 0 || !list) return null;
  const activeAccounts = async () => {
    const listing = await list.call(session);
    // 조회 중 세션이 다른 provider로 갈아탔으면 그 목록은 이 세션의 지금 계정이 아니다.
    if (!listing || listing.provider !== provider || session.model?.provider !== provider) return null;
    return { listing, active: listing.accounts.filter((account) => account.active === true) };
  };
  let found;
  try {
    found = await activeAccounts();
    if (found && found.active.length === 0 && options.pinCredential) {
      await options.pinCredential();
      found = await activeAccounts();
    }
  } catch {
    return null;
  }
  if (!found || found.active.length !== 1) return null;
  const [active] = found.active;
  const position = Number.isInteger(active.position) ? active.position : found.listing.accounts.indexOf(active);
  return seats.find((entry) => entry.oauthPosition === position)?.alias ?? null;
}
