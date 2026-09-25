"use client";

import { useEffect, useMemo, useState } from "react";
import type { AssistantMessage, SubagentSnapshot, TextContent } from "@/lib/types";
import { createHanseSubagentClient } from "@/lib/hanse-subagent-client";
import type { HanseSubagentClient, SubagentArchiveRecord, SubagentArchiveResponse } from "@/lib/hanse-subagent-client";
import { CHARACTER_SUMMON_MARKER } from "@/lib/inline-utterance";
import type {
  CharacterSummonRequest,
  PeerSend,
  InlineUtterance,
  InlineUtteranceContext,
  InlineUtteranceSource,
  InlineUtteranceStatus,
  InlineUtteranceTurn,
} from "@/lib/inline-utterance";
import { useSubagentTranscripts, type SubagentTranscriptRead } from "./useSubagentTranscripts";

/** 자식 하나와, 그 자식의 발화가 붙을 턴. */
export interface AnchoredChild {
  snapshot: SubagentSnapshot;
  turnIndex: number;
  /** 이 자식을 부른 character-summon 요청. tasks[] 배치에서는 name으로 짝을 맞춘다. */
  summon?: CharacterSummonRequest;
  /**
   * 부모가 이 자식에게 보낸 `write agent://` send들, 턴 순서대로. 자식 기록의 `irc:incoming`과
   * 본문이 같은 send가 그 발화 구간의 턴을 정한다 — 발화는 처음 띄운 턴이 아니라
   * 그 말을 부른 요청이 있는 턴에 붙는다.
   */
  sends: readonly { turnIndex: number; send: PeerSend }[];
}

/** 이 출처의 이름. 화자 이름의 앞머리이자 등록 이름이다. */
const SUBAGENT_SOURCE_ID = "subagent";

/**
 * 디스크 기록 한 건을 스냅샷 모양으로 복원한다. 재시작 뒤에는 런타임 목록이 비어
 * `context.subagents`에 없는 자식도 archive 파일에는 남아 있으므로, summon 요청과
 * 이름이 맞는 기록만 스냅샷으로 세운다. status·model·errorMessage는 사이드카가
 * JSONL에서 읽은 실제 기록이고, 없으면(오래된 사이드카) completed로 둔다.
 */
export function archiveSnapshot(
  record: SubagentArchiveRecord,
  summon: CharacterSummonRequest,
  index: number,
): SubagentSnapshot {
  const status = record.status ?? "unknown";
  const snapshot: SubagentSnapshot = {
    id: record.name,
    index,
    agent: "",
    agentSource: "bundled",
    status,
    task: record.firstTask || undefined,
    lastUpdate: record.modified,
    parentToolCallId: summon.toolCallId,
  };
  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;
  const errorMessage = typeof record.errorMessage === "string" && record.errorMessage.trim()
    ? record.errorMessage.trim()
    : undefined;
  if (model !== undefined || errorMessage !== undefined) {
    snapshot.progress = {
      index,
      id: record.name,
      agent: "",
      status,
      task: record.firstTask,
      recentTools: [],
      recentOutput: [],
      toolCount: 0,
      requests: 0,
      tokens: 0,
      cost: 0,
      durationMs: 0,
      ...(model !== undefined
        ? { resolvedModel: model, resolvedModelIsFallback: record.modelIsFallback === true }
        : {}),
      ...(errorMessage !== undefined ? { retryFailure: { attempt: 0, errorMessage } } : {}),
    };
  }
  return snapshot;
}

/**
 * 세션의 디스크 기록 목록. 재시작 뒤에도 끝난 자식의 발화를 복원하는 근거다.
 * 세션마다 한 번만 읽는다 - 목록은 누적되기만 하므로 폴링하지 않는다.
 */
function useSubagentArchive(
  client: HanseSubagentClient,
  sessionId: string | undefined,
): SubagentArchiveResponse | null {
  const [archive, setArchive] = useState<SubagentArchiveResponse | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setArchive(null);
      return;
    }
    let disposed = false;
    const controller = new AbortController();
    setArchive(null);
    client.getArchive(sessionId, controller.signal)
      .then((result) => { if (!disposed) setArchive(result); })
      .catch(() => { /* 디스크 기록이 없거나 사이드카가 죽어 있으면 실시간 목록만으로 그린다. */ });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [client, sessionId]);
  return archive;
}

/**
 * 자식이 실제로 쓴 계정의 provider.
 *
 * 런타임이 기록한 모델 id 는 `provider/model` 꼴이라 앞머리가 곧 provider 다. 기록이 없으면
 * 캐릭터 호출이 요청한 provider로, 그래도 없으면 이 세션의 provider 로 물러난다 — 자식은 이
 * 세션의 credential 로 돈다. 그래도 모르면 얼굴을 그릴 근거가 없으므로 발화를 보내지 않는다.
 */
