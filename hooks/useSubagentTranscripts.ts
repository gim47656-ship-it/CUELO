"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot } from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import {
  SubagentClientError,
  type HanseSubagentClient,
  type LiveSubagentTranscriptEntry,
  type SubagentArchiveTranscriptEntry,
} from "@/lib/hanse-subagent-client";

/** 자식 기록을 다시 읽는 간격. 목록이든 기록이든 같은 박자로 돈다. */
export const SUBAGENT_POLL_INTERVAL_MS = 3000;

/** 디스크 기록에서 한 번에 읽는 최대 항목 수. */
const ARCHIVE_LIMIT = 400;

/** 실시간 기록에서 화면이 쓰는 조각. 도구 호출 표기를 정규화해 둔 메시지 하나. */
export interface LiveTranscriptMessageView {
  id: string;
  message: AgentMessage;
}

/**
 * 부모가 이 자식에게 보낸 메시지가 자식 기록에 도착한 경계. `details.from`/`details.message`
 * 만 남긴다 — 발화를 어느 요청 턴에 붙일지 가르는 인과 근거이지 화면에 그릴 말이 아니다.
 */
export interface LiveTranscriptIrcView {
  id: string;
  /** `truncated`가 true면 본문이 잘린 기록이다 - 부모 send와 본문 매칭에 쓰지 않는다. */
  irc: { from?: string; message?: string; truncated?: boolean };
}

export type LiveTranscriptView = LiveTranscriptMessageView | LiveTranscriptIrcView;

export type SubagentTranscriptState =
  | { kind: "loading" }
  | { kind: "ready-live"; entries: LiveTranscriptView[] }
  | { kind: "ready-archive"; entries: SubagentArchiveTranscriptEntry[]; truncated: boolean; note?: string }
  | { kind: "empty"; source: "live" | "archive"; note?: string }
  | { kind: "unreachable"; message: string }
  | { kind: "error"; message: string };

/** 자식이 아직 도는 중인가. 도는 동안에만 폴링한다. */
export function isActiveSubagentStatus(status: SubagentSnapshot["status"] | undefined): boolean {
  return status === "pending" || status === "running";
}

/**
 * 기록을 읽을 자식 하나. 자식이 여럿이면 대상도 여럿이다 — 자식이 늘고 줄 때마다 훅을
 * 새로 부를 수는 없으므로, 이 훅 하나가 대상 전부를 맡는다.
 */
export interface SubagentTranscriptTarget {
  /** 구독을 가리키는 키. 같은 자식은 늘 같은 키를 쓴다. */
  key: string;
  /** 실시간 기록을 읽을 자식 id. 없으면 디스크 기록만 본다. */
  liveId?: string;
  /** 자식의 상태. 바뀌면 그 자식의 기록을 처음부터 다시 읽는다. */
  status?: SubagentSnapshot["status"];
  /** 실시간 기록을 못 읽었을 때 대신 볼 디스크 기록 이름. 없으면 대신 볼 것이 없다. */
  archiveName?: string;
}

export interface SubagentTranscriptOptions {
  sessionId: string;
  client: HanseSubagentClient;
  /** false 면 아무것도 읽지 않는다(패널이 닫혀 있거나 자식이 없을 때). */
  enabled: boolean;
}

/** 대상 하나의 읽기 결과. */
export interface SubagentTranscriptRead {
  state: SubagentTranscriptState;
  /**
   * 지금까지 읽은 실시간 기록. 상태가 실패로 바뀌어도 마지막으로 읽은 값이 남는다 —
   * 이미 읽어 온 답이 폴링 한 번 실패했다고 사라지면 안 된다.
   */
  entries: readonly LiveTranscriptView[];
}

/** 대상 하나가 읽던 자리. 구독을 다시 세워도 이어 가려면 effect 밖에 있어야 한다. */
interface TargetRuntime {
  /** 이 실행의 서명. 달라지면 읽던 자리를 버리고 처음부터 다시 읽는다. */
  signature: string;
  nextByte: number;
  collected: LiveTranscriptView[];
  state: SubagentTranscriptState;
}

const EMPTY_READS: ReadonlyMap<string, SubagentTranscriptRead> = new Map();

