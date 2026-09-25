import { invalidateModelsCache } from "@/lib/models-cache";
import { getOmpRuntime, invalidateOmpRuntime } from "@/lib/omp-runtime";
import { resolveOAuthLoginId } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  if (!resolveOAuthLoginId(provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }

  const { authStorage } = await getOmpRuntime();
  const stored = authStorage.credentials.list(provider);
  if (stored.length > 0 && !stored.some((entry) => entry.credential.type === "oauth")) {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }

  // 18.2.11 AuthStorage.logout()은 remove()만 불렀다. 18.3.0에서는 credentials.remove가 같은
  // 삭제·빈 목록·세션 할당 리셋을 수행한다.
  await authStorage.credentials.remove(provider);
  invalidateModelsCache();
  invalidateOmpRuntime();
  return Response.json({ ok: true });
}
