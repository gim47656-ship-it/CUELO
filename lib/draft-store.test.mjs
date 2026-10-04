import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  beginDraftUpload,
  clearDraft,
  flushDraftReferences,
  getDraftAttachmentId,
  holdSubmittedAttachments,
  rekeyDraft,
  releaseUploadedAttachment,
  restoreDraftSubmission,
  setDraft,
  setDraftReferenceSender,
} = await jiti.import("./draft-store.ts");

let nextKey = 0;
const freshKey = () => `test:draft-refs:${++nextKey}`;
const attachmentId = (n) => `att_${n.toString(16).padStart(32, "0")}`;
const storedDocument = (id) => ({
  name: `${id}.wav`,
  mimeType: "text/plain",
  size: 40,
  text: `File saved at: /tmp/${id}.wav`,
  attachmentId: id,
});
const draftWith = (...ids) => ({ value: "note", images: [], documents: ids.map(storedDocument) });

/**
 * Records reference updates. `fail` maps a draftId to how many of its next updates the server
 * rejects; `sent` keeps each update's `sentAttachmentIds`; `gate`, when set, holds every update open.
 */
function recorder() {
  const calls = [];
  const sent = [];
  const fail = new Map();
  const control = { calls, sent, fail, gate: null };
  setDraftReferenceSender(async (draftId, ids, sentIds) => {
    calls.push([draftId, [...ids]]);
    sent.push([draftId, [...sentIds]]);
    if (control.gate) await control.gate;
    const remaining = fail.get(draftId) ?? 0;
    if (remaining > 0) {
      fail.set(draftId, remaining - 1);
      throw new Error("rejected");
    }
  });
  return control;
}

async function settle() {
  await Promise.resolve();
  await flushDraftReferences();
}

test("typing into a draft with attachments sends nothing new", async () => {
  const { calls } = recorder();
  const key = freshKey();
  setDraft(key, draftWith(attachmentId(1)));
  await settle();
  const draftId = getDraftAttachmentId(key);
  assert.deepEqual(calls, [[draftId, [attachmentId(1)]]]);

  setDraft(key, { ...draftWith(attachmentId(1)), value: "note, longer" });
  await settle();
  assert.equal(calls.length, 1);
  clearDraft(key);
  await settle();
});

test("removing a chip releases it from the draft", async () => {
  const { calls } = recorder();
  const key = freshKey();
  setDraft(key, draftWith(attachmentId(2), attachmentId(3)));
  await settle();
  setDraft(key, draftWith(attachmentId(3)));
  await settle();
  const draftId = getDraftAttachmentId(key);
  assert.deepEqual(calls.at(-1), [draftId, [attachmentId(3)]]);
  clearDraft(key);
  await settle();
  assert.deepEqual(calls.at(-1), [draftId, []]);
});

test("a sent message keeps its attachments listed until the server accepts it", async () => {
  const { calls } = recorder();
  const key = freshKey();
  const documents = draftWith(attachmentId(4)).documents;
  setDraft(key, draftWith(attachmentId(4)));
  await settle();
  const release = holdSubmittedAttachments(key, documents);
  clearDraft(key);
  await settle();
  assert.equal(calls.length, 1, "clearing the composer on send must not release the attachment");

  release("unknown");
  await settle();
  assert.equal(calls.length, 1, "an unclear outcome keeps the protection");

  const second = holdSubmittedAttachments(key, documents);
  second("accepted");
  await settle();
  assert.equal(calls.length, 1, "the earlier unclear submission still protects it");
});

test("an accepted submission releases what no draft holds any more", async () => {
  const { calls } = recorder();
  const key = freshKey();
  const documents = draftWith(attachmentId(5)).documents;
  setDraft(key, draftWith(attachmentId(5)));
  await settle();
  const draftId = getDraftAttachmentId(key);
  const release = holdSubmittedAttachments(key, documents);
  clearDraft(key);
  release("accepted");
  await settle();
  assert.deepEqual(calls, [[draftId, [attachmentId(5)]], [draftId, []]]);
});

test("an accepted submission hands its attachments off; a removed chip does not", async () => {
  const { sent } = recorder();
  const key = freshKey();
  setDraft(key, draftWith(attachmentId(20), attachmentId(21)));
  await settle();
  const draftId = getDraftAttachmentId(key);

  // The user drops one chip before sending: that one is simply released.
  setDraft(key, draftWith(attachmentId(21)));
  await settle();
  assert.deepEqual(sent.at(-1), [draftId, []]);

  const release = holdSubmittedAttachments(key, draftWith(attachmentId(21)).documents);
  clearDraft(key);
  release("accepted");
  await settle();
  assert.deepEqual(sent.at(-1), [draftId, [attachmentId(21)]]);
});

test("a failed handoff update is sent again with the same handed-off ids", async () => {
  const { sent, fail } = recorder();
  const key = freshKey();
  setDraft(key, draftWith(attachmentId(22)));
  await settle();
  const draftId = getDraftAttachmentId(key);
  const release = holdSubmittedAttachments(key, draftWith(attachmentId(22)).documents);
  clearDraft(key);
  // Reject the first handoff update; the next round must carry the same ids again.
  fail.set(draftId, 1);
  release("accepted");
  await settle();
  const other = freshKey();
  setDraft(other, draftWith(attachmentId(23)));
  await settle();
  const handoffAttempts = sent.filter(([id, ids]) => id === draftId && ids.join() === attachmentId(22));
  assert.ok(handoffAttempts.length >= 2, `expected a retry, saw ${handoffAttempts.length} attempt(s)`);
  const before = sent.length;
  clearDraft(other);
  await settle();
  assert.ok(sent.slice(before).every(([id]) => id !== draftId), "a confirmed handoff is not sent again");
});