function targetSignature(target: SubagentTranscriptTarget): string {
  return `${target.liveId ?? ""}|${target.status ?? ""}|${target.archiveName ?? ""}`;
}
function liveTranscriptEntries(entries: readonly LiveSubagentTranscriptEntry[], fromByte: number): LiveTranscriptView[] {
  return entries.flatMap((entry, index): LiveTranscriptView[] => {
    const id = entry.id ?? `${fromByte}:${index}`;
    if (entry.type === "message" && entry.message) {
      return [{ id, message: normalizeToolCalls(entry.message) }];
    }
    // 부모→자식 send가 자식 기록에 도착한 경계다. 발화를 어느 요청 턴에 붙일지 가르는
    // 인과 근거이므로 본문과 발신자만 남기고 나머지 custom 기록은 버린다.
    if (entry.type === "custom_message" && entry.customType === "irc:incoming") {
      const details = entry.details;
      if (!details || typeof details !== "object" || Array.isArray(details)) return [];
      const record = details as Record<string, unknown>;
      return [{
        id,
        irc: {
          from: typeof record.from === "string" ? record.from : undefined,
          message: typeof record.message === "string" ? record.message : undefined,
        },
      }];
    }
    return [];
  });
}
/**
 * 디스크 기록 한 줄을 실시간 기록과 같은 모양으로 옮긴다. 사이드카가 assistant 본문과
 * `irc:incoming`의 발신자·본문을 따로 실어내므로 발화 복원은 text 자리표시자가 아니라
 * 그 필드를 읽는다. id는 파일 안의 순서로 만든다 - 디스크 기록에는 레코드 id가 없다.
 */
export function archiveTranscriptEntries(entries: readonly SubagentArchiveTranscriptEntry[]): LiveTranscriptView[] {
  return entries.flatMap((entry, index): LiveTranscriptView[] => {
    const id = `archive:${index}`;
    if (entry.message && entry.message.role === "assistant") {
      return [{ id, message: entry.message }];
    }
    if (entry.irc) {
      return [{ id, irc: { from: entry.irc.from || undefined, message: entry.irc.message || undefined, truncated: entry.irc.truncated === true } }];
    }
    return [];
  });
}


/** 자식 기록 읽기가 실패한 까닭. 못 닿은 것과 그 밖의 오류를 나눈다. */
export function transcriptError(error: unknown): { kind: "unreachable" | "error"; message: string } {
  if (error instanceof SubagentClientError
    && (error.kind === "live-unreachable" || error.kind === "sidecar-unreachable")) {
    return { kind: "unreachable", message: error.message };
  }
  return { kind: "error", message: error instanceof Error ? error.message : String(error) };
}

/**
 * 자식의 대화 기록을 읽어 온다 — 실시간 기록을 `fromByte` 부터 이어 읽고, 자식이 도는
 * 동안 되풀이해서 읽는다. 자식이 멈추면 마지막으로 한 번 더 읽고 그친다.
 *
 * 대상마다 자기 자리(바이트 커서)와 자기 상태를 갖는다. 자식 하나가 늘거나 줄어도 나머지
 * 자식은 읽던 자리를 이어 가므로, 이미 지나간 발화가 다시 흐르지 않는다.
 */