function childProvider(
  snapshot: SubagentSnapshot,
  summon: CharacterSummonRequest | undefined,
  sessionProvider: string | undefined,
): string | undefined {
  const recorded = typeof snapshot.progress?.resolvedModel === "string" ? snapshot.progress.resolvedModel.trim() : "";
  const slash = recorded.indexOf("/");
  if (slash > 0) return recorded.slice(0, slash);
  const requested = summon?.model.trim() ?? "";
  const requestedSlash = requested.indexOf("/");
  if (requestedSlash > 0) return requested.slice(0, requestedSlash);
  return sessionProvider?.trim() || undefined;
}
function utteranceStatus(status: SubagentSnapshot["status"]): InlineUtteranceStatus {
  // 기록이 끝난 자식의 발화는 최종이다 - completed와 마찬가지로 settled로 그린다.
  // 종료 근거가 없는 기록(unknown)도 발화 자체는 더 이상 변하지 않는다.
  if (status === "completed" || status === "unknown") return "settled";
  if (status === "failed" || status === "aborted") return "failed";
  return "streaming";
}

/**
 * 자식이 최종 보고를 싣는 도구 호출의 이름. 이 호출의 `input.data` 가 부모가 읽는 보고다.
 * 런타임은 `arguments`/`name` 으로 기록하고 `normalizeToolCalls` 가 `input`/`toolName` 으로 바꾼다.
 */
const YIELD_TOOL_NAME = "yield";

/**
 * `report` 가 없을 때 대사로 받는 필드. 캐릭터 호출 child는 보고 대신 대사를 이런 키로 싣고
 * 끝나기도 한다 — 그 대사를 버리면 이름표·얼굴·스티커까지 통째로 사라진다.
 */
const YIELD_SPEECH_KEYS = ["greeting", "utterance", "message", "text"] as const;

/**
 * `yield` 가 실어 온 보고 본문. `data` 가 문자열이면 그대로, 객체면 그 안의 `report` 다 —
 * 부모가 읽는 보고 본문이 바로 그 값이라(실측: 렌더된 자식의 text 블록과 `data.report` 가
 * 바이트까지 같다) 나머지 구조 필드는 대화창에 옮기지 않는다. `report` 가 비었으면
 * `YIELD_SPEECH_KEYS` 순서로 첫 문자열 대사를 쓴다. 둘 다 없으면 빈 문자열이다.
 */
function yieldReport(message: AssistantMessage): string {
  let report = "";
  for (const block of message.content ?? []) {
    if (block.type !== "toolCall" || block.toolName !== YIELD_TOOL_NAME) continue;
    const data = block.input.data;
    let text = "";
    if (typeof data === "string") {
      text = data;
    } else if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      for (const key of ["report", ...YIELD_SPEECH_KEYS]) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
          text = value;
          break;
        }
      }
    }
    const trimmed = text.trim();
    // 여러 번 실어 보냈다면 마지막 것이 자식의 최종 답이다.
    if (trimmed.length > 0) report = trimmed;
  }
  return report;
}

/**
 * 자식이 남긴 답변 텍스트. 텍스트 블록이 있으면 그것이 답이고, 없으면 `yield` 가 실어 온 보고
 * 본문이 답이다 — 보고만 남기고 끝난 자식도 대화창에서 자기 목소리를 가진다. 사고 과정과 다른
 * 도구 호출은 대화창의 몫이 아니다.
 */
function answerText(message: AssistantMessage): string {
  const text = (message.content ?? [])
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text.trim())
    .filter((value) => value.length > 0)
    .join("\n\n");
  return text.length > 0 ? text : yieldReport(message);
}

/**
 * 자식 기록의 `irc:incoming`이 가리키는 부모 send. 본문이 같고 발신자가 확정된 send를
 * 커서 이후 첫 occurrence로 짝을 맞춘다 — 같은 본문을 두 번내면 수신도 두 번이고
 * 순서가 같다. 발신자를 모르는(결과가 아직 없는) send나 실패한 send는 인과 근거가
 * 없으므로 건너뛰고, 어느 send와도 맞지 않는 수신은 직전 구간의 턴을 그대로 둔다.
 */
function sendReached(send: PeerSend, childId: string): boolean {
  if (!send.from) return false;
  const receipts = send.receipts;
  if (!receipts) return false;
  // SDK의 delivery outcome은 injected|woken|revived|failed 넷뿐이다 — 이 자식에게
  // 도달이 확인된 receipt만 인과 근거로 쓰고, 그 밖의 값은 성공으로 추정하지 않는다.
  return receipts.some((receipt) =>
    receipt.to === childId
    && (receipt.outcome === "injected" || receipt.outcome === "woken" || receipt.outcome === "revived"));
}

