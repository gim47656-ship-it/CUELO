import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LoungeRoomEngine, HOURLY_CALL_LIMIT, parseLoungeAction, type LoungeInvokeRequest } from "./room";
import { createFileLoungeStore, emptyLoungeRecord, type LoungeRecord } from "./store";
import { LOUNGE_MEMBERS } from "./roster";
import { detectMentions, planReply, AUTO_TALK_INTERVAL_MS } from "./scheduler";

function fixture(initial = emptyLoungeRecord()) {
  let record = structuredClone(initial);
  let now = 1_790_000_000_000;
  let saveError = false;
  let busy = false;
  const calls: Array<{ request: LoungeInvokeRequest; resolve: (text: string) => void }> = [];
  const timers = new Map<number, { callback: () => void; at: number }>();
  let timerId = 0;
  const deps = {
    store: { path: "fixture.json", load: () => structuredClone(record), save(next: LoungeRecord) {
      if (saveError) throw new Error("disk fixture error");
      record = structuredClone(next);
    } },
    invoker: { availability: () => ({ ok: true as const }), invoke(request: LoungeInvokeRequest) {
      return new Promise<string>((resolve) => calls.push({ request, resolve }));
    } },
    workingMemberIds: () => new Set<string>(),
    autoTalkBlockReason: () => busy ? "작업중" : undefined,
    now: () => now,
    timers: {
      set(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
      clear(handle: unknown) { timers.delete(handle as number); },
    },
  };
  const room = new LoungeRoomEngine(deps);
  const dispatch = (body: Record<string, unknown>) => {
    const parsed = parseLoungeAction({ requestId: randomUUID(), roomId: "main", ...body });
    if (!parsed.ok) throw new Error(parsed.error);
    return room.dispatch(parsed.action);
  };
  return {
    room, calls, dispatch, deps, timers,
    setSaveError(value: boolean) { saveError = value; },
    setBusy(value: boolean) { busy = value; },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
    enable(extra = {}) { return dispatch({ action: "settings", enabled: true, participants: ["rin", "mio"], ...extra }); },
    stored: () => record,
  };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

test("중복 요청은 동시·재시작 뒤에도 메시지와 호출을 다시 만들지 않는다", async () => {
  const f = fixture(); f.enable();
  const send = { action: "send", text: "@린 안녕", requestId: "same" };
  f.dispatch(send); f.dispatch(send);
  expect(f.calls).toHaveLength(1);
  expect(f.room.snapshot().messages.filter((m) => m.memberId === "user")).toHaveLength(1);
  f.calls[0].resolve("안녕"); await flush();
  const restarted = new LoungeRoomEngine(f.deps);
  const parsed = parseLoungeAction({ ...send, roomId: "main" });
  if (!parsed.ok) throw new Error(parsed.error);
  const result = restarted.dispatch(parsed.action);
  expect("duplicate" in result.body && result.body.duplicate).toBe(true);
  expect(f.calls).toHaveLength(1);
  expect(restarted.snapshot().messages.map((m) => m.text)).toEqual(["@린 안녕", "안녕"]);
  restarted.dispose(); f.room.dispose();
});

test.each(["stop", "off"])("%s 직후 abort되고 늦은 delta·답변·후속 호출을 버린다", async (mode) => {
  const f = fixture(); f.enable({ autoTalk: true });
  f.dispatch({ action: "send", text: "@all 안녕" });
  f.calls[0].request.onText("진행중");
  expect(f.room.currentDelta()).not.toBeNull();
  const before = f.room.generation;
  f.dispatch(mode === "stop" ? { action: "stop" } : { action: "settings", enabled: false });
  expect(f.calls[0].request.signal.aborted).toBe(true);
  expect(f.room.generation).toBeGreaterThan(before);
  f.calls[0].request.onText("늦음"); f.calls[0].resolve("늦은 답변 @미오"); await flush();
  f.advance(15 * 60_000);
  expect(f.calls).toHaveLength(1);
  expect(f.room.snapshot().messages.map((m) => m.memberId)).toEqual(["user"]);
  expect(f.room.currentDelta()).toBeNull();
  expect(f.room.snapshot().run.active).toBe(false);
});

test("stop 저장이 실패해도 provider 취소는 즉시 수행한다", () => {
  const f = fixture(); f.enable(); f.dispatch({ action: "send", text: "@린" });
  f.setSaveError(true);
  expect(f.dispatch({ action: "stop" }).status).toBe(500);
  expect(f.calls[0].request.signal.aborted).toBe(true);
  expect(f.room.snapshot().run.active).toBe(false);
});

test("진행 중 새 멘션도 같은 멤버가 이전 호출 종료 후 답한다(single flight)", async () => {
  const f = fixture(); f.enable();
  f.dispatch({ action: "send", text: "@린 첫말" });
  f.dispatch({ action: "send", text: "@린 새말" });
  expect(f.calls).toHaveLength(1);
  f.calls[0].resolve("첫답"); await flush();
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1].request.userText).toContain("새말");
  f.calls[1].resolve("새답"); await flush(); f.room.dispose();
});