export function useSubagentTranscripts(
  targets: readonly SubagentTranscriptTarget[],
  { sessionId, client, enabled }: SubagentTranscriptOptions,
): ReadonlyMap<string, SubagentTranscriptRead> {
  const [reads, setReads] = useState<ReadonlyMap<string, SubagentTranscriptRead>>(EMPTY_READS);
  const runtimesRef = useRef(new Map<string, TargetRuntime>());
  // effect 는 서명이 바뀔 때만 다시 서고, 그 안에서는 이번 렌더의 대상을 본다.
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const publish = useCallback(() => {
    const runtimes = runtimesRef.current;
    setReads((previous) => {
      let changed = false;
      const next = new Map<string, SubagentTranscriptRead>();
      for (const [key, runtime] of runtimes) {
        const prior = previous.get(key);
        const read = prior && prior.entries === runtime.collected && prior.state === runtime.state
          ? prior
          : { state: runtime.state, entries: runtime.collected };
        if (read !== prior) changed = true;
        next.set(key, read);
      }
      if (next.size !== previous.size) changed = true;
      return changed ? next : previous;
    });
  }, []);

  // 서명은 값이다. 대상 배열의 정체성이 아니라 내용이 바뀔 때만 구독을 다시 세운다.
  const signature = targets.map((target) => `${target.key}|${targetSignature(target)}`).join("\n");

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    const runtimes = runtimesRef.current;

    // 이번 구독이 다루지 않는 자식은 버린다.
    const keys = new Set(targetsRef.current.map((target) => target.key));
    for (const key of [...runtimes.keys()]) {
      if (!keys.has(key)) runtimes.delete(key);
    }
    // 서명이 달라진 자식만 읽던 자리를 버리고 처음부터 다시 읽는다.
    for (const target of targetsRef.current) {
      const next = targetSignature(target);
      if (runtimes.get(target.key)?.signature === next) continue;
      runtimes.set(target.key, { signature: next, nextByte: 0, collected: [], state: { kind: "loading" } });
    }
    publish();

    const readArchive = async (
      target: SubagentTranscriptTarget,
      runtime: TargetRuntime,
      signal: AbortSignal,
      note?: string,
    ) => {
      if (!target.archiveName) {
        runtime.state = { kind: "empty", source: "live", note };
        return;
      }
      try {
        const archived = await client.getArchiveTranscript(sessionId, target.archiveName, ARCHIVE_LIMIT, signal);
        if (disposed) return;
        // 실시간 기록이 하나도 모이지 않았을 때만 디스크 기록으로 채운다 - 이미 읽은
        // 실시간 항목을 덮어쓰지 않는다. 디스크만 보는 자식(재시작 뒤 복원)은 이 경로다.
        if (runtime.collected.length === 0) {
          runtime.collected = archiveTranscriptEntries(archived.entries);
        }
        runtime.state = archived.entries.length === 0
          ? { kind: "empty", source: "archive", note }
          : { kind: "ready-archive", entries: archived.entries, truncated: archived.truncated, note };
      } catch (error) {
        if (disposed || signal.aborted) return;
        const failure = transcriptError(error);
        runtime.state = failure.kind === "unreachable"
          ? { kind: "unreachable", message: failure.message }
          : { kind: "error", message: failure.message };
      }
    };

    const loadTarget = async (target: SubagentTranscriptTarget, signal: AbortSignal) => {
      const runtime = runtimes.get(target.key);
      if (!runtime) return;
      if (!target.liveId) {
        await readArchive(target, runtime, signal);
        return;
      }
      try {
        const result = await client.getLiveTranscript(sessionId, target.liveId, runtime.nextByte, signal);
        if (disposed) return;
        const chunk = liveTranscriptEntries(result.entries, result.fromByte);
        if (result.reset || result.fromByte === 0) runtime.collected = chunk;
        else if (chunk.length > 0) runtime.collected = [...runtime.collected, ...chunk];
        runtime.nextByte = result.nextByte;
        if (runtime.collected.length > 0) {
          if (runtime.state.kind !== "ready-live" || runtime.state.entries !== runtime.collected) {
            runtime.state = { kind: "ready-live", entries: runtime.collected };
          }
        } else {
          await readArchive(target, runtime, signal);
        }
      } catch (error) {
        if (disposed || signal.aborted) return;
        if (target.archiveName) {
          const failure = transcriptError(error);
          await readArchive(target, runtime, signal, `실시간 기록을 읽지 못해 디스크 기록을 표시합니다: ${failure.message}`);
        } else {
          const failure = transcriptError(error);
          runtime.state = failure.kind === "unreachable"
            ? { kind: "unreachable", message: failure.message }
            : { kind: "error", message: failure.message };
        }
      }
    };

    const load = async () => {
      if (disposed || inFlight || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
      inFlight = true;
      const active = new AbortController();
      controller = active;
      try {
        for (const target of targetsRef.current) await loadTarget(target, active.signal);
      } finally {
        inFlight = false;
      }
      if (!disposed) publish();
    };

    void load();
    const timer = targetsRef.current.some((target) => isActiveSubagentStatus(target.status))
      ? setInterval(() => void load(), SUBAGENT_POLL_INTERVAL_MS)
      : undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, enabled, publish, sessionId, signature]);

  return reads;
}
