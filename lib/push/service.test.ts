import assert from "node:assert/strict";
import { test } from "node:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Agent } from "node:https";
import { createRequire } from "node:module";
import * as webPush from "web-push";
import { notifyPushItems, parseSubscription, pushPublicKey, pushSubscriptions, subscribePush, type PushItem, type Subscription } from "./service";

function subscription(endpoint = "https://fcm.googleapis.com/send/test"): Subscription {
  const key = createECDH("prime256v1"); key.generateKeys();
  return { endpoint, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}

test("push initializes without backlog, deduplicates concurrent scans, expires old items and removes 404/410", async () => {
  const dir = mkdtempSync(join(tmpdir(), "push-state-"));
  try {
    const sub = subscription(); subscribePush(sub, dir);
    assert.equal(parseSubscription(sub)?.endpoint, sub.endpoint);
    assert.equal(parseSubscription({ ...sub, endpoint: "https://127.0.0.1/private" }), null);
    assert.equal(parseSubscription({ ...sub, keys: {} }), null);
    const now = Date.now();
    const item = (key: string, time = now): PushItem => ({ key, createdAt: new Date(time).toISOString(), payload: { title: "Routine", body: "Question", url: "/?routine=test&post=file.md", tag: key } });
    const sent: string[] = [];
    const send = async (_sub: Subscription, payload: string) => { sent.push(JSON.parse(payload).tag); };
    await notifyPushItems([item("old")], dir, now, send);
    assert.deepEqual(sent, []);
    await Promise.all([notifyPushItems([item("old"), item("new"), item("expired", now - 86400001)], dir, now, send), notifyPushItems([item("new")], dir, now, send)]);
    assert.deepEqual(sent, ["new"]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const blocked = async () => { calls++; entered.resolve(); await release.promise; };
    const first = notifyPushItems([item("slow")], dir, now, blocked);
    await entered.promise;
    const second = notifyPushItems([item("slow")], dir, now, blocked);
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    console.log("R2-ANT-2 blocked concurrent push calls:", calls);
    for (const code of [404, 410]) {
      subscribePush(sub, dir);
      await notifyPushItems([], dir, now, send);
      await notifyPushItems([item(`gone-${code}`)], dir, now, async () => { throw Object.assign(new Error("gone"), { statusCode: code }); });
      assert.deepEqual(pushSubscriptions(dir), []);
    }
    const key = pushPublicKey(dir);
    assert.equal(pushPublicKey(dir), key);
    for (const file of ["vapid", "subscriptions", "notified"]) assert.equal(statSync(join(dir, `cuelo-webpush-${file}.json`)).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true }); }
});

test("web-push sends actual encrypted aes128gcm under Bun and receiver decrypts the payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "push-transport-"));
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const auth = randomBytes(16);
  const ece = createRequire(import.meta.url)("http_ece");
  const received: string[] = [];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=localhost", "-days", "1"], { stdio: "ignore" });
  const server = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers["content-encoding"], "aes128gcm");
    assert.match(String(req.headers.authorization), /^vapid /);
    received.push(ece.decrypt(Buffer.concat(chunks), { version: "aes128gcm", privateKey: receiver, authSecret: auth }).toString());
    res.writeHead(201); res.end();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  try {
    const addr = server.address(); assert.ok(addr && typeof addr === "object");
    const pair = webPush.generateVAPIDKeys();
    const payload = JSON.stringify({ title: "Encrypted", body: "reply", url: "/?routine=test", tag: "test" });
    await webPush.sendNotification({ endpoint: `https://127.0.0.1:${addr.port}/push`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } }, payload, { agent: new Agent({ rejectUnauthorized: false }), vapidDetails: { subject: "https://example.com", ...pair } });
    assert.deepEqual(received, [payload]);
  } finally {
    const closing = Promise.withResolvers<void>();
    server.close(() => closing.resolve());
    await closing.promise;
    rmSync(dir, { recursive: true });
  }
});
