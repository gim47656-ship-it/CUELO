"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { AssistantSnapshot } from "@/lib/routines/assistant";
import type { AssistantProposal } from "@/lib/routines/assistant-proposals";
import { type BoardData, type RoutineDraft, readApiError, refreshRoutineBoard, showRoutineScreen } from "./board-store";
import styles from "./RoutineView.module.css";

const actionLabels = { create: "생성", update: "수정", enable: "켜기", disable: "끄기", run: "지금 실행" };
const statusLabels = { pending: "", applying: "적용 중", applied: "적용됨", cancelled: "취소됨", failed: "적용 실패" };

/* Hallmark: component scope, existing CUELO tokens; no macrostructure or new theme. */
export function RoutineAssistant({ data, routineId, visible, formatSchedule }: {
  data: BoardData; routineId?: string; visible: boolean; formatSchedule: (draft: RoutineDraft) => string;
}) {
  const [snapshot, setSnapshot] = useState<AssistantSnapshot | null>(null);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [acted, setActed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const submitting = useRef(false);
  const history = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const refresh = useCallback(function refresh(afterMutation = false): Promise<void> {
    if (afterMutation && inflight.current) return inflight.current.then(() => refresh());
    inflight.current ??= (async () => {
      try {
        const response = await fetch("/api/routines/assistant", { cache: "no-store" });
        if (!response.ok) throw new Error(await readApiError(response));
        const next = await response.json() as AssistantSnapshot;
        if (mounted.current) { setSnapshot(next); setError(null); }
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
      finally { inflight.current = null; }
    })();
    return inflight.current;
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = setInterval(() => void refresh(), snapshot?.busy || sending ? 1000 : 10000);
    return () => clearInterval(timer);
  }, [visible, snapshot?.busy, sending, refresh]);
  const messages = expanded ? snapshot?.messages ?? [] : snapshot?.messages.slice(-4) ?? [];
  const busy = sending || !!snapshot?.busy || !!acting;
  const lastMessage = snapshot?.messages.at(-1);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [lastMessage?.id, lastMessage?.text, snapshot?.proposals.length, expanded]);
  const send = async () => {
    if (!text.trim() || busy || submitting.current) return;
    submitting.current = true;
    setSending(true); setError(null);
    try {
      const response = await fetch("/api/routines/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text.trim(), ...(routineId ? { routineId } : {}) }) });
      if (!response.ok) throw new Error(await readApiError(response));
      setText("");
      await refresh(true);
      input.current?.focus();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); submitting.current = false; }
  };
  const act = async (proposal: AssistantProposal, action: "apply" | "cancel") => {
    if (busy || submitting.current) return;
    submitting.current = true;
    setActing(proposal.id); setError(null); setActed((ids) => ids.includes(proposal.id) ? ids : [...ids, proposal.id]);
    let failure: string | null = null;
    try {
      const response = await fetch(`/api/routines/assistant/${encodeURIComponent(proposal.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error(await readApiError(response));
    } catch (e) { failure = e instanceof Error ? e.message : String(e); }
    finally {
      await refresh(true);
      await refreshRoutineBoard(true);
      setActing(null); submitting.current = false;
      if (failure) setError(failure);
    }
    return failure === null;
  };
  const proposalCard = (proposal: AssistantProposal) => {
    const current = proposal.input ?? proposal.before;
    if (!current) return null;
    return <article key={proposal.id} className={styles.assistantProposal} data-proposal-id={proposal.id} data-status={proposal.status} aria-label={`${actionLabels[proposal.action]}: ${current.name}`}>
      <header className={styles.assistantProposalHead}><strong>{actionLabels[proposal.action]}: {current.name}</strong><span>{statusLabels[proposal.status]}</span></header>
      {proposal.action === "update" && proposal.before ? <div className={styles.assistantComparison}>
        <div><span className={styles.hint}>이전</span><p>{proposal.before.name}</p><p>{formatSchedule(proposal.before)} / {proposal.before.host}</p><p>{proposal.before.enabled ? "켜짐" : "꺼짐"} / {proposal.before.cwd ?? "루틴 폴더"} / {proposal.before.model ?? "PC 모델 설정"}</p><details><summary>요청 내용</summary><p className={styles.assistantPrompt}>{proposal.before.prompt}</p></details></div>
        <div><span className={styles.hint}>변경 후</span><p>{current.name}</p><p>{formatSchedule(current)} / {current.host}</p><p>{current.enabled ? "켜짐" : "꺼짐"} / {current.cwd ?? "루틴 폴더"} / {current.model ?? "PC 모델 설정"}</p><details><summary>요청 내용</summary><p className={styles.assistantPrompt}>{current.prompt}</p></details></div>
      </div> : <><p className={styles.assistantMeta}>{proposal.oneOff ? "지금 실행" : formatSchedule(current)} / {current.host}</p>{proposal.action === "create" ? <><p className={styles.assistantMeta}>{proposal.oneOff || current.enabled ? "켜짐" : "꺼짐"} / {current.cwd ?? "루틴 폴더"} / {current.model ?? "PC 모델 설정"}</p><p className={styles.assistantPrompt}>{current.prompt}</p></> : null}</>}
      {proposal.action === "run" ? <p className={styles.hint}>{data.thisHost} PC에서 지금 실행합니다. 다른 PC 소유의 루틴이라도 현재 PC에서 실행됩니다.</p> : null}
      {proposal.action === "create" && proposal.oneOff && current.host !== data.thisHost ? <p className={styles.hint}>{current.host} PC가 켜져 있으면 동기화 후 약 10분 안에 시작됩니다.</p> : null}
      {proposal.action === "create" && proposal.oneOff && current.host === data.thisHost ? <p className={styles.hint}>적용하면 이 PC에서 지금 한 번 실행합니다.</p> : null}
      {proposal.result ? <p className={proposal.status === "failed" ? styles.error : styles.hint}>{proposal.result}</p> : null}
      <div className={styles.composerActions}>
        {proposal.routineId ? <button type="button" className={styles.button} onClick={() => showRoutineScreen({ kind: "board", id: proposal.routineId! })}>루틴 보기</button> : null}
        {proposal.status === "pending" ? <>
          {proposal.action === "create" && proposal.input ? <button type="button" className={styles.button} disabled={busy} onClick={async () => {
            if (await act(proposal, "cancel")) showRoutineScreen({ kind: "form", id: null, draft: proposal.input!, oneOff: proposal.oneOff });
          }}>폼으로 자세히</button> : null}
          <button type="button" className={styles.button} disabled={busy} onClick={() => void act(proposal, "cancel")}>취소</button>
          <button type="button" className={styles.button} data-variant="primary" disabled={busy} onClick={() => void act(proposal, "apply")}>{acting === proposal.id ? "적용하고 있습니다." : "적용"}</button>
        </> : null}
      </div>
    </article>;
  };
  const displayedTurns = new Set(messages.map((m) => m.turn));
  // A card acted on from an older, collapsed turn stays visible so its outcome and 「루틴 보기」 remain reachable.
  const orphaned = snapshot?.proposals.filter((p) => (p.status === "pending" || acted.includes(p.id)) && !displayedTurns.has(p.turn)) ?? [];
  return <section className={styles.assistant} aria-label="루틴 비서">
    <header className={styles.assistantHead}><h2>루틴 비서</h2>{snapshot?.messages.length ? <button type="button" className={styles.button} aria-expanded={expanded} aria-controls="routine-assistant-history" onClick={() => setExpanded(!expanded)}>{expanded ? "대화 접기" : "대화 펼치기"}</button> : null}</header>
    {snapshot?.newSession ? <p className={styles.hint} role="status">앞 대화를 이어 갈 수 없어 새 대화를 시작했습니다.</p> : null}
    {!snapshot?.messages.length && !busy ? <p className={styles.hint}>기존 루틴에 대해 물어보거나 새 루틴 생성이나 수정을 요청해 보세요. 변경 사항은 적용을 눌러야 반영됩니다.</p> : null}
    <div ref={history} id="routine-assistant-history" className={styles.assistantHistory} data-expanded={expanded} tabIndex={0} aria-label="루틴 비서 대화">
      {messages.map((message) => <div className={styles.assistantMessage} key={message.id} data-role={message.role}>
        <span className={styles.assistantSpeaker}>{message.role === "user" ? "나" : "루틴 비서"}</span>
        {message.role === "user" ? <p className={styles.assistantPrompt}>{message.text}</p> : <>
          {message.text ? <MarkdownBody>{message.text}</MarkdownBody> : null}
          {snapshot?.proposals.filter((p) => p.turn === message.turn).map(proposalCard)}
        </>}
      </div>)}
      {orphaned.map(proposalCard)}
    </div>
    <form className={styles.taskInput} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label htmlFor="routine-assistant-input">루틴 비서에게</label>
      <textarea ref={input} id="routine-assistant-input" rows={2} maxLength={8000} value={text} placeholder="매일 아침 8시에 환율 알려줘" aria-describedby="routine-assistant-feedback" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
      }} />
      <div className={styles.composerActions}><span className={styles.hint}>Enter로 보내기, Shift+Enter로 줄바꿈</span><button className={styles.button} data-variant="primary" type="submit" disabled={busy || !text.trim()}>보내기</button></div>
      <div id="routine-assistant-feedback" className={styles.assistantFeedback}>
        <span role="status">{busy ? acting ? "적용하고 있습니다." : "답변하고 있습니다." : ""}</span>
        {error || snapshot?.error ? <p className={styles.error} role="alert">{error ?? snapshot?.error}</p> : null}
      </div>
    </form>
  </section>;
}
