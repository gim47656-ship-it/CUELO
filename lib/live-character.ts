import { CHARACTER_ROSTER, providerAccountFace } from "./hanse-resource-client";
import type { AgentSessionLike } from "./omp-types";

/**
 * 통화가 지금 말해야 할 캐릭터 — 이 세션의 Main이 실제로 쓰는 계정에서 정한다.
 *
 * 화면의 얼굴(`useAccountFace`)과 전역 `character-voice` 확장과 같은 규칙이다.
 * 계정이 하나뿐인 provider는 예약된 얼굴, 계정이 여럿인 provider(Anthropic의 RIN·MIO)는
 * **이 세션에 pin된** OAuth 계정의 저장 순서 자리로 고른다. `oauth.accounts(provider, sessionId)`는
 * 그 세션의 sticky credential만 `active`로 표시하므로, 같은 모델을 쓰는 두 세션이 동시에
 * 열려 있어도 각자의 계정으로 갈린다. 아직 pin이 없거나 둘 이상이면 추측하지 않고 `null`이다.
 */
export async function resolveLiveCharacter(
  session: Pick<AgentSessionLike, "model" | "listCurrentProviderOAuthAccounts">,
): Promise<string | null> {
  const provider = session.model?.provider;
  if (!provider) return null;
  const reserved = providerAccountFace(provider);
  if (reserved) return reserved.alias;

  const seats = CHARACTER_ROSTER.filter((entry) => entry.provider === provider && entry.oauthPosition !== undefined);
  if (seats.length === 0 || !session.listCurrentProviderOAuthAccounts) return null;
  let listing;
  try {
    listing = await session.listCurrentProviderOAuthAccounts();
  } catch {
    return null;
  }
  // 조회 중 세션이 다른 provider로 갈아탔으면 그 목록은 이 세션의 지금 계정이 아니다.
  if (!listing || listing.provider !== provider || session.model?.provider !== provider) return null;
  const active = listing.accounts.filter((account) => account.active === true);
  if (active.length !== 1) return null;
  const position = Number.isInteger(active[0].position) ? active[0].position : listing.accounts.indexOf(active[0]);
  return seats.find((entry) => entry.oauthPosition === position)?.alias ?? null;
}
