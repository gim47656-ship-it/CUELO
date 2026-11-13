import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The target SDK is selected at runtime so the same probe can exercise an isolated package copy.
const ai = resolve(process.env.OMP_CORE_PATCH_TARGET ?? "node_modules/@oh-my-pi/pi-coding-agent", "../pi-ai");
const { ResetCredits } = await import(pathToFileURL(resolve(ai, "src/auth/resets.ts")).href);
const { listClaudeResetCredits } = await import(pathToFileURL(resolve(ai, "src/usage/claude-reset.ts")).href);

function fixture() {
  const grants = ["full-reset-2611", "launch-2610-fable-week"].map((id, i) => ({
    id, resets_left: 1, usable_now: true, paused: false, use_requires_limit: false,
    clears: i === 0 ? ["five_hour", "seven_day", "seven_day_overage_included"] : ["five_hour", "seven_day_overage_included"],
    blocking: [],
  }));
  const posts: { grant_id: string; request_id: string }[] = [];
  const state = { ambiguous: false, wrong: false, unreadableAfter: false, rejection: false, omitSpent: false };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      assert.match(url, /\/reset_rate_limits$/);
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (state.ambiguous) throw new Error("lost response");
      if (state.rejection) return Response.json({ error: "grant_not_allowed" }, { status: 400 });
      const grant = grants.find(g => g.id === (state.wrong ? grants[0].id : body.grant_id))!;
      grant.resets_left--;
      return Response.json({ result: "reset" });
    }
    assert.match(url, /\/usage\?/);
    if (state.unreadableAfter && posts.length) return new Response("", { status: 503 });
    const visible = state.omitSpent ? grants.filter(g => g.resets_left > 0) : grants;
    // The provider advances next_grant_id to a remaining grant once the old one disappears.
    return Response.json({ cedar_ember: { eligible: true, next_grant_id: visible[0]?.id ?? null, grants: visible } });
  };
  const access = { ok: true, accessToken: "fixture", orgId: "fixture-org", credentialId: 1 };
  const auth = { ...access, fetch: fetchImpl };
  const invalidations: unknown[] = [];
  const resets = new ResetCredits({
    oauth: { accessById: async () => access },
    usage: { fetch: fetchImpl },
    usageCache: { invalidateAfterReset(...args: unknown[]) { invalidations.push(args); } },
    store: {}, pool: { entries: () => [] }, blocks: {},
  });
  const redeem = (creditId?: string) => resets.redeem({ target: { provider: "anthropic", credentialId: 1, ...(creditId ? { creditId } : {}) } });
  return { auth, grants, posts, state, redeem, invalidations };
}

{
  const f = fixture();
  const list = await listClaudeResetCredits(f.auth);
  assert.equal(list.redeemableCount, 2);
  assert.equal(list.credits[1].usable, true);
  assert.equal(list.nextCreditId, f.grants[0].id);
  assert.equal((await f.redeem(f.grants[1].id)).code, "reset");
  assert.equal(f.posts[0].grant_id, f.grants[1].id);
  assert.equal((await f.redeem(f.grants[0].id)).code, "reset");
  assert.equal(f.posts.length, 2);
  console.log("OK non-next usable grant; exact grant_id; settled sequential grants");
}
{
  const f = fixture();
  assert.equal((await f.redeem("missing")).code, "offer_changed");
  f.grants[1].usable_now = false;
  assert.equal((await f.redeem(f.grants[1].id)).code, "offer_changed");
  assert.equal(f.posts.length, 0);
  assert.equal((await f.redeem()).code, "reset");
  assert.equal(f.posts[0].grant_id, f.grants[0].id);
  console.log("OK absent/unusable refused; omitted credit defaults to next");
}
{
  const f = fixture();
  f.state.ambiguous = true;
  await f.redeem(f.grants[0].id);
  assert.equal((await f.redeem(f.grants[1].id)).code, "reset_unconfirmed");
  assert.equal(f.posts.length, 1);
  f.grants[0].resets_left = 0;
  f.state.ambiguous = false;
  assert.equal((await f.redeem(f.grants[1].id)).code, "reset");
  assert.equal(f.posts.length, 2);
  console.log("OK ambiguous pending blocks other grant; observed settlement releases it");
}
{
  const f = fixture();
  f.grants[0].resets_left = 2;
  f.state.ambiguous = true;
  await f.redeem();
  f.grants[0].resets_left = 1;
  f.state.ambiguous = false;
  assert.equal((await f.redeem()).code, "already_redeemed");
  assert.equal(f.posts.length, 1);
  console.log("OK default retry reconciles spent pending claim without another POST");
}
{
  const f = fixture();
  f.state.ambiguous = true;
  await f.redeem();
  f.grants[0].resets_left = 0;
  f.state.omitSpent = true;
  f.state.ambiguous = false;
  assert.equal((await f.redeem()).code, "reset_unconfirmed");
  assert.equal(f.posts.length, 1);
  assert.equal(f.invalidations.length, 0, "a vanished pending grant is not proof of a spend");
  assert.equal((await f.redeem()).code, "reset_unconfirmed", "later default retries stay blocked");
  assert.equal((await f.redeem(f.grants[0].id)).code, "reset_unconfirmed", "re-picking the vanished grant stays blocked");
  assert.equal((await f.redeem("missing")).code, "offer_changed", "an explicit unknown grant is refused");
  assert.equal((await f.redeem()).code, "reset_unconfirmed", "a refused explicit pick does not release the claim");
  assert.equal(f.posts.length, 1, "unresolved default retries must not POST another grant");
  assert.equal((await f.redeem(f.grants[1].id)).code, "reset", "an explicit other grant is still allowed");
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].grant_id, f.grants[1].id);
  console.log("OK repeated default retries with vanished pending grant send no second POST (#86)");
}
{
  const f = fixture();
  f.state.omitSpent = true;
  const result = await f.redeem();
  assert.equal(result.ok, true);
  assert.equal(result.creditId, f.grants[0].id);
  assert.equal(result.consumedCreditIds, undefined);
  assert.equal(f.posts.length, 1);
  console.log("R2-ANT-2: default success, selected grant omitted, consumedCreditIds = undefined");
}
{
  const f = fixture();
  f.state.wrong = true;
  const result = await f.redeem(f.grants[1].id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumedCreditIds, [f.grants[0].id]);
  assert.equal(result.creditId, f.grants[1].id);
  assert.deepEqual(result.cleared, ["anthropic:5h", "anthropic:7d", "anthropic:7d:fable"]);
  assert.equal(f.posts.length, 1);
  console.log("OK mismatch reports requested and observed consumed grants without retry");
}
{
  const f = fixture();
  f.state.wrong = true;
  f.state.omitSpent = true;
  const result = await f.redeem(f.grants[1].id);
  assert.deepEqual(result.consumedCreditIds, [f.grants[0].id]);
  assert.equal(f.posts.length, 1);
  console.log("OK mismatch detects exhausted grant omitted from readback");
}
{
  const f = fixture();
  f.state.unreadableAfter = true;
  const result = await f.redeem(f.grants[1].id);
  assert.equal(result.ok, true);
  assert.equal(result.consumedCreditIds, undefined);
  assert.equal(f.posts.length, 1);
  console.log("OK unreadable readback preserves success without claiming mismatch");
}
{
  const f = fixture();
  f.state.rejection = true;
  const result = await f.redeem(f.grants[1].id);
  assert.equal(result.code, "http_400");
  assert.match(result.reason, /grant_not_allowed/);
  assert.equal(f.posts.length, 1);
  console.log("OK HTTP rejection keeps provider reason without retry");
}
