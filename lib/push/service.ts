import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import * as webPush from "web-push";
import { writePrivateFileAtomicSync } from "../atomic-file";

export interface PushPayload { title: string; body: string; url: string; tag: string }
export interface PushItem { key: string; createdAt: string; payload: PushPayload }
export type Subscription = webPush.PushSubscription;
interface NoticeState { initialized: boolean; keys: Record<string, string> }
const SUBSCRIPTIONS = "cuelo-webpush-subscriptions.json";
const NOTICES = "cuelo-webpush-notified.json";

function load<T>(dir: string, file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(join(dir, file), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
function save(dir: string, file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}
export function pushPublicKey(dir = getAgentDir()): string {
  return vapid(dir).publicKey;
}
function vapid(dir: string): webPush.VapidKeys {
  const file = "cuelo-webpush-vapid.json";
  let keys = load<webPush.VapidKeys | null>(dir, file, null);
  if (!keys) { keys = webPush.generateVAPIDKeys(); save(dir, file, keys); }
  return keys;
}
export function parseSubscription(raw: unknown): Subscription | null {
  if (!raw || typeof raw !== "object") return null;
  const sub = raw as Subscription;
  try {
    const url = new URL(sub.endpoint);
    // Only browser push services: never turn this endpoint into a server-side URL fetcher.
    const allowed = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    if (!sub.keys || !/^[\w-]+$/.test(sub.keys.p256dh) || !/^[\w-]+$/.test(sub.keys.auth)
      || Buffer.from(sub.keys.p256dh, "base64url").length !== 65 || Buffer.from(sub.keys.auth, "base64url").length !== 16) return null;
    return { endpoint: url.href, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
  } catch { return null; }
}
export function pushSubscriptions(dir = getAgentDir()): Subscription[] {
  return load<Subscription[]>(dir, SUBSCRIPTIONS, []);
}
export function subscribePush(subscription: Subscription, dir = getAgentDir()): void {
  const current = pushSubscriptions(dir);
  pushPublicKey(dir);
  if (!current.length) save(dir, NOTICES, { initialized: false, keys: {} } satisfies NoticeState);
  save(dir, SUBSCRIPTIONS, [...current.filter((s) => s.endpoint !== subscription.endpoint), subscription]);
}
export function unsubscribePush(endpoint: string, dir = getAgentDir()): void {
  save(dir, SUBSCRIPTIONS, pushSubscriptions(dir).filter((s) => s.endpoint !== endpoint));
}

export type PushSender = (sub: Subscription, payload: string, options: webPush.RequestOptions) => Promise<unknown>;
let delivery: Promise<void> = Promise.resolve();
export function notifyPushItems(items: PushItem[], dir = getAgentDir(), now = Date.now(), send: PushSender = webPush.sendNotification): Promise<void> {
  const next = delivery.then(async () => {
    if (!pushSubscriptions(dir).length) return;
    const state = load<NoticeState>(dir, NOTICES, { initialized: false, keys: {} });
    const recent = items.filter((item) => Number.isFinite(Date.parse(item.createdAt)) && now - Date.parse(item.createdAt) <= 24 * 60 * 60_000);
    const fresh = state.initialized ? recent.filter((item) => !state.keys[item.key]) : [];
    // Reserve before transport, not after: concurrent scans or a crash cannot send the same item twice.
    const keys = Object.fromEntries(Object.entries(state.keys).filter(([, at]) => now - Date.parse(at) <= 24 * 60 * 60_000));
    for (const item of recent) keys[item.key] = item.createdAt;
    save(dir, NOTICES, { initialized: true, keys } satisfies NoticeState);
    const pair = vapid(dir);
    for (const item of fresh) {
      for (const sub of pushSubscriptions(dir)) {
        try {
          await send(sub, JSON.stringify(item.payload), { TTL: 86400, timeout: 10_000, vapidDetails: { subject: "https://github.com/gim47656-ship-it/CUELO", ...pair } });
        } catch (error) {
          const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
          if (status === 404 || status === 410) unsubscribePush(sub.endpoint, dir);
          else console.error("[push] notification failed:", error instanceof Error ? error.message : String(error));
        }
      }
    }
  });
  delivery = next.catch(() => undefined);
  return next;
}
