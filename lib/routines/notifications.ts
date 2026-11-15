import { readdirSync } from "node:fs";
import { join } from "node:path";
import { notifyPushItems, pushSubscriptions, type PushItem } from "../push/service";
import { findTitleHeading } from "./post";
import { isPostFileName, listPosts, readReplies, readRoutines, routinePaths } from "./store";

export function routinePushItems(dir: string, now = Date.now()): PushItem[] {
  const items: PushItem[] = [];
  const recent = (at: string) => Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= 86400000;
  for (const routine of readRoutines(dir)) {
    for (const post of listPosts(dir, routine.id, false)) {
      if (!recent(post.finishedAt || post.startedAt)) continue;
      const key = `${routine.id}/${post.file}`;
      items.push({ key, createdAt: post.finishedAt || post.startedAt, payload: {
        title: routine.name, body: `${post.status === "waiting" ? "답이 필요해요: " : ""}${post.title}`,
        url: `/?routine=${encodeURIComponent(routine.id)}&post=${encodeURIComponent(post.file)}`, tag: key,
      } });
    }
    // A new reply may belong to an old post. Scan only existing thread directories.
    let threads: string[];
    try { threads = readdirSync(join(routinePaths(dir, routine.id).folder, "replies")); } catch { continue; }
    for (const stem of threads) {
      const file = `${stem}.md`;
      if (!isPostFileName(file)) continue;
      for (const reply of readReplies(dir, routine.id, file)) {
        if (reply.author !== "agent" || !recent(reply.createdAt)) continue;
        const key = `${routine.id}/${file}/${reply.file}`;
        const title = findTitleHeading(reply.body)?.text ?? reply.body.split("\n").find((line) => line.trim()) ?? routine.name;
        items.push({ key, createdAt: reply.createdAt, payload: {
          title: routine.name, body: `${reply.status === "waiting" ? "답이 필요해요: " : ""}${title}`.slice(0, 240),
          url: `/?routine=${encodeURIComponent(routine.id)}&post=${encodeURIComponent(file)}`, tag: key,
        } });
      }
    }
  }
  return items;
}
export async function notifyRoutineItems(dir: string): Promise<void> {
  if (!pushSubscriptions().length) return Promise.resolve();
  return notifyPushItems(routinePushItems(dir));
}