test("a submission accepted while a handoff update is in flight is not lost", async () => {
  const control = recorder();
  const key = freshKey();
  setDraft(key, draftWith(attachmentId(24), attachmentId(25)));
  await settle();
  const draftId = getDraftAttachmentId(key);

  const first = holdSubmittedAttachments(key, draftWith(attachmentId(24)).documents);
  setDraft(key, draftWith(attachmentId(25)));
  let open;
  control.gate = new Promise((resolve) => { open = resolve; });
  first("accepted");
  await Promise.resolve();
  await Promise.resolve();
  // The first update is now in flight with [24] handed off; a second message is accepted.
  const second = holdSubmittedAttachments(key, draftWith(attachmentId(25)).documents);
  clearDraft(key);
  second("accepted");
  open();
  control.gate = null;
  await settle();

  const handedOff = new Set(control.sent.filter(([id]) => id === draftId).flatMap(([, ids]) => ids));
  assert.deepEqual([...handedOff].sort(), [attachmentId(24), attachmentId(25)]);
  assert.deepEqual(control.calls.at(-1), [draftId, []]);
  assert.deepEqual(control.sent.at(-1), [draftId, [attachmentId(25)]]);
});

test("an unclear submission is never reported as handed off", async () => {
  const { sent } = recorder();
  const key = freshKey();
  setDraft(key, draftWith(attachmentId(26)));
  await settle();
  const release = holdSubmittedAttachments(key, draftWith(attachmentId(26)).documents);
  clearDraft(key);
  release("unknown");
  await settle();
  assert.ok(sent.every(([, ids]) => !ids.includes(attachmentId(26))));
});

test("a returned submission is back in the draft before its hold ends", async () => {
  const { calls } = recorder();
  const key = freshKey();
  const documents = draftWith(attachmentId(6)).documents;
  setDraft(key, draftWith(attachmentId(6)));
  await settle();
  const release = holdSubmittedAttachments(key, documents);
  clearDraft(key);
  restoreDraftSubmission(key, "note", undefined, documents);
  release("returned");
  await settle();
  assert.equal(calls.length, 1, "nothing changes: the restored draft lists the same attachment");
  clearDraft(key);
  await settle();
});

test("rekeying into a draft with its own id releases the old id only after the union is confirmed", async () => {
  const { calls, fail } = recorder();
  const source = freshKey();
  const target = freshKey();
  setDraft(source, draftWith(attachmentId(7)));
  setDraft(target, draftWith(attachmentId(8)));
  await settle();
  const sourceId = getDraftAttachmentId(source);
  const targetId = getDraftAttachmentId(target);
  calls.length = 0;

  // Reject every attempt until the server recovers below.
  fail.set(targetId, Number.POSITIVE_INFINITY);
  rekeyDraft(source, target);
  await settle();
  assert.ok(calls.length >= 1);
  assert.ok(
    calls.every(([id, ids]) => id === targetId && ids.join() === [attachmentId(7), attachmentId(8)].join()),
    "while the union is not confirmed the old listing is never released",
  );
  const failedAttempts = calls.length;
  fail.delete(targetId);

  setDraft(target, { ...draftWith(attachmentId(7), attachmentId(8), attachmentId(9)) });
  await settle();
  assert.deepEqual(calls.slice(failedAttempts), [
    [targetId, [attachmentId(7), attachmentId(8), attachmentId(9)]],
    [sourceId, []],
  ]);
  clearDraft(target);
  await settle();
});

test("an open upload holds back releases and keeps the new file until a draft lists it", async () => {
  const { calls } = recorder();
  const key = freshKey();
  setDraft(key, draftWith(attachmentId(10)));
  await settle();
  const draftId = getDraftAttachmentId(key);

  const upload = await beginDraftUpload(key);
  assert.equal(upload.draftId, draftId);
  clearDraft(key);
  await settle();
  assert.equal(calls.length, 1, "no `[]` may overtake the server's registration of the upload");

  upload.end(attachmentId(11));
  await settle();
  assert.deepEqual(calls.at(-1), [draftId, [attachmentId(11)]]);

  setDraft(key, draftWith(attachmentId(11)));
  await settle();
  assert.equal(calls.length, 2, "adopting the uploaded file changes nothing on the server");

  setDraft(key, { value: "note", images: [], documents: [] });
  await settle();
  assert.deepEqual(calls.at(-1), [draftId, []]);
});

test("an upload whose chip was removed is not kept", async () => {
  const { calls } = recorder();
  const key = freshKey();
  const upload = await beginDraftUpload(key);
  upload.end(attachmentId(12));
  releaseUploadedAttachment(attachmentId(12));
  await settle();
  const draftId = getDraftAttachmentId(key);
  assert.deepEqual(calls.filter(([id]) => id === draftId).at(-1), [draftId, []]);
});

test.after(() => setDraftReferenceSender(null));