export function utterancesForChild(
  child: AnchoredChild,
  read: SubagentTranscriptRead | undefined,
  sessionProvider: string | undefined,
): InlineUtterance[] {
  const { snapshot, summon } = child;
  const status = utteranceStatus(snapshot.status);
  const failed = status === "failed";
  const requestedProvider = summon?.model.split("/", 1)[0]?.trim() || undefined;
  const provider = failed && requestedProvider ? requestedProvider : childProvider(snapshot, summon, sessionProvider);
  // spawn 이름이 곧 자식의 id 다(런타임이 따로 나르지 않는다). 없으면 별칭만 그린다.
  const label = snapshot.id.trim() || undefined;
  // 화자 이름은 출처 안에서만 유일하다. 다른 출처의 같은 이름과 섞이지 않게 앞에 밝힌다.
  const speakerId = `${SUBAGENT_SOURCE_ID}:${snapshot.id}`;
  const utterances: InlineUtterance[] = [];
  // 발화는 그 말을 부른 요청이 있는 턴에 붙는다. 처음엔 summon 턴이고, 자식 기록의
  // irc:incoming이 지나갈 때마다 그 수신과 짝이 되는 부모 send의 턴으로 옮긴다.
  let currentTurn = child.turnIndex;
  let sendCursor = 0;
  (read?.entries ?? []).forEach((entry, index) => {
    if ("irc" in entry) {
      const { from, message, truncated } = entry.irc;
      // 잘린 본문은 부모 send와 정확히 맞는지 알 수 없으므로 어느 send와도 잇지 않는다.
      if (truncated) return;
      // 발신자나 본문을 모르는 수신 경계는 어느 send와도 잇지 않고 직전 구간을 유지한다.
      if (typeof from !== "string" || typeof message !== "string") return;
      for (let i = sendCursor; i < child.sends.length; i += 1) {
        const candidate = child.sends[i];
        if (candidate.send.message !== message) continue;
        if (!sendReached(candidate.send, snapshot.id)) continue;
        if (candidate.send.from !== from) continue;
        currentTurn = candidate.turnIndex;
        sendCursor = i + 1;
        break;
      }
      return;
    }
    if (entry.message.role !== "assistant") return;
    const messageProvider = entry.message.provider || provider;
    if (!messageProvider) return;
    // 실패한 호출에서 다른 provider 가 남긴 텍스트는 요청한 캐릭터의 발화가 아니다.
    if (failed && requestedProvider && messageProvider !== requestedProvider) return;
    const text = answerText(entry.message) || (failed ? entry.message.errorMessage?.trim() ?? "" : "");
    if (text.length === 0) return;
    utterances.push({
      key: `${snapshot.id}:${index}`, turnIndex: currentTurn, speakerId, provider: messageProvider,
      credentialId: entry.message.credentialId, accountSessionId: null,
      label: failed && summon ? summon.alias : label, text, status,
    });
  });
  // 아직 아무 말도 하지 않은 자식도 화자다 — 자리를 비워 두면 자식이 도는지 알 수 없다.
  // 끝난 자식이 아무 말도 안 했다면 그 일은 작업 로그의 몫이라 대화창에 흔적을 남기지 않는다.
  // 다만 실패한 호출은 요청 대상과 실패 이유를 남겨야 사용자가 무엇이 끊겼는지 안다.
  if (utterances.length === 0 && status !== "settled" && provider) {
    const failureReason = failed ? snapshot.progress?.retryFailure?.errorMessage?.trim() : undefined;
    utterances.push({
      key: `${snapshot.id}:pending`, turnIndex: currentTurn, speakerId, provider, accountSessionId: null,
      label: failed && summon ? summon.alias : label,
      text: failureReason || "",
      status,
    });
  }
  return utterances;
}

/**
 * 명시적으로 캐릭터를 호출한 자식만 부모 대화의 턴에 연결한다.
 *
 * `parentToolCallId`는 자식과 호출을 잇고, `characterSummons`는 command guard가 brief에 넣은
 * 마커의 요청이다. 둘 중 하나라도 없으면 일반 작업 과정이다. 한 호출의 `tasks[]` 배치 안에서는
 * 항목 `name`이 자식 id와 같을 때만 그 요청을 자식에게 준다 — 호출 id만으로 첫 마커를 모든
 * 자식에게 적용하면 배치 안의 다른 캐릭터가 뒤바뀐다. 이름이 없는 요청은 자식 자신의
 * `snapshot.task`에 같은 마커가 있을 때만, 그마저 없으면 호출의 task 항목이 하나뿐일 때만
 * 배정한다 — 근거 없이 요청을 억지로 투영하지 않는다.
 */