test("시간당 상한은 재시작 후에도 유지되고 조회는 호출하지 않는다", () => {
  const record = emptyLoungeRecord();
  record.settings = { ...record.settings, enabled: true, participants: ["rin"] };
  record.callTimestamps = Array(HOURLY_CALL_LIMIT).fill(1_790_000_000_000);
  const f = fixture(record);
  f.room.snapshot(); f.room.subscribe(() => {}); f.room.currentDelta();
  const result = f.dispatch({ action: "send", text: "@린" });
  expect(result.status).toBe(200);
  expect(f.room.snapshot().run.calls.used).toBe(HOURLY_CALL_LIMIT);
  expect(f.calls).toHaveLength(0); f.room.dispose();
});

test("반응은 토글되고 requestId 재전송은 반응을 되돌리지 않는다", () => {
  const f = fixture(); f.enable(); f.dispatch({ action: "send", text: "안녕" });
  const messageId = f.room.snapshot().messages[0].id;
  const action = { action: "reaction", messageId, emoji: "♥", requestId: "reaction-one" };
  f.dispatch(action); f.dispatch(action);
  expect(f.room.snapshot().messages[0].reactions).toEqual([{ emoji: "♥", by: ["user"] }]);
  f.dispatch({ ...action, requestId: "reaction-two" });
  expect(f.room.snapshot().messages[0].reactions).toEqual([]); f.room.dispose();
});

test("저장 오류는 사용자 메시지/요청 id/provider 호출을 남기지 않는다", () => {
  const f = fixture(); f.enable(); f.setSaveError(true);
  expect(f.dispatch({ action: "send", text: "안녕", requestId: "retryable" }).status).toBe(500);
  expect(f.calls).toHaveLength(0); expect(f.room.snapshot().messages).toEqual([]);
  expect(f.stored().requests.some((r) => r.id === "retryable")).toBe(false);
});

