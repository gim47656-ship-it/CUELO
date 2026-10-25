/**
 * Gemini 통역에 쓸 저장된 Google 자격 고르기. 키 자체는 서버에만 있고 화면은 번호와 이름만 다룬다.
 * 고른 키가 목록에서 사라졌으면 다른 키로 바꾸지 않고 다시 고르게 한다.
 */

export interface GeminiCredential {
  id: number;
  label: string;
}

/** `GET /api/live/interpret/gemini`의 `credentials`. 모양이 틀린 항목은 버린다. */
export function parseGeminiCredentials(body: unknown): GeminiCredential[] {
  if (!body || typeof body !== "object" || !("credentials" in body) || !Array.isArray(body.credentials)) return [];
  return body.credentials.flatMap((item: unknown): GeminiCredential[] => {
    if (!item || typeof item !== "object" || !("id" in item) || !("label" in item)) return [];
    const { id, label } = item;
    return typeof id === "number" && Number.isInteger(id) && typeof label === "string" ? [{ id, label }] : [];
  });
}

/**
 * 이번에 쓸 자격. 저장한 번호가 목록에 있으면 그것, 저장한 번호가 없고 키가 하나뿐이면 그 하나다.
 * 저장한 번호가 목록에 없거나(지웠거나 꺼짐) 여럿 가운데 고르지 않았으면 `null`이고 시작할 수 없다.
 */
export function resolveGeminiCredential(
  saved: number | null,
  credentials: readonly GeminiCredential[],
): { id: number | null; missing: boolean } {
  if (saved !== null) {
    const found = credentials.some((credential) => credential.id === saved);
    return { id: found ? saved : null, missing: !found };
  }
  return { id: credentials.length === 1 ? credentials[0].id : null, missing: false };
}