export function anchorCharacterSummonChildren(
  turns: readonly InlineUtteranceTurn[],
  subagents: readonly SubagentSnapshot[],
): AnchoredChild[] {
  const summonsByToolCall = new Map<string, { turnIndex: number; requests: CharacterSummonRequest[] }>();
  for (const turn of turns) {
    for (const summon of turn.characterSummons) {
      const entry = summonsByToolCall.get(summon.toolCallId) ?? { turnIndex: turn.index, requests: [] };
      entry.requests.push(summon);
      summonsByToolCall.set(summon.toolCallId, entry);
    }
  }
  return subagents.flatMap((snapshot) => {
    const entry = snapshot.parentToolCallId ? summonsByToolCall.get(snapshot.parentToolCallId) : undefined;
    if (!entry) return [];
    const named = entry.requests.filter((request) => request.name);
    // 자식의 task 원문에 남은 마커가 두 번째 근거다 — 이름이 없는 배치 항목도 이것으로 가른다.
    const ownMarker = typeof snapshot.task === "string" ? CHARACTER_SUMMON_MARKER.exec(snapshot.task) : null;
    const ownAlias = ownMarker?.[1];
    const ownModel = ownMarker?.[2];
    const summon = named.find((request) => request.name === snapshot.id)
      ?? (ownAlias && ownModel
        ? entry.requests.find((request) => request.alias === ownAlias && request.model === ownModel)
        : undefined)
      ?? (entry.requests.length === 1 && entry.requests[0].batchSize === 1 ? entry.requests[0] : undefined);
    // 근거 없이는 요청을 배정하지 않는다 — 마커 없는 일반 child는 대화 본문에 오지 않는다.
    if (!summon) return [];
    // 이 자식에게 향한 send만 모은다. 직접 수신자이거나 "all" 방송이면 이 자식의 후보다.
    const sends = turns.flatMap((turn) =>
      turn.peerSends
        .filter((send) => send.to === snapshot.id || send.to === "all")
        .map((send) => ({ turnIndex: turn.index, send })));
    return [{ snapshot, turnIndex: entry.turnIndex, summon, sends }];
  });
}

/**
 * 캐릭터 호출 SubAgent 출처. 일반 maker·진단 child는 작업 과정에만 남고, command guard의
 * `[character-summon ...]` 마커를 가진 task child만 대화 본문에서 자기 목소리를 가진다.
 */
export function useSubagentUtterances(context: InlineUtteranceContext): readonly InlineUtterance[] {
  const client = useMemo(() => createHanseSubagentClient(), []);
  const archive = useSubagentArchive(client, context.sessionId);
  const children = useMemo<AnchoredChild[]>(() => {
    // 런타임 목록에 없는 자식은 디스크 기록으로 복원한다 - 재시작 뒤에도 끝난 자식의
    // 발화가 대화창에 남는다. summon 요청의 name과 기록 파일명이 맞는 건만 세우고,
    const liveIds = new Set(context.subagents.map((snapshot) => snapshot.id));
    const synthesized: SubagentSnapshot[] = [];
    // 이전 세션의 응답이 늦게 도착해 새 세션의 같은 이름 자식에 붙지 않게 세션을 확인한다.
    if (archive && archive.sessionId === context.sessionId) {
      const summons = context.turns.flatMap((turn) => turn.characterSummons);
      for (const record of archive.subagents) {
        if (liveIds.has(record.name)) continue;
        const summon = [...summons].reverse().find((request) => request.name === record.name);
        if (!summon) continue;
        synthesized.push(archiveSnapshot(record, summon, context.subagents.length + synthesized.length));
      }
    }
    return anchorCharacterSummonChildren(context.turns, [...context.subagents, ...synthesized]);
  }, [context.subagents, context.turns, archive]);

  const targets = useMemo(
    () => children.map(({ snapshot }) => {
      // 디스크 기록 이름은 JSONL 파일명이다 - sessionFile이 있으면 그 basename,
      // 없으면 자식 id가 곧 파일명이다. 실시간 읽기가 실패해도 발화를 복원할 수 있다.
      const archiveName = snapshot.sessionFile
        ?.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "") || snapshot.id;
      const live = context.subagents.some((entry) => entry.id === snapshot.id);
      return live
        ? { key: snapshot.id, liveId: snapshot.id, status: snapshot.status, archiveName }
        : { key: snapshot.id, status: snapshot.status, archiveName };
    }),
    [children, context.subagents],
  );

  const reads = useSubagentTranscripts(targets, {
    sessionId: context.sessionId ?? "",
    client,
    enabled: Boolean(context.sessionId) && targets.length > 0,
  });

  return useMemo(
    () => children.flatMap((child) => utterancesForChild(child, reads.get(child.snapshot.id), context.sessionProvider)),
    [children, reads, context.sessionProvider],
  );
}

export const subagentUtteranceSource: InlineUtteranceSource = {
  id: SUBAGENT_SOURCE_ID,
  use: useSubagentUtterances,
};
