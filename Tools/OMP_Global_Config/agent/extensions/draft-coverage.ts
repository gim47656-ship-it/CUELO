import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { onSessionLifecycle } from "./lib/session-identity";
import { candidatesOf } from "./lib/slop-gate";
import { coverage, COVERED_RATIO, denyText, inScope, lettersOf, MIN_UNCOVERED_LETTERS, proseChanges, reminderText, shingles, uncoveredBlocks } from "./lib/draft-coverage";

/**
 * write·edit가 글 파일을 바꾸기 전에, draft를 거치지 않은 새 글 덩어리가 문단 이상 쌓이면 그 호출을 한 번 멈추고 빠진 덩어리를 보여 준다.
 * 판단 근거는 lib/draft-coverage.ts의 글자 4-gram 유사도이며 저자 증명이 아니다(Main 결정 2026-10-27: 쓰기 전 한정 개입, 출처 게이트 아님).
 * - draft 결과는 성공한 tool_result 순간의 내용을 고정해 담는다(나중에 draft 파일을 손으로 고쳐도 덮는 범위가 늘지 않는다).
 *   같은 프로세스의 다른 세션(Main·Maker)이 만든 결과는 이 세션이 그 경로를 read한 뒤에만 쓴다.
 * - 바뀌기 전 내용(기준선)은 사용자 입력마다 파일별로 처음 손댈 때 고정한다: 잘게 나눠 직접 더한 글이 기준선으로 씻기지 않는다.
 * - 같은 파일·같은 덩어리 묶음을 그대로 다시 보내면 통과시킨다(예외를 밝힌 경우의 복구 길). 통과는 덮음으로 기록하지 않는다.
 * - bash·eval이 바꾼 글 파일은 내용을 볼 수 없어 알림만 한다. docx·xlsx·pdf draft 결과와 그 밖의 도구가 쓴 글은 범위 밖이다.
 */

const MAX_DRAFTS = 64;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_FORMAT = /\.(?:md|markdown|txt|csv)$/i;

interface DraftSnapshot { path: string; owner: object; grams: Set<string> }
// 같은 프로세스의 세션(Main·in-process Maker)이 함께 보는 성공 draft 결과. 같은 경로에 다시 draft해도 앞 결과를 지우지 않는다.
// 오래된 것부터 지워 크기를 묶는다.
const drafts: DraftSnapshot[] = [];

function readText(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_TEXT_BYTES) return undefined;
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch { return undefined; }
}