test("손상 기록은 loadError이며 POST 503, 원본 바이트 보존", () => {
  const dir = join(process.cwd(), ".omp/lounge-backend", `corrupt-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "room-main.json");
  const broken = '{"version":1,"messages":'; writeFileSync(path, broken);
  const f = fixture();
  const room = new LoungeRoomEngine({ ...f.deps, store: createFileLoungeStore(path) });
  expect(room.snapshot().loadError).toBeDefined();
  expect(room.dispatch({ action: "stop", requestId: "stop", roomId: "main" }).status).toBe(503);
  expect(readFileSync(path, "utf8")).toBe(broken);
  room.dispose(); f.room.dispose();
});

test("자동 발언은 명시 opt-in·사용자 재개 후만, 작업중/잠든 뒤엔 호출하지 않는다", async () => {
  const f = fixture(); f.enable({ autoTalk: true });
  f.advance(AUTO_TALK_INTERVAL_MS.normal);
  expect(f.calls).toHaveLength(0);
  f.dispatch({ action: "send", text: "안녕" }); f.calls[0].resolve("반가워"); await flush();
  f.calls[1].resolve("나도 반가워"); await flush();
  const afterReply = f.calls.length;
  expect(afterReply).toBe(2);
  f.setBusy(true); f.advance(AUTO_TALK_INTERVAL_MS.normal);
  expect(f.calls).toHaveLength(afterReply);
  expect(f.room.snapshot().room.autoTalkPausedReason).toBe("작업중");
  f.setBusy(false); f.advance(AUTO_TALK_INTERVAL_MS.normal);
  expect(f.calls).toHaveLength(afterReply + 1);
  f.calls[afterReply].resolve("이어서"); await flush();
  f.advance(20 * 60_000);
  expect(f.calls).toHaveLength(afterReply + 1); expect(f.room.snapshot().room.asleep).toBe(true);
  const restarted = new LoungeRoomEngine(f.deps);
  expect(restarted.snapshot().room.asleep).toBe(true);
  restarted.dispose(); f.room.dispose();
});

test("멘션·답장·전원 순서와 web6 제외", () => {
  expect(detectMentions("@린 @MIO @yuki", LOUNGE_MEMBERS)).toEqual(["rin", "mio", "yuki"]);
  const input = { text: "안녕", replyToMemberId: "mio", candidates: LOUNGE_MEMBERS, messages: [], pace: "normal" as const };
  expect(planReply(input).memberIds).toEqual(["mio"]);
  expect(planReply({ ...input, text: "@린" }).memberIds).toEqual(["rin"]);
  const parsed = parseLoungeAction({ action: "settings", requestId: "a", roomId: "main", participants: ["rin", "shion"] });
  expect(parsed.ok && parsed.action.action === "settings" && parsed.action.participants).toEqual(["rin"]);
});

test("호출 불가 멤버를 멘션/답장하면 다른 계정 멤버가 대신 답하지 않는다", () => {
  const input = { text: "@미오 안녕", candidates: LOUNGE_MEMBERS.filter((m) => m.id === "rin"), messages: [], pace: "normal" as const };
  expect(planReply(input).memberIds).toEqual([]);
  expect(planReply({ ...input, text: "안녕", replyToMemberId: "mio" }).memberIds).toEqual([]);
});

test.each([
  "모두가 다 좋을 수는 없지",
  "다들 인사",
  "다들 오늘 바빴겠네",
  "모두 의견이 다르네",
  "다들 말해줘서 고마워",
  "모두 의견 말하지 마",
  "@allergy라는 단어야",
])("F-LOUNGE-EVERYONE 서술/애매한 말은 전원 호출하지 않는다: %s", (text) => {
  const plan = planReply({ text, candidates: LOUNGE_MEMBERS, messages: [], pace: "normal" });
  expect(plan.everyone).toBe(false);
  expect(plan.memberIds).toEqual(["rin", "mio"]);
});

test("응답 수는 속도별 1/2/3명, 명시 멘션은 참여 멤버 6명까지, 한 차례 호출 상한은 6이다", () => {
  const base = { text: "안녕", candidates: LOUNGE_MEMBERS, messages: [] };
  expect(planReply({ ...base, pace: "slow" }).memberIds).toHaveLength(1);
  expect(planReply({ ...base, pace: "normal" }).memberIds).toHaveLength(2);
  expect(planReply({ ...base, pace: "active" }).memberIds).toHaveLength(3);
  const all = LOUNGE_MEMBERS.map((member) => `@${member.id}`).join(" ");
  const plan = planReply({ ...base, text: `${all} 안녕`, pace: "normal" });
  expect(plan.memberIds).toEqual(LOUNGE_MEMBERS.slice(0, 6).map((member) => member.id));
  expect(plan.perTurnLimit).toBe(6);
});

test("기존 20회 사용 기록에서도 21번째 명시 멘션 응답을 시작한다", () => {
  const record = emptyLoungeRecord();
  record.settings = { ...record.settings, enabled: true, participants: ["rin"] };
  record.callTimestamps = Array(20).fill(1_790_000_000_000);
  const f = fixture(record);
  f.room.snapshot(); f.room.subscribe(() => {}); f.room.currentDelta();
  expect(f.dispatch({ action: "send", text: "@린" }).status).toBe(200);
  expect(f.calls).toHaveLength(1);
  expect(f.room.snapshot().run.calls.used).toBe(21);
  f.room.dispose();
});

test.each([
  "@all 안녕", "@everyone", "@모두 안녕",
  "다들 한마디 해봐", "모두 의견 말해줘", "여러분 각자 인사해주세요",
])("F-LOUNGE-EVERYONE 명시 멘션/발언 요청은 전원에게 한 번씩: %s", (text) => {
  const plan = planReply({ text, candidates: LOUNGE_MEMBERS, messages: [], pace: "normal" });
  expect(plan.everyone).toBe(true);
  expect(plan.memberIds).toEqual(LOUNGE_MEMBERS.map((member) => member.id));
  expect(plan.allowFollowUp).toBe(false);
});

test("F-LOUNGE-EVERYONE 서술 속 전체 지칭은 멘션/답장 우선을 바꾸지 않는다", () => {
  const input = { candidates: LOUNGE_MEMBERS, messages: [], pace: "normal" as const };
  expect(planReply({ ...input, text: "@미오 모두가 다 좋을 수는 없지" }).memberIds).toEqual(["mio"]);
  expect(planReply({ ...input, text: "다들 바빴겠네", replyToMemberId: "yuki" }).memberIds).toEqual(["yuki"]);
});

test("계정 재연결은 원자적으로 저장되고 말하던 이전 계정 응답은 폐기한다", async () => {
  const f = fixture();
  const choices = [7, 9].map((credentialId, position) => ({ credentialId, position, label: `계정 ${position + 1}` }));
  const invoker = {
    ...f.deps.invoker,
    account(_member: { id: string }, credentialId?: number) {
      return { credentialId, choices, selectionRequired: !choices.some((choice) => choice.credentialId === credentialId) };
    },
    defaultAccount: () => 7,
  };
  const room = new LoungeRoomEngine({ ...f.deps, invoker });
  const settings = (id: string, accountBindings?: Record<string, number>) => room.dispatch({
    action: "settings", roomId: "main", requestId: id, enabled: true, participants: ["rin"], accountBindings,
  });
  settings("join");
  expect(f.stored().accountBindings).toEqual({ rin: 7 });
  room.dispatch({ action: "send", roomId: "main", requestId: "send", text: "@린" });
  f.setSaveError(true);
  expect(settings("retry", { rin: 9 }).status).toBe(500);
  expect(f.stored().accountBindings.rin).toBe(7);
  expect(f.calls[0].request.signal.aborted).toBe(false);
  f.setSaveError(false);
  expect(settings("retry", { rin: 9 }).status).toBe(200);
  expect(f.stored().accountBindings.rin).toBe(9);
  expect(f.calls[0].request.signal.aborted).toBe(true);
  f.calls[0].resolve("이전 계정 답변"); await flush();
  expect(room.snapshot().messages.map((message) => message.memberId)).toEqual(["user"]);
  expect(settings("invalid", { rin: 999 }).status).toBe(400);
  expect(f.stored().accountBindings.rin).toBe(9);
  const duplicate = settings("retry", { rin: 7 });
  expect("duplicate" in duplicate.body && duplicate.body.duplicate).toBe(true);
  expect(f.stored().accountBindings.rin).toBe(9);
  room.dispose(); f.room.dispose();
});
