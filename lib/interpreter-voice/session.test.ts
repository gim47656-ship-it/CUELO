import { expect, test } from "bun:test";
import { VoiceInterpreterSession, type DirectedTranslation, type VoiceUtterance } from "./session";
import { TRANSLATOR_LANGUAGES } from "../translator-languages";
const mine = TRANSLATOR_LANGUAGES[0], theirs = TRANSLATOR_LANGUAGES[3];
function setup() {
  const requests: DirectedTranslation[] = [], finals: VoiceUtterance[] = [], updates: VoiceUtterance[] = [];
  const jobs: PromiseWithResolvers<string>[] = [];
  const session = new VoiceInterpreterSession({ mine, theirs, onUpdate: (item) => updates.push({ ...item }), onFinal: (item) => finals.push({ ...item }),
    translate: (request) => { requests.push(request); const job = Promise.withResolvers<string>(); jobs.push(job); return job.promise; } });
  return { session, requests, finals, updates, jobs };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
test("source is immediate and voice assignment wins over mixed-language text", async () => {
  const { session, requests, updates, jobs } = setup();
  session.open({ id: 0, startMs: 0, endMs: 1000, side: "them" });
  session.transcript("item-a", "김치찌개 ", false);
  expect(updates.at(-1)?.text).toBe("김치찌개 ");
  expect(updates.at(-1)?.side).toBe("them");
  session.transcript("item-a", "この店の김치찌개を二つください", true);
  expect([requests[0].source, requests[0].target]).toEqual(["ja", "ko"]);
  jobs[0].resolve("김치찌개 두 개 주세요."); await session.whenIdle();
});
test("ASR finals and translations finishing out of order still commit in audio order", async () => {
  const { session, requests, finals, jobs } = setup();
  session.open({ id: 0, startMs: 0, endMs: 1000, side: "me" }); session.committed("a");
  session.open({ id: 1, startMs: 1100, endMs: 2000, side: "them" }); session.committed("b");
  session.transcript("b", "二つください", true);
  session.transcript("a", "얼마예요", true);
  expect(requests.map((r) => r.source)).toEqual(["ja", "ko"]);
  jobs[0].resolve("두 개 주세요"); await tick();
  expect(finals).toEqual([]);
  jobs[1].resolve("いくらですか"); await session.whenIdle();
  expect(finals.map((x) => [x.id, x.translation])).toEqual([[0, "いくらですか"], [1, "두 개 주세요"]]);
});
test("an empty transcript and a failed translation cannot block the following recognized turn", async () => {
  const { session, finals, jobs } = setup();
  for (let id = 0; id < 3; id++) { session.open({ id, startMs: id * 1000, endMs: (id + 1) * 1000, side: "me" }); session.committed(String(id)); }
  session.transcript("0", "", true);
  session.transcript("1", "첫 문장", true);
  session.transcript("2", "다음 문장", true);
  await tick(); jobs[0].reject(new Error("provider")); await tick();
  jobs[1].resolve("次の文"); await session.whenIdle();
  expect(finals.map((x) => [x.id, !!x.translationError])).toEqual([[0, false], [1, true], [2, false]]);
  expect(session.utterances.get(1)?.text).toBe("첫 문장");
});
test("speaker correction cancels stale translation and re-translates with the opposite direction", async () => {
  const { session, requests, finals, jobs } = setup();
  session.open({ id: 0, startMs: 0, endMs: 1000, side: "me" });
  session.transcript("a", "はい", true); session.correct(0, "them");
  expect(requests[0].signal.aborted).toBe(true);
  expect([requests[1].source, requests[1].target]).toEqual(["ja", "ko"]);
  jobs[1].resolve("네"); await tick(); expect(finals).toEqual([]);
  jobs[0].resolve("stale"); await session.whenIdle();
  expect(finals.map((x) => x.translation)).toEqual(["네"]);
});
test("same-speaker previous chunk is context; another speaker is excluded", async () => {
  const { session, requests, jobs } = setup();
  for (const [id, side, text] of [[0, "me", "첫 문장"], [1, "them", "違います"], [2, "me", "그 다음"]] as const) {
    session.open({ id, startMs: id * 1000, endMs: id * 1000 + 900, side }); session.committed(String(id));
    session.transcript(String(id), text, true); jobs.at(-1)!.resolve("translated"); await session.whenIdle();
  }
  expect(requests[2].previous).toEqual(["첫 문장"]);
});
test("chain2 R2-ADV-3: a late transcript for a closed utterance does not translate it again", async () => {
  const { session, requests, jobs } = setup();
  session.open({ id: 0, startMs: 0, endMs: 500, side: "me" }); session.committed("a");
  session.transcript("a", "얼마", false); session.failed("a");
  jobs[0].resolve("いくら"); await session.whenIdle();
  session.transcript("a", "얼마예요", true); await tick();
  expect(requests).toHaveLength(1);
});