const textOf = (content: unknown) => (Array.isArray(content)
  ? content.map((part: unknown) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("\n")
  : "");

export default function draftCoverage(pi: ExtensionAPI): void {
  // 세션이 바뀌면 소유 표지도 바꾼다: 앞 세션의 draft는 read해야만 쓸 수 있는 다른 세션의 결과가 된다.
  let owner = {};
  // 쫓겨난 스냅숏을 붙잡지 않도록 약한 참조로 둔다.
  let granted = new WeakSet<DraftSnapshot>();
  let baselines = new Map<string, Set<string>>();
  let pending = new Map<string, Map<string, string>>();
  let acknowledged = new Map<string, Set<string>>();
  let denied = new Set<string>();
  let reminded = new Set<string>();
  let started = new Map<string, number>();
  // 통과시킨 write·edit의 기록은 그 도구가 성공한 뒤에만 남긴다(실패한 시도는 더한 글이 아니다).
  let staged = new Map<string, (() => void)[]>();
  const resetInput = () => {
    baselines = new Map(); pending = new Map(); acknowledged = new Map(); denied = new Set(); reminded = new Set(); started = new Map(); staged = new Map();
  };
  const resetSession = () => { owner = {}; granted = new WeakSet(); resetInput(); };

  onSessionLifecycle(pi, { start: resetSession });
  pi.on("session_shutdown", resetSession);
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") resetInput();
  });

  pi.on("tool_call", (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    if (event.toolName === "bash" || event.toolName === "eval") { started.set(event.toolCallId, Date.now()); return; }
    const changes = proseChanges(event.toolName, input, ctx.cwd);
    if (changes.length === 0) return;
    const usable = drafts.filter((snap) => snap.owner === owner || granted.has(snap)).map((snap) => snap.grams);
    const reasons: string[] = [];
    const accepted: (() => void)[] = [];
    for (const change of changes) {
      let baseline = baselines.get(change.path);
      if (!baseline) {
        baseline = shingles(readText(change.path) ?? "");
        baselines.set(change.path, baseline);
      }
      const acked = acknowledged.get(change.path) ?? new Set<string>();
      const fresh = new Map<string, string>();
      for (const block of uncoveredBlocks(change.added, change.path, [baseline, ...usable])) {
        const key = [...shingles(block)].join("");
        if (!acked.has(key)) fresh.set(key, block);
      }
      // write는 파일 전체를 다시 쓰므로 그 파일의 쌓인 덩어리를 이번 내용으로 바꾸고, edit는 더한다. 쌓인 덩어리도 지금 쓸 수 있는 draft로 다시 본다.
      const sources = [baseline, ...usable];
      const before = event.toolName === "write" ? [] : [...pending.get(change.path) ?? []].filter(([, block]) => coverage(block, sources) < COVERED_RATIO);
      const candidate = new Map([...before, ...fresh]);
      const blocks = [...candidate.values()];
      const key = `${change.path}\n${[...candidate.keys()].sort().join("\n")}`;
      if (fresh.size > 0 && lettersOf(blocks) >= MIN_UNCOVERED_LETTERS && !denied.has(key)) {
        denied.add(key);
        reasons.push(denyText(change.path, blocks));
        continue;
      }
      // 성공한 뒤의 최신 상태에 합친다: 같은 파일의 호출이 겹쳐 끝나도 앞 호출이 더한 덩어리를 덮어쓰지 않는다.
      accepted.push(() => {
        const latest = pending.get(change.path) ?? new Map<string, string>();
        if (denied.has(key)) {
          // 같은 묶음을 그대로 다시 보냈다: 예외로 받아들인 덩어리는 다시 묻지 않는다. 덮음으로 기록하지는 않는다.
          const acks = acknowledged.get(change.path) ?? new Set<string>();
          for (const k of candidate.keys()) { acks.add(k); latest.delete(k); }
          acknowledged.set(change.path, acks);
          pending.set(change.path, latest);
        } else pending.set(change.path, event.toolName === "write" ? candidate : new Map([...latest, ...fresh]));
      });
    }
    if (reasons.length > 0) return { block: true, reason: reasons.join("\n\n") };
    if (accepted.length > 0) staged.set(event.toolCallId, accepted);
  });

  pi.on("tool_result", (event, ctx) => {
    const input = (event.input ?? {}) as Record<string, unknown>;
    if (event.toolName === "write" || event.toolName === "edit") {
      const apply = staged.get(event.toolCallId);
      staged.delete(event.toolCallId);
      if (!event.isError) for (const step of apply ?? []) step();
      return;
    }
    if (event.toolName === "draft") {
      if (event.isError || typeof input.output !== "string" || textOf(event.content).startsWith("model: none")) return;
      const path = resolve(ctx.cwd, input.output);
      if (!SNAPSHOT_FORMAT.test(path)) return;
      const text = readText(path);
      if (text === undefined) return;
      drafts.push({ path, owner, grams: shingles(text) });
      if (drafts.length > MAX_DRAFTS) drafts.splice(0, drafts.length - MAX_DRAFTS);
      return;
    }
    if (event.toolName === "read") {
      if (event.isError || typeof input.path !== "string") return;
      // read 경로 뒤의 줄 범위·:raw 선택자는 떼고 맞춘다. 이 세션이 실제로 연 draft 결과만 쓸 수 있게 된다.
      const bare = input.path.replace(/(?::(?:raw|conflicts|img|-?\d[\d+,:-]*(?::raw)?))+$/, "");
      const path = isAbsolute(bare) ? bare : resolve(ctx.cwd, bare);
      for (const snap of drafts) if (snap.path === path) granted.add(snap);
      return;
    }
    if (event.toolName !== "bash" && event.toolName !== "eval") return;
    const since = (started.get(event.toolCallId) ?? Date.now()) - 2_000;
    started.delete(event.toolCallId);
    const changed = candidatesOf(event.toolName, input, ctx.cwd).files.filter((path) => {
      if (!inScope(path, ctx.cwd) || reminded.has(path)) return false;
      try { return statSync(path).mtimeMs >= since; } catch { return false; }
    });
    if (changed.length === 0) return;
    for (const path of changed) reminded.add(path);
    pi.sendMessage({ customType: "draft-coverage", content: reminderText(changed), display: false, attribution: "agent" }, { deliverAs: "aside" });
  });
}
