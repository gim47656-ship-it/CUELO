"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  archiveTranscriptEntries,
  useSubagentTranscripts,
  type SubagentTranscriptRead,
  type SubagentTranscriptTarget,
} from "@/hooks/useSubagentTranscripts";
import { createHanseSubagentClient } from "@/lib/hanse-subagent-client";
import { OFFICE_MAIN_KEY, observeMakerAccount, type OfficeMakerAccount } from "@/lib/office/office-roster";
import { OFFICE_CAMERA_FIT, type OfficeCameraView } from "@/lib/office/office-camera";
import type { AgentMessage, SubagentSnapshot } from "@/lib/types";

/** 오피스 화면의 보기. `floor` 는 3D 공간이, `target` 은 고른 대상의 대화가 화면을 다 쓴다. */
export type OfficePane = "floor" | "target";

/**
 * Maker 기록 읽기 대상. 키에 세션을 넣는다 — 다른 세션에 같은 이름의 Maker 가 있어도 읽던 자리와
 * 이미 읽은 기록이 섞이지 않고, 세션을 바꾼 직후 남은 이전 세션의 읽기 결과는 새 키로 찾히지 않는다.
 */
export function officeAccountTargets(sessionId: string | null, subagents: readonly SubagentSnapshot[]): SubagentTranscriptTarget[] {
  if (!sessionId) return [];
  return subagents.map((snapshot) => ({ key: `${sessionId}\u0000${snapshot.id}`, liveId: snapshot.id, status: snapshot.status }));
}

function transcriptMessages(read: SubagentTranscriptRead): AgentMessage[] {
  const { state } = read;
  const entries = state.kind === "ready-live"
    ? state.entries
    : state.kind === "ready-archive"
      ? archiveTranscriptEntries(state.entries)
      : read.entries;
  return entries.flatMap((entry) => ("message" in entry ? [entry.message] : []));
}

/**
 * 이 세션의 Maker 마다 기록에서 본 계정 근거. 답(assistant 메시지)이 하나라도 있는 Maker 만 넣는다 —
 * 아직 답이 없으면 비워 두어 런타임이 기록한 모델 provider 만으로 자리를 정한다(`buildOfficeRoster`).
 */
export function officeMakerAccounts(
  sessionId: string | null,
  subagents: readonly SubagentSnapshot[],
  reads: ReadonlyMap<string, SubagentTranscriptRead>,
): ReadonlyMap<string, OfficeMakerAccount> {
  const accounts = new Map<string, OfficeMakerAccount>();
  if (!sessionId) return accounts;
  for (const snapshot of subagents) {
    const read = reads.get(`${sessionId}\u0000${snapshot.id}`);
    if (!read) continue;
    const messages = transcriptMessages(read);
    if (messages.some((message) => message.role === "assistant")) accounts.set(snapshot.id, observeMakerAccount(snapshot, messages));
  }
  return accounts;
}

/**
 * `/office` 화면의 상태. 늘 공간부터 보여 주고, 고른 대상은 보기만 바꿀 뿐 어디에도 보내지 않으며,
 * 입력은 언제나 Main 대화로 간다. 장면 확대·옮기기는 대화 보기에 다녀와도 그대로 남는다.
 *
 * `accounts` 는 오피스가 열려 있는 동안(`enabled`) 이 세션의 Maker 기록을 모두 읽어 본 계정 근거다.
 * 서브에이전트 패널과 같은 `useSubagentTranscripts` 로 읽으므로 이어 읽기·폴링·취소가 같고, 고른
 * Maker 의 기록을 열지 않아도 얼굴이 정해진다.
 */
export function useOfficeView(sessionId: string | null, { subagents, enabled }: { subagents: readonly SubagentSnapshot[]; enabled: boolean }) {
  const [selected, setSelected] = useState<string>(OFFICE_MAIN_KEY);
  const [pane, setPane] = useState<OfficePane>("floor");
  const [view, setView] = useState<OfficeCameraView>(OFFICE_CAMERA_FIT);

  useEffect(() => {
    setSelected(OFFICE_MAIN_KEY);
  }, [sessionId]);

  const select = useCallback((key: string) => {
    setSelected(key);
    setPane("target");
  }, []);

  const client = useMemo(() => createHanseSubagentClient(), []);
  const targets = useMemo(() => officeAccountTargets(sessionId, subagents), [sessionId, subagents]);
  const reads = useSubagentTranscripts(targets, {
    sessionId: sessionId ?? "",
    client,
    enabled: enabled && targets.length > 0,
  });
  const accounts = useMemo(() => officeMakerAccounts(sessionId, subagents, reads), [reads, sessionId, subagents]);

  return { selected, select, pane, setPane, accounts, view, setView };
}
